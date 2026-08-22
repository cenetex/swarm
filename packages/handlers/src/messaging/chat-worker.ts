/**
 * Chat Worker Handler
 *
 * Async Lambda that handles the tool-call loop for messages that require
 * tool execution. The message-processor delegates here when the first LLM
 * call returns tool_calls, avoiding timeout pressure on the synchronous path.
 *
 * Flow: Message Processor → Chat Worker Queue → this handler → Response Queue
 */
import type { MessageBatch, ExecutionContext } from "@swarm/core";
import { DEFAULT_AVATAR_CONFIG } from '@swarm/core';
import {
  createStateService,
  createSecretsService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  createGallerySaver,
  createRuntimeMetricsLogger,
  logger,
  CORRELATION_ID_ATTR,
  type AvatarConfig,
  type ResponseTrigger,
  type SwarmEnvelope,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createPlatformMCPServices } from '../services/platform-mcp-adapter.js';
import { parseSqsRecordBody, cleanupSqsRecord, sendSqsMessage } from '../services/sqs-send.js';
import { ensureReplicateKey } from '../utils/system-replicate-key.js';
import { ensureOpenRouterKey } from '../utils/system-openrouter-key.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { createRuntimeBrainService } from '../services/brain.js';
import { executeToolLoop, buildResponseFromToolLoop, type ToolLoopResult } from './tool-loop.js';
import type { LLMMessage } from './llm-client.js';
import { createTypingSender } from './typing-indicator.js';
import { reserveResponseInChannelHistory } from './response-history.js';

// ─── SQS Message Schema ─────────────────────────────────────────────────────

export interface ChatWorkerMessage {
  envelope: SwarmEnvelope;
  avatarId: string;
  /** LLM messages accumulated so far (system + history + user + first assistant with tool_calls) */
  messages: LLMMessage[];
  /** First LLM response's tool calls to execute */
  pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Tool definitions in OpenAI function format */
  enabledTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  traceId: string;
  correlationId: string;
  processingStartedAt: number;
  toolResultCount: number;
  /** Cooldown config from avatar behavior */
  cooldownMinutes?: number;
  responseTrigger?: ResponseTrigger;
  sharedRoomId?: string;
}

// ─── Environment & Services ──────────────────────────────────────────────────

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

let _responseQueueUrl: string | undefined;
function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(getRequiredEnv('STATE_TABLE'));
  secretsService = createSecretsService();
}

// ─── Avatar Runtime Cache (same pattern as message-processor) ────────────────

type AvatarRuntime = {
  avatarId: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  registry: ToolRegistry;
};

const AVATAR_RUNTIME_CACHE_TTL_MS = parsePositiveInt(process.env.AVATAR_RUNTIME_CACHE_TTL_MS, 5 * 60 * 1000);
const avatarRuntimeCache = new Map<string, { value: AvatarRuntime; expiresAt: number }>();

