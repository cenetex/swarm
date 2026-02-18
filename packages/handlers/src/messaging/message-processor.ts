/**
 * Message Processor Handler
 * Processes messages from SQS and generates responses using MCP tools
 *
 * Kyro-style channel-aware processing:
 * - Buffers messages per channel
 * - Evaluates response triggers (direct engagement, threshold, gap)
 * - State machine: IDLE → ACTIVE → COOLDOWN
 *
 * MCP Tool Integration:
 * - Uses unified tool registry from @swarm/mcp-server
 * - Supports iterative tool execution (multi-step reasoning)
 * - Memory tools wired to state service
 */
import type { SQSEvent, Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DEFAULT_AVATAR_CONFIG } from '@swarm/core';
import {
  createStateService,
  createSecretsService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  createPresenceService,
  logger,
  MessageQueueItemSchema,
  extractThinking,
  CORRELATION_ID_ATTR,
  extractCorrelationIdFromSqsRecord,
  type AvatarConfig,
  type ContextMessage,
  type SwarmEnvelope,
  type SwarmResponse,
  type ResponseAction,
  type PresenceService,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createPlatformMCPServices } from '../services/platform-mcp-adapter.js';
import { parseSqsRecordBody, cleanupSqsRecord, sendSqsMessage } from '../services/sqs-send.js';
import {
  checkAndIncrementMessageUsage,
  checkToolCallLimit,
  isMemoryWriteAllowed,
} from '../services/entitlement-enforcement.js';
import { ensureReplicateKey } from '../utils/system-replicate-key.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { createRuntimeBrainService } from '../services/brain.js';

// Extracted modules
import { callLLM, stripAvatarNamePrefix, type LLMMessage } from './llm-client.js';
import { toolResultsToActions, maybeTranscribeAudio } from './tool-executor.js';
import { buildSystemPrompt, formatBrainMemoryContext } from './context-builder.js';
import { extractMediaContext, buildUserMessageContent, type MediaExtractionConfig } from './media-extractor.js';

const MAX_TOOL_ITERATIONS = 5;
const REPLY_CONTEXT_MAX_LENGTH = 200;

/**
 * Build a reply-to annotation for a message that references another message via replyToMessageId.
 *
 * If the referenced message is already visible in the LLM context window, returns undefined
 * (no annotation needed — the LLM can see it). Otherwise, searches the full channel history
 * (up to 50 messages from DynamoDB) and returns a short annotation string.
 *
 * @param replyToMessageId  The messageId being replied to
 * @param contextWindow     The messages currently visible to the LLM
 * @param fullHistory       The full channel history buffer (up to 50 messages)
 * @returns An annotation string like `[Replying to Alice: "truncated content..."]`, or undefined
 */
export function buildReplyAnnotation(
  replyToMessageId: string | undefined,
  contextWindow: ContextMessage[],
  fullHistory: ContextMessage[],
): string | undefined {
  if (!replyToMessageId) return undefined;

  // Check if the referenced message is already in the context window
  const inWindow = contextWindow.some(m => m.messageId === replyToMessageId);
  if (inWindow) return undefined;

  // Search the full history for the referenced message
  const referenced = fullHistory.find(m => m.messageId === replyToMessageId);
  if (!referenced) return undefined;

  const truncatedContent = referenced.content.length > REPLY_CONTEXT_MAX_LENGTH
    ? referenced.content.slice(0, REPLY_CONTEXT_MAX_LENGTH) + '...'
    : referenced.content;

  return `[Replying to ${referenced.sender}: "${truncatedContent}"]`;
}

// Environment variable validation helper
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

// Environment variables - validated on first use
let _responseQueueUrl: string | undefined;
let _stateTable: string | undefined;
let _mediaBucket: string | undefined;
let _cdnUrl: string | undefined;
let _secretPrefix: string | undefined;

function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('STATE_TABLE');
  return _stateTable;
}