async function getAvatarRuntime(avatarId: string): Promise<AvatarRuntime> {
  const now = Date.now();
  const cached = avatarRuntimeCache.get(avatarId);
  if (cached && cached.expiresAt > now) {
    avatarRuntimeCache.delete(avatarId);
    avatarRuntimeCache.set(avatarId, cached);
    return cached.value;
  }

  const avatarConfig = await stateService.getAvatarConfig(avatarId) || {
    ...DEFAULT_AVATAR_CONFIG,
    id: avatarId,
    name: process.env.AVATAR_NAME || avatarId,
    persona: process.env.AGENT_PERSONA || DEFAULT_AVATAR_CONFIG.persona,
    llm: {
      ...DEFAULT_AVATAR_CONFIG.llm,
      provider: (process.env.LLM_PROVIDER as 'openrouter') || DEFAULT_AVATAR_CONFIG.llm.provider,
      model: process.env.LLM_MODEL || DEFAULT_AVATAR_CONFIG.llm.model,
    },
    tools: [...DEFAULT_AVATAR_CONFIG.tools],
    secrets: [...DEFAULT_AVATAR_CONFIG.secrets],
  };

  const secrets = await loadAvatarSecrets(secretsService, avatarId);
  try {
    await ensureOpenRouterKey(secrets, secretsService);
  } catch (err) {
    logger.warn('Failed to load system OpenRouter key', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await ensureReplicateKey(secrets, secretsService);
  } catch (err) {
    logger.warn('Failed to load system Replicate key', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const mediaBucket = process.env.MEDIA_BUCKET || '';
  const cdnUrl = process.env.CDN_URL || '';
  const mediaDeps = createMediaDependencies({ tableName: getRequiredEnv('STATE_TABLE') });
  const adminTable = process.env.ADMIN_TABLE;
  if (adminTable) {
    mediaDeps.saveToGallery = createGallerySaver({ tableName: adminTable });
  }
  const mediaService = mediaBucket
    ? createMediaServiceWithDeps(secrets, mediaBucket, cdnUrl, mediaDeps)
    : undefined;

  const mcpServices = createPlatformMCPServices({
    avatarId,
    avatarConfig,
    stateService,
    mediaService,
    secrets,
    mediaBucket,
    cdnUrl,
    adminTable,
  });

  const registry = new ToolRegistry();
  registerAllTools(registry, mcpServices);

  const runtime: AvatarRuntime = { avatarId, avatarConfig, secrets, registry };
  avatarRuntimeCache.set(avatarId, { value: runtime, expiresAt: now + AVATAR_RUNTIME_CACHE_TTL_MS });
  return runtime;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handler = async (event: MessageBatch, context: ExecutionContext): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  logger.setContext({
    avatarId: 'chat-worker',
    requestId: context.awsRequestId,
  });

  await initialize();

  const metrics = createRuntimeMetricsLogger('ChatWorker');
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const recordStartTime = Date.now();
    let wasOffloaded = false;
    let rawBody = record.body;

    try {
      // Parse SQS record (with S3 offload support)
      let parsedBody: unknown;
      try {
        const parsed = await parseSqsRecordBody(record.body);
        parsedBody = parsed.payload;
        rawBody = parsed.rawBody;
        wasOffloaded = parsed.wasOffloaded;
      } catch (parseError) {
        logger.error('Failed to parse chat worker message', {
          messageId: record.messageId,
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const item = parsedBody as ChatWorkerMessage;
      const { envelope, avatarId, messages, pendingToolCalls, enabledTools, traceId, correlationId } = item;

      logger.setContext({
        avatarId,
        messageId: envelope.messageId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
        correlationId,
        traceId,
      });

      logger.info('Chat worker processing tool calls', {
        event: 'chat_worker_started',
        subsystem: 'chat-worker',
        pendingToolCount: pendingToolCalls.length,
        toolNames: pendingToolCalls.map(tc => tc.name),
        messageCount: messages.length,
      });

      // Reconstitute avatar runtime
      const avatarRuntime = await getAvatarRuntime(avatarId);
      const toolClient = createToolClient(avatarRuntime.registry, envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api');
      const toolContext: ToolContext = {
        avatarId,
        platform: envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api',
        userId: envelope.sender.id,
        conversationId: envelope.conversationId,
        replyToMessageId: envelope.messageId,
        ...(envelope.platform === 'discord'
          ? {
              discord: {
                guildId: envelope.metadata.guildId,
                channelId: envelope.conversationId,
                messageId: envelope.messageId,
              },
            }
          : {}),
      };

      // Set up typing indicator
      const refreshTyping = createTypingSender(
        envelope.platform,
        avatarRuntime.secrets,
        envelope.conversationId,
      );

      // Start typing interval (refresh every 4s during processing)
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      if (refreshTyping) {
        await refreshTyping();
        typingInterval = setInterval(() => { refreshTyping().catch(() => {}); }, 4000);
      }

      try {
        // The messages array already contains the assistant message with tool_calls
        // from the first LLM response. We need to execute those tool calls first,
        // then continue the loop.

        // Execute the pending tool calls from the first LLM response
        const brainService = createRuntimeBrainService(stateService, avatarRuntime.avatarConfig.brain);

        // Execute pending tool calls inline, then run the rest of the tool loop
        const preExecutedToolResults: ToolLoopResult['allToolResults'] = [];
        for (const toolCall of pendingToolCalls) {
          logger.info('Executing tool (from initial LLM call)', { tool: toolCall.name });
          const result = await toolClient.execute(toolCall.name, toolCall.arguments, toolContext);
          preExecutedToolResults.push({ name: toolCall.name, result });

          // Check if this is a manual tool (pause tool) with ui action - wrap it with tool call id
          const toolResultContent = (() => {
            if (result.success && result.uiAction) {
              // Include tool call ID in the ui action so it can be tracked by admin-ui
              return JSON.stringify({
                data: result.data,
                uiAction: result.uiAction,
                toolCallId: toolCall.id,
                media: result.media,
              });
            }
            return JSON.stringify(result.success
              ? { data: result.data, media: result.media, pendingJob: result.pendingJob }
              : { error: result.error });
          })();

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResultContent,
          });

          if (result.success && result.media?.type === 'image' && result.media.url) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Here is the image you just generated. Please look at it and respond.' },
                { type: 'image_url', image_url: { url: result.media.url } },
              ],
            });
          }

          logger.info('Tool result', { tool: toolCall.name, success: result.success, hasUiAction: !!result.uiAction });
        }

        // Now run the remaining tool loop iterations (the LLM may request more tools)
        const toolLoopResult = await executeToolLoop({
          messages,
          enabledTools,
          toolClient,
          toolContext,
          avatarId,
          avatarName: avatarRuntime.avatarConfig.name,
          llmConfig: avatarRuntime.avatarConfig.llm,
          secrets: avatarRuntime.secrets,
          envelope,
          brainService,
          refreshTyping,
          preExecutedToolResults,
          initialToolResultCount: item.toolResultCount,
          startIteration: 1, // Already did iteration 0 (first LLM call) in message-processor
        });

        // Build response
        const { response } = buildResponseFromToolLoop(
          envelope,
          toolLoopResult,
          avatarRuntime.avatarConfig.llm.model,
        );
        response.responseTrigger = item.responseTrigger;

        try {
          const contextMessageId = await reserveResponseInChannelHistory({
            stateService,
            envelope,
            response,
            avatarName: avatarRuntime.avatarConfig.name,
            sharedRoom: item.sharedRoomId ? { roomId: item.sharedRoomId } : undefined,
          });
          if (contextMessageId) {
            logger.info('Reserved chat worker response in channel history', {
              event: 'response_context_reserved',
              subsystem: 'state',
              contextMessageId,
            });
          }
        } catch (error) {
          logger.warn('Failed to reserve chat worker response in channel history', {
            event: 'response_context_reservation_failed',
            subsystem: 'state',
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Enqueue response for sending
        await sendSqsMessage({
          QueueUrl: getResponseQueueUrl(),
          MessageAttributes: {
            traceId: { DataType: 'String', StringValue: traceId },
            [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
          },
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: `resp_${avatarId}_${envelope.conversationId}_${envelope.messageId}`,
        }, response);

        logger.info('Chat worker response enqueued', {
          event: 'chat_worker_complete',
          subsystem: 'chat-worker',
          actions: response.actions.length,
          tokensUsed: response.tokensUsed,
        });

        // #1554 — canonical "response_generated" lifecycle event, distinct
        // from "response_accepted_by_platform" (response-sender) and the
        // eventual activity-table `response_sent` alias. Fires when the
        // LLM produced a reply and it's been enqueued to the response
        // queue — NOT when a user actually saw it.
        logger.info('response_generated', {
          event: 'response_generated',
          subsystem: 'chat-worker',
          avatarId,
          platform: envelope.platform,
          conversationId: envelope.conversationId,
          actionCount: response.actions.length,
          actionTypes: response.actions.map(a => a.type),
          tokensUsed: response.tokensUsed,
        });

        // Post-response state: cooldown
        if (item.cooldownMinutes && item.cooldownMinutes > 0) {
          await stateService.setUserCooldown({
            avatarId,
            platform: envelope.platform,
            userId: envelope.sender.id,
            cooldownUntil: Date.now() + (item.cooldownMinutes * 60 * 1000),
          });
        }

        metrics.trackDuration('ProcessingLatency', recordStartTime);
        metrics.incrementCounter('ToolLoopsProcessed');
        metrics.incrementCounter('ResponsesGenerated');
        metrics.setProperty('Outcome', 'success');

      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }

      // Clean up offloaded S3 payload
      if (wasOffloaded) {
        await cleanupSqsRecord(rawBody);
      }

    } catch (error) {
      metrics.trackDuration('ProcessingLatency', recordStartTime);
      metrics.incrementCounter('ProcessingErrors');
      metrics.setProperty('Outcome', 'error');

      logger.error('Chat worker failed', error, {
        event: 'chat_worker_error',
        subsystem: 'chat-worker',
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  if (batchItemFailures.length > 0) {
    logger.warn('Chat worker partial batch failure', {
      event: 'batch_partial_failure',
      subsystem: 'chat-worker',
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length,
    });
  }

  metrics.flush();
  return { batchItemFailures };
};