function getMediaBucket(): string | undefined {
  if (_mediaBucket === undefined) _mediaBucket = process.env.MEDIA_BUCKET || '';
  return _mediaBucket || undefined;
}

function getCdnUrl(): string | undefined {
  if (_cdnUrl === undefined) _cdnUrl = process.env.CDN_URL || '';
  return _cdnUrl || undefined;
}

function getSecretPrefix(): string {
  if (_secretPrefix === undefined) _secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  return _secretPrefix;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Services (lazy initialized)
let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let presenceService: PresenceService;
type AvatarRuntime = {
  avatarId: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  registry: ToolRegistry;
};
type AvatarRuntimeCacheEntry = {
  value: AvatarRuntime;
  expiresAt: number;
};

const AVATAR_RUNTIME_CACHE_TTL_MS = parsePositiveInt(process.env.AVATAR_RUNTIME_CACHE_TTL_MS, 5 * 60 * 1000);
const AVATAR_RUNTIME_CACHE_MAX_SIZE = parsePositiveInt(process.env.AVATAR_RUNTIME_CACHE_MAX_SIZE, 200);
const AVATAR_RUNTIME_CACHE_LOG_INTERVAL_MS = parsePositiveInt(
  process.env.AVATAR_RUNTIME_CACHE_LOG_INTERVAL_MS,
  60 * 1000
);
const avatarRuntimeCache = new Map<string, AvatarRuntimeCacheEntry>();
const avatarRuntimeCacheMetrics = {
  hits: 0,
  misses: 0,
  expirations: 0,
  writes: 0,
  evictions: 0,
  lastLoggedAt: 0,
};

function maybeLogAvatarRuntimeCacheMetrics(): void {
  const now = Date.now();
  if (now - avatarRuntimeCacheMetrics.lastLoggedAt < AVATAR_RUNTIME_CACHE_LOG_INTERVAL_MS) {
    return;
  }
  avatarRuntimeCacheMetrics.lastLoggedAt = now;

  logger.info('Avatar runtime cache metrics', {
    event: 'avatar_runtime_cache_metrics',
    subsystem: 'cache',
    cache: 'avatar_runtime',
    size: avatarRuntimeCache.size,
    ttlMs: AVATAR_RUNTIME_CACHE_TTL_MS,
    maxSize: AVATAR_RUNTIME_CACHE_MAX_SIZE,
    hits: avatarRuntimeCacheMetrics.hits,
    misses: avatarRuntimeCacheMetrics.misses,
    expirations: avatarRuntimeCacheMetrics.expirations,
    writes: avatarRuntimeCacheMetrics.writes,
    evictions: avatarRuntimeCacheMetrics.evictions,
  });
}

function getCachedAvatarRuntime(avatarId: string): AvatarRuntime | null {
  const now = Date.now();
  const cached = avatarRuntimeCache.get(avatarId);
  if (!cached) {
    avatarRuntimeCacheMetrics.misses++;
    maybeLogAvatarRuntimeCacheMetrics();
    return null;
  }
  if (cached.expiresAt <= now) {
    avatarRuntimeCache.delete(avatarId);
    avatarRuntimeCacheMetrics.expirations++;
    avatarRuntimeCacheMetrics.misses++;
    maybeLogAvatarRuntimeCacheMetrics();
    return null;
  }

  // Touch for LRU behavior.
  avatarRuntimeCache.delete(avatarId);
  avatarRuntimeCache.set(avatarId, cached);
  avatarRuntimeCacheMetrics.hits++;
  maybeLogAvatarRuntimeCacheMetrics();
  return cached.value;
}

function setCachedAvatarRuntime(avatarId: string, runtime: AvatarRuntime): void {
  const entry: AvatarRuntimeCacheEntry = {
    value: runtime,
    expiresAt: Date.now() + AVATAR_RUNTIME_CACHE_TTL_MS,
  };

  avatarRuntimeCache.delete(avatarId);
  avatarRuntimeCache.set(avatarId, entry);
  avatarRuntimeCacheMetrics.writes++;

  while (avatarRuntimeCache.size > AVATAR_RUNTIME_CACHE_MAX_SIZE) {
    const oldestKey = avatarRuntimeCache.keys().next().value;
    if (!oldestKey) break;
    avatarRuntimeCache.delete(oldestKey);
    avatarRuntimeCacheMetrics.evictions++;
  }
  maybeLogAvatarRuntimeCacheMetrics();
}

/**
 * Fetch individual secrets from Secrets Manager using direct paths.
 * Delegates to the shared loadAvatarSecrets utility for consistent
 * fallback chains and naming conventions across all handlers.
 */
async function fetchAvatarSecrets(avatarId: string): Promise<Record<string, string>> {
  const prefix = getSecretPrefix();
  const secrets = await loadAvatarSecrets(secretsService, avatarId, prefix);

  logger.info('Fetched avatar secrets', {
    avatarId,
    hasOpenRouterKey: !!secrets.OPENROUTER_API_KEY,
    hasTwitterApiKey: !!secrets.TWITTER_API_KEY,
    hasTwitterApiSecret: !!secrets.TWITTER_API_SECRET,
    hasTwitterAccessToken: !!secrets.TWITTER_ACCESS_TOKEN,
    hasTwitterAccessSecret: !!secrets.TWITTER_ACCESS_SECRET,
  });

  return secrets;
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(getStateTable());
  secretsService = createSecretsService();
  presenceService = createPresenceService(getStateTable());
}

async function getAvatarRuntime(avatarId: string): Promise<AvatarRuntime> {
  const cached = getCachedAvatarRuntime(avatarId);
  if (cached) return cached;

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

  // Back-compat + parity: if Twitter is enabled, ensure the runtime tool allowlist includes
  // the core Twitter interaction tools so automated replies can fetch context and act.
  const effectiveTools = new Set<string>(avatarConfig.tools || []);
  if (avatarConfig.platforms?.twitter?.enabled) {
    [
      'twitter_status',
      'twitter_get_tweet',
      'twitter_get_mentions',
      'twitter_get_timeline',
      'twitter_reply',
      'twitter_post',
      'twitter_like',
      'twitter_unlike',
      'twitter_retweet',
      'twitter_unretweet',
      'twitter_quote',
      'twitter_get_activity_summary',
    ].forEach(t => effectiveTools.add(t));
  }

  // Enable gallery and core media tools for Telegram avatars
  if (avatarConfig.platforms?.telegram?.enabled) {
    [
      'get_my_gallery',
      'search_gallery',
      'send_gallery_image',
      'generate_image',
      'generate_video',
      'get_job_status',
      'list_jobs',
    ].forEach(t => effectiveTools.add(t));
  }

  if (effectiveTools.size !== (avatarConfig.tools || []).length) {
    avatarConfig.tools = Array.from(effectiveTools);
  }

  // Fetch individual secrets from Secrets Manager using direct paths
  const secrets = await fetchAvatarSecrets(avatarId);

  // If avatar secrets don't include Replicate, fall back to a system key (if configured).
  try {
    const ok = await ensureReplicateKey(secrets, secretsService);
    if (ok && !secrets.REPLICATE_API_TOKEN && secrets.REPLICATE_API_KEY) {
      logger.info('Loaded system Replicate key for runtime handler');
    } else if (!ok) {
      logger.warn('System Replicate key not configured for runtime handler', {
        hasEnvKey: Boolean(process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY),
        hasSecretArn: Boolean(process.env.REPLICATE_API_KEY_SECRET_ARN),
      });
    }
  } catch (err) {
    logger.warn('Failed to load system Replicate key', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const mediaBucket = getMediaBucket();
  const mediaDeps = createMediaDependencies({ tableName: getStateTable() });
  const mediaService = mediaBucket
    ? createMediaServiceWithDeps(secrets, mediaBucket, getCdnUrl(), mediaDeps)
    : undefined;

  const mcpServices = createPlatformMCPServices({
    avatarId,
    avatarConfig,
    stateService,
    mediaService,
    secrets,
    mediaBucket,
    cdnUrl: getCdnUrl(),
  });

  const registry = new ToolRegistry();
  registerAllTools(registry, mcpServices);

  const runtime: AvatarRuntime = {
    avatarId,
    avatarConfig,
    secrets,
    registry,
  };

  setCachedAvatarRuntime(avatarId, runtime);
  return runtime;
}

/**
 * Build a mention/reply annotation prefix for a message.
 * Returns a string like "[Mentioned you] " or "[Reply to you] " (or both),
 * or empty string if neither flag is set.
 */
export function formatMentionContext(msg: { isMention?: boolean; isReplyToBot?: boolean }): string {
  const tags: string[] = [];
  if (msg.isMention) tags.push('[Mentioned you]');
  if (msg.isReplyToBot) tags.push('[Reply to you]');
  return tags.length > 0 ? tags.join(' ') + ' ' : '';
}

/**
 * Convert SwarmEnvelope to ContextMessage for channel state
 */
function envelopeToContextMessage(envelope: SwarmEnvelope): ContextMessage {
  // Build a richer content string for media messages in channel history
  let content = envelope.content.text || '';
  if (!content && envelope.content.media && envelope.content.media.length > 0) {
    const types = envelope.content.media.map(m => m.type);
    if (types.includes('audio')) {
      content = '[voice message]';
    } else if (types.includes('photo')) {
      content = '[photo]';
    } else if (types.includes('video')) {
      content = '[video]';
    } else if (types.includes('animation')) {
      content = '[GIF]';
    } else if (types.includes('document')) {
      content = '[document]';
    } else {
      content = '[media]';
    }
  } else if (!content) {
    content = '[media]';
  }

  return {
    messageId: envelope.messageId,
    sender: envelope.sender.displayName || envelope.sender.username || 'Unknown',
    isBot: envelope.sender.isBot,
    content,
    timestamp: envelope.timestamp,
    userId: envelope.sender.id,
    username: envelope.sender.username,
    isMention: envelope.metadata.isMention,
    isReplyToBot: envelope.metadata.isReplyToBot,
    replyToMessageId: envelope.replyTo,
  };
}

/**
 * Generate response with iterative tool execution
 */
async function generateResponse(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext,
  avatarRuntime: AvatarRuntime,
  channelHistory?: ContextMessage[]
): Promise<SwarmResponse> {
  await maybeTranscribeAudio(envelope, toolClient, toolContext, avatarRuntime.avatarConfig);
  const brainService = createRuntimeBrainService(stateService, avatarRuntime.avatarConfig.brain);
  const systemPrompt = await buildSystemPrompt(
    envelope,
    avatarRuntime.avatarConfig,
    avatarRuntime.avatarId,
    avatarRuntime.secrets,
    presenceService,
    stateService
  );
  // Inject memory context into system prompt (gated by BRAIN_INJECT_CONTEXT flag)
  let enrichedSystemPrompt = systemPrompt;
  if (process.env.BRAIN_INJECT_CONTEXT === 'true') {
    try {
      const userText = envelope.content.text || '';
      if (userText.trim()) {
        const recallResult = await brainService.recall(
          avatarRuntime.avatarId,
          userText,
          envelope.sender.id
        );
        if (recallResult.facts.length > 0) {
          const memoryContext = formatBrainMemoryContext(recallResult.facts);
          if (memoryContext) {
            enrichedSystemPrompt = systemPrompt + '\n\n' + memoryContext;
          }
          logger.info('Memory context injected into system prompt', {
            event: 'brain_context_injected',
            subsystem: 'brain',
            avatarId: avatarRuntime.avatarId,
            factCount: recallResult.facts.length,
            source: recallResult.source,
            queryLength: userText.trim().length,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to inject memory context, continuing without it', {
        event: 'brain_context_injection_failed',
        subsystem: 'brain',
        avatarId: avatarRuntime.avatarId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const toolDefinitions = toolClient
    .getToolDefinitions()
    .filter((tool: { name: string }) => avatarRuntime.avatarConfig.tools.includes(tool.name));
  const enabledTools = toolClient.getOpenAIToolsForTools(toolDefinitions);

  // Build initial messages from channel history + current message
  const maxContext = avatarRuntime.avatarConfig.behavior.maxContextMessages || 20;
  const messages: LLMMessage[] = [
    { role: 'system', content: enrichedSystemPrompt },
  ];

  // Add channel history (excluding the current message which we'll add separately)
  if (channelHistory && channelHistory.length > 0) {
    // Filter out the current message from history (it might already be there)
    const historyWithoutCurrent = channelHistory.filter(
      msg => msg.messageId !== envelope.messageId
    );
    // Take most recent messages up to limit
    const recentHistory = historyWithoutCurrent.slice(-maxContext);

    // Add history messages with proper user/assistant roles
    // Include sender name for multi-user chat context
    for (const msg of recentHistory) {
      // If this message is a reply to something outside the visible context window,
      // inject a brief annotation so the LLM knows what it's replying to.
      const replyAnnotation = buildReplyAnnotation(
        msg.replyToMessageId,
        recentHistory,
        channelHistory,
      );
      const prefix = replyAnnotation ? `${replyAnnotation}\n` : '';

      messages.push({
        role: msg.isBot ? 'assistant' : 'user',
        // Only prefix user messages with sender name for group chat context.
        // Bot (assistant) messages should NOT include the name prefix,
        // otherwise the LLM learns to prefix its own responses with its name.
        // Surface mention/reply-to-bot context so the LLM knows when it was
        // directly addressed vs seeing a regular group message.
        // Also include reply-to annotations for messages replying to content
        // outside the visible context window.
        content: msg.isBot
          ? `${prefix}${msg.content}`
          : `${prefix}${formatMentionContext(msg)}[${msg.sender}]: ${msg.content}`,
      });
    }

    logger.info('Added channel history to context', {
      event: 'history_added',
      historyCount: recentHistory.length,
      maxContext,
      totalHistory: channelHistory.length,
      historyMessageIds: recentHistory.map(m => m.messageId).slice(0, 5), // Log first 5 IDs for debugging
    });
  } else {
    logger.info('No channel history available', {
      event: 'no_history',
      channelHistoryProvided: !!channelHistory,
      channelHistoryLength: channelHistory?.length ?? 0,
    });
  }

  // Add current user message with sender attribution for group chat context.
  // Surface mention/reply context from the envelope metadata so the LLM
  // knows whether the user directly addressed it.
  // For messages with media (images, voice, etc.), extract content so the LLM
  // can actually see images (via vision) and read voice transcripts.
  const sender = envelope.sender.displayName || envelope.sender.username || envelope.sender.id;
  const mentionPrefix = formatMentionContext(envelope.metadata);
  // Resolve reply-to context for the current incoming message.
  // The context window for the current message is recentHistory (already sent to LLM).
  const currentReplyAnnotation = channelHistory
    ? buildReplyAnnotation(
        envelope.replyTo,
        channelHistory.filter(m => m.messageId !== envelope.messageId).slice(-maxContext),
        channelHistory,
      )
    : undefined;
  const currentPrefix = currentReplyAnnotation ? `${currentReplyAnnotation}\n` : '';

  const hasMedia = envelope.content.media && envelope.content.media.length > 0;

  if (hasMedia) {
    const mediaConfig: MediaExtractionConfig = {
      telegramBotToken: avatarRuntime.secrets.TELEGRAM_BOT_TOKEN || avatarRuntime.secrets.telegram_bot_token,
      openaiApiKey: avatarRuntime.secrets.OPENAI_API_KEY || avatarRuntime.secrets.openai_api_key,
    };

    try {
      const extraction = await extractMediaContext(envelope, mediaConfig);
      const baseText = envelope.content.text || '';
      const senderPrefix = `${currentPrefix}${mentionPrefix}[${sender}]: `;
      const userContent = buildUserMessageContent(
        senderPrefix + (baseText || ''),
        extraction,
      );

      messages.push({
        role: 'user',
        content: userContent,
      });

      logger.info('Built multimodal user message', {
        event: 'media_extraction_complete',
        subsystem: 'media-extractor',
        imageCount: extraction.imageUrls.length,
        descriptionCount: extraction.mediaDescriptions.length,
        hasAnnotation: extraction.annotation.length > 0,
      });
    } catch (err) {
      // Fallback: if media extraction fails, use the old placeholder behavior
      logger.warn('Media extraction failed, using fallback', {
        event: 'media_extraction_error',
        subsystem: 'media-extractor',
        error: err instanceof Error ? err.message : String(err),
      });
      const text = envelope.content.text || '[media received]';
      messages.push({
        role: 'user',
        content: `${currentPrefix}${mentionPrefix}[${sender}]: ${text}`,
      });
    }
  } else {
    const text = envelope.content.text || (() => {
      const mediaTypes = envelope.content.media?.map(m => m.type) || [];
      if (mediaTypes.includes('audio')) return '[voice message received]';
      return '[media received]';
    })();
    messages.push({
      role: 'user',
      content: `${currentPrefix}${mentionPrefix}[${sender}]: ${text}`,
    });
  }

  const allToolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string } } }> = [];
  let finalContent: string | undefined;
  let cleanFinalContent: string | undefined; // Content without thinking tags
  let iterations = 0;
  let totalTokens = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const llmResponse = await callLLM(messages, enabledTools, avatarRuntime.avatarConfig.llm, avatarRuntime.secrets);
    totalTokens += 100; // Approximate, would need actual count from API

    if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
      // No tool calls, we have a final response
      finalContent = llmResponse.content;

      // Extract thinking tags - save to memory, strip from output
      if (finalContent) {
        const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(finalContent);
        cleanFinalContent = cleanContent;

        if (hasThinking && thinkingBlocks.length > 0) {
          // Save thinking to avatar's memory (if memory is enabled)
          const memoryAllowed = await isMemoryWriteAllowed(envelope.avatarId);
          if (memoryAllowed) {
            for (const thinking of thinkingBlocks) {
              try {
                await brainService.remember(
                  envelope.avatarId,
                  `[Internal thought in ${envelope.conversationId}]: ${thinking}`,
                  'thinking'
                );
              } catch (err) {
                logger.error('Failed to save thinking to memory', { error: err });
              }
            }
            logger.info('Saved thinking blocks to memory', {
              count: thinkingBlocks.length,
              avatarId: envelope.avatarId
            });
          } else {
            logger.debug('Memory writes disabled, skipping thinking storage', {
              avatarId: envelope.avatarId,
              thinkingCount: thinkingBlocks.length,
            });
          }
        }

        // Strip avatar name prefix if the model accidentally added it
        // (e.g., "[Chamuel 😇]: Hey!" becomes "Hey!")
        cleanFinalContent = stripAvatarNamePrefix(cleanFinalContent, avatarRuntime.avatarConfig.name);
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: llmResponse.content || '',
      tool_calls: llmResponse.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    });

    // Execute tool calls
    for (const toolCall of llmResponse.toolCalls) {
      const toolLimit = await checkToolCallLimit(envelope.avatarId, allToolResults.length);
      if (!toolLimit.allowed) {
        logger.warn('Tool call blocked by entitlement limits', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          tool: toolCall.name,
          reason: toolLimit.reason,
          limit: toolLimit.limit,
          current: toolLimit.current,
        });

        // Tell the model the tool call failed due to policy and stop executing further tools.
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: toolLimit.reason || 'Tool calls are limited by your current plan',
          }),
        });
        break;
      }

      logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments });

      const result = await toolClient.execute(toolCall.name, toolCall.arguments, toolContext);

      allToolResults.push({ name: toolCall.name, result });

      // Add tool result message (include media so the model can reference outputs)
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.success
          ? { data: result.data, media: result.media, pendingJob: result.pendingJob }
          : { error: result.error }),
      });

      // If a tool produced an image, feed it back into context so vision-capable models can see it.
      if (result.success && result.media?.type === 'image' && result.media.url) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the image you just generated. Please look at it and respond.' },
            { type: 'image_url', image_url: { url: result.media.url } },
          ],
        });
      }

      logger.info('Tool result', { tool: toolCall.name, success: result.success });
    }
  }

  // Build response actions
  let actions: ResponseAction[] = toolResultsToActions(allToolResults);

  // Use clean content (without thinking tags) for user-facing messages
  const outputContent = cleanFinalContent || finalContent;

  // If we got final content but no send_message action, add it
  if (outputContent && !actions.some(a => a.type === 'send_message')) {
    actions.push({ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId });
  }

  // If no actions at all, add the content as a message
  if (actions.length === 0 && outputContent) {
    actions = [{ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId }];
  }

  return {
    avatarId: envelope.avatarId,
    platform: envelope.platform,
    conversationId: envelope.conversationId,
    replyToMessageId: envelope.messageId,
    actions,
    generatedAt: Date.now(),
    llmModel: avatarRuntime.avatarConfig.llm.model,
    tokensUsed: totalTokens,
  };
}

export const handler = async (event: SQSEvent, context: Context): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  logger.setContext({
    avatarId: process.env.AVATAR_ID || 'shared',
    requestId: context.awsRequestId,
  });

  await initialize();

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      let parsedBody: unknown;
      let rawBody: string = record.body;
      let wasOffloaded = false;
      try {
        const parsed = await parseSqsRecordBody(record.body);
        parsedBody = parsed.payload;
        rawBody = parsed.rawBody;
        wasOffloaded = parsed.wasOffloaded;
      } catch (parseError) {
        logger.error('Failed to parse message body', {
          messageId: record.messageId,
          error: parseError instanceof Error ? parseError.message : String(parseError),
          bodyPreview: record.body?.slice(0, 100),
        });
        // Poison pill - send to DLQ by reporting as failure
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const parseResult = MessageQueueItemSchema.safeParse(parsedBody);
      if (!parseResult.success) {
        logger.error('Invalid message queue item schema', {
          messageId: record.messageId,
          error: parseResult.error.message,
        });
        // Schema validation failures are permanent - send to DLQ
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      const item = parseResult.data;
      const envelope = item.envelope as SwarmEnvelope;
      const avatarId = envelope.avatarId || process.env.AVATAR_ID;
      if (!avatarId) {
        logger.error('Missing avatarId (shared handler requires envelope.avatarId)', {
          event: 'validation_error',
          subsystem: 'chat',
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const avatarRuntime = await getAvatarRuntime(avatarId);

      const recordTraceId = record.messageAttributes?.traceId?.stringValue;
      const traceId = recordTraceId || envelope.traceId || randomUUID();
      const correlationId = extractCorrelationIdFromSqsRecord(record);

      logger.setContext({
        avatarId,
        messageId: envelope.messageId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
        correlationId,
        traceId,
      });

      logger.info('Processing message', {
        event: 'processing_started',
        subsystem: 'chat',
        sender: envelope.sender.username,
        text: envelope.content.text?.slice(0, 50),
        isMention: envelope.metadata.isMention,
        isReplyToBot: envelope.metadata.isReplyToBot,
      });

      // =========================================================
      // ENTITLEMENT ENFORCEMENT
      // =========================================================
      const usageCheck = await checkAndIncrementMessageUsage(avatarId);
      if (!usageCheck.allowed) {
        logger.warn('Message rejected due to limit', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          reason: usageCheck.reason,
          limit: usageCheck.limit,
          current: usageCheck.current,
        });
        // Don't retry - this is a policy rejection, not an error
        continue;
      }

      // =========================================================
      // KYRO-STYLE CHANNEL STATE MANAGEMENT
      // =========================================================

      await stateService.getOrCreateChannelState(
        avatarId,
        envelope.conversationId,
        envelope.platform,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      const updatedState = await stateService.addMessageToChannel(
        avatarId,
        envelope.conversationId,
        envelope.platform,
        envelopeToContextMessage(envelope),
        undefined,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      // Register channel for presence tracking
      try {
        await presenceService.registerChannel(
          avatarId,
          envelope.conversationId,
          envelope.platform,
          {
            title: envelope.metadata.chatTitle,
            type: envelope.metadata.chatType,
          }
        );
      } catch (err) {
        logger.warn('Failed to register channel for presence', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('Channel state updated', {
        event: 'state_updated',
        subsystem: 'state',
        state: updatedState.state,
        bufferSize: updatedState.recentMessages.length,
        chatType: updatedState.chatType,
      });

      const decision = stateService.evaluateResponseTrigger(updatedState);

      logger.info('Response decision', {
        event: 'response_decision',
        subsystem: 'chat',
        shouldRespond: decision.shouldRespond,
        trigger: decision.trigger,
        delay: decision.delay,
        priority: decision.priority,
      });

      if (!decision.shouldRespond) {
        logger.info('Skipping response', {
          event: 'response_skipped',
          subsystem: 'chat',
          reason: decision.trigger,
        });
        continue;
      }

      if (decision.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, decision.delay));
      }

      await stateService.transitionState(avatarId, envelope.conversationId, 'ACTIVE');

      // =========================================================
      // GENERATE RESPONSE WITH MCP TOOLS
      // =========================================================

      const toolClient = createToolClient(avatarRuntime.registry, envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api');

      const toolContext: ToolContext = {
        avatarId,
        platform: envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api',
        userId: envelope.sender.id,
        conversationId: envelope.conversationId,
        replyToMessageId: envelope.messageId,
      };

      const response = await generateResponse(envelope, toolClient, toolContext, avatarRuntime, updatedState.recentMessages);

      logger.info('Response generated', {
        event: 'response_generated',
        subsystem: 'llm',
        actions: response.actions.length,
        tokensUsed: response.tokensUsed,
      });

      // Queue response for sending (with S3 offload for large payloads)
      await sendSqsMessage({
        QueueUrl: getResponseQueueUrl(),
        MessageAttributes: {
          traceId: { DataType: 'String', StringValue: traceId },
          [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
        },
        MessageGroupId: `${avatarId}#${envelope.conversationId}`,
        MessageDeduplicationId: `resp_${avatarId}_${envelope.conversationId}_${envelope.messageId}`,
      }, response);

      // Clean up offloaded S3 payload from the inbound message (if any)
      if (wasOffloaded) {
        await cleanupSqsRecord(rawBody);
      }

      // =========================================================
      // POST-RESPONSE STATE UPDATES
      // =========================================================

      if (avatarRuntime.avatarConfig.behavior.cooldownMinutes > 0) {
        await stateService.setUserCooldown({
          avatarId,
          platform: envelope.platform,
          userId: envelope.sender.id,
          cooldownUntil: Date.now() + (avatarRuntime.avatarConfig.behavior.cooldownMinutes * 60 * 1000),
        });
      }

    } catch (error) {
      logger.error('Failed to process message', error, {
        event: 'processing_error',
        subsystem: 'chat',
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return partial batch failure response for SQS
  if (batchItemFailures.length > 0) {
    logger.warn('Partial batch failure', {
      event: 'batch_partial_failure',
      subsystem: 'chat',
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length,
    });
  }

  return { batchItemFailures };
};
