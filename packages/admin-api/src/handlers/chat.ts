/**
 * Admin Chatbot Handler
 *
 * Thin orchestrator that delegates to per-domain modules under ./chat-tools/.
 * All tool building, execution, context enrichment, and post-processing live
 * in dedicated modules; this file wires them together.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  logger,
  createRuntimeMetricsLogger,
  detectEnabledCategories,
} from '@swarm/core';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import * as chatHistory from '../services/chat-history.js';
import { getPendingTool, removePendingTool, savePendingTool } from '../services/pending-tools.js';
import { createChatJob, createJobId } from '../services/chat-jobs.js';
import {
  ChatRequestSchema,
  type AdminChatMessage,
  type AvatarRecord,
  type UserSession,
} from '../types.js';
import { recordError } from '../services/auto-issues.js';
import { createAvatarAccessChecker } from '../services/chat-access.js';
import { ensureRuntimeConfig } from '../services/runtime-config.js';
import { chatIdempotencyStore } from '../services/idempotency.js';
import { incrementUsage, checkLimit } from '../services/billing/entitlements.js';

import {
  ToolRegistry,
  registerAllTools,
} from '@swarm/mcp-server';
import type { ToolContext } from '@swarm/mcp-server';
import { createMCPServices } from '../services/mcp-adapter.js';
import * as avatars from '../services/avatars.js';
import { getValidModelId } from '../services/models-registry.js';
import { resolveOpenRouterChatModelPlan } from '../services/openrouter-chat-models.js';
import { mapAdminChatHandlerError } from './chat-error-mapping.js';
import { getGateStatus } from '../services/web3/nft-gate.js';

import {
  LLM_MODEL,
  LLM_MAX_TOKENS,
  LLM_TOOL_MAX_TOKENS,
} from './chat-llm.js';
import {
  buildOpenRouterTools,
  type MediaItem,
} from './chat-tool-helpers.js';
import {
  checkPublicRateLimit,
  recordPublicRateLimit,
  PUBLIC_RATE_LIMIT_ORB_HOLDERS,
  type PublicRateLimitResult,
} from './chat-rate-limiting.js';
import { resolvePublicAvatarIdFromRequest } from './chat-public-access.js';

// Per-domain modules
import {
  type AvatarContext,
  type ProcessChatOptions,
  type ProcessChatResult,
  buildModelInput,
  buildEnrichedSystemPrompt,
  transcribeAudioAttachments,
  buildUserMessageContent,
  runLlmCallLoop,
  executeFallbackToolLoop,
  handlePauseToolCalls,
  cleanResponse,
  surfaceModelConfig,
  shouldUseEmptyResponseFallback,
  extractPendingJobs,
  extractTaskActions,
  detectAvatarUpdates,
  extractMedia,
  resumeChatAfterToolResult as _resumeChatAfterToolResult,
  handleHealthCheck,
  handleGetHistory,
  handleDeleteHistory,
  handleAppendMessage,
} from './chat-tools/index.js';

// Re-export types so downstream consumers (chat-worker, etc.) are unaffected.
export type { AvatarContext, ProcessChatOptions, ProcessChatResult };

const CHAT_QUEUE_URL = process.env.CHAT_QUEUE_URL;
const sqsClient = CHAT_QUEUE_URL ? new SQSClient({}) : null;

function prefersAsyncResponse(event: APIGatewayProxyEventV2): boolean {
  const prefer = event.headers['prefer'] || event.headers['Prefer'] || '';
  return typeof prefer === 'string' && prefer.toLowerCase().includes('respond-async');
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function extractModelIdFromMessage(message: string): string | undefined {
  const matches = message.match(/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*/gi) || [];
  for (const candidate of matches) {
    const model = getValidModelId(candidate);
    if (model) return model;
  }
  return undefined;
}

async function handlePendingModelSelectionText(params: {
  session: UserSession;
  avatarRecord: AvatarRecord | null;
  avatarId: string | undefined;
  message: string;
  history: AdminChatMessage[];
  corsHeaders: Record<string, string>;
}): Promise<APIGatewayProxyResultV2 | null> {
  const { session, avatarRecord, avatarId, message, history, corsHeaders } = params;
  if (!session.email || !avatarId) return null;

  const pendingTool = await getPendingTool(session.email, avatarId);
  if (pendingTool?.toolName !== 'request_model_selection') return null;

  const selectedModel = extractModelIdFromMessage(message);
  if (!selectedModel) return null;

  const currentConfig = avatarRecord?.llmConfig || {
    provider: DEFAULT_LLM_PROVIDER,
    model: DEFAULT_LLM_MODEL,
    temperature: DEFAULT_LLM_TEMPERATURE,
    maxTokens: DEFAULT_LLM_MAX_TOKENS,
    useGlobalKey: true,
  };
  await avatars.updateAvatar(avatarId, {
    llmConfig: {
      ...currentConfig,
      provider: currentConfig.provider || DEFAULT_LLM_PROVIDER,
      model: selectedModel,
    },
  }, session);
  await removePendingTool(session.email, avatarId);

  const response = `Model updated to ${selectedModel}.`;
  const nextHistory: AdminChatMessage[] = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: response },
  ];
  await chatHistory.saveChatHistory(session, nextHistory, avatarId);

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ response, history: nextHistory }),
  };
}

/**
 * Process a chat message, executing tools as needed.
 */
export async function processChat(
  userMessage: string | null,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  avatar?: AvatarContext,
  options?: ProcessChatOptions
): Promise<ProcessChatResult> {
  const chatMetrics = createRuntimeMetricsLogger('AdminChat');
  const chatStartTime = Date.now();
  const avatarId = avatar?.id;

  // --- Tool setup ---
  const mcpServices = avatarId ? createMCPServices(avatarId, session) : null;
  const toolRegistry = avatarId && mcpServices ? new ToolRegistry() : null;
  if (toolRegistry && mcpServices) registerAllTools(toolRegistry, mcpServices);
  const toolContext: ToolContext | null = avatarId ? {
    avatarId, platform: 'admin-ui', userId: session.userId,
    session: { email: session.email, isAdmin: session.isAdmin },
  } : null;
  const tools = toolRegistry && toolContext
    ? await buildOpenRouterTools(toolRegistry, toolContext, { enabledCategories: avatar?.enabledCategories })
    : [];

  logger.info('Tools created', {
    event: 'tools_created', avatarId, toolCount: tools.length,
    toolNames: tools.map((t: { function?: { name?: string }; name?: string }) => t.function?.name ?? t.name),
  });

  // --- Message preparation ---
  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    ...(userMessage !== null ? [{ role: 'user' as const, content: userMessage }] : []),
  ];

  const allMedia: MediaItem[] = [];
  const systemPrompt = await buildEnrichedSystemPrompt(avatar, userMessage, options);

  let transcribedText = '';
  if (userMessage !== null && avatarId && options?.attachments) {
    transcribedText = await transcribeAudioAttachments(avatarId, options.attachments);
  }

  const messageWithTranscription = userMessage !== null
    ? (transcribedText ? userMessage + transcribedText : userMessage) : '';
  let userMessageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> = messageWithTranscription;
  if (userMessage !== null && options?.attachments && options.attachments.length > 0) {
    userMessageContent = buildUserMessageContent(userMessage, transcribedText, options.attachments);
  }

  const hasModifications = userMessage !== null
    ? (userMessageContent !== messageWithTranscription || transcribedText !== '') : false;
  const messagesWithAttachments: AdminChatMessage[] = userMessage === null
    ? messages
    : hasModifications
      ? [...conversationHistory, { role: 'user' as const, content: userMessageContent as string }]
      : messages;

  // Sanitize and truncate messages for the LLM context window
  const preparedMessages = buildModelInput(systemPrompt, messagesWithAttachments);
  const modelPlan = await resolveOpenRouterChatModelPlan({
    requestModel: options?.model,
    defaultModel: LLM_MODEL,
    requireTools: tools.length > 0,
  });
  const effectiveModel = modelPlan.primaryModel;
  const maxOutputTokens = clampInt(options?.maxTokens ?? LLM_MAX_TOKENS, 1, 8192);
  const effectiveMaxOutputTokens = tools.length > 0 ? Math.min(maxOutputTokens, LLM_TOOL_MAX_TOKENS) : maxOutputTokens;

  logger.info('LLM request', {
    event: 'llm_request', model: effectiveModel,
    messageCount: messages.length, toolsIncluded: tools.length > 0,
  });

  // --- LLM call loop ---
  const llmResult = await runLlmCallLoop({
    systemPrompt, messages: preparedMessages, tools,
    effectiveModel, effectiveMaxOutputTokens, avatarId,
  });

  let response = llmResult.response;
  const { toolCalls, adminToolCalls, usedFallback, fallbackResponse } = llmResult;

  // Record LLM call latency
  if (typeof llmResult.lastFallbackLatency === 'number') {
    chatMetrics.putMetric('LlmCallLatency', llmResult.lastFallbackLatency, 'Milliseconds');
  }

  logger.info('LLM response', {
    event: 'llm_response', hasToolCalls: toolCalls.length > 0,
    toolCallCount: toolCalls.length, toolNames: toolCalls.map(tc => String(tc.name)), usedFallback,
  });

  // --- Pause tool handling ---
  const pauseResult = await handlePauseToolCalls({
    toolCalls, adminToolCalls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mcpServices: mcpServices as any,
    avatarId, messages, tools,
  });
  if (pauseResult) return pauseResult;

  // --- Tool execution ---
  let toolResults: { tool_call_id: string; role: 'tool'; content: string }[] = [];

  if (toolCalls.length > 0 && usedFallback) {
    const fallbackResult = await executeFallbackToolLoop({
      toolCalls, adminToolCalls, fallbackResponse, tools,
      effectiveModel, effectiveMaxOutputTokens, systemPrompt,
      messagesWithAttachments, messages, avatarId, mcpServices,
    });
    toolResults = fallbackResult.toolResults;
    if (fallbackResult.pendingToolCall) {
      return { response: fallbackResult.response, history: fallbackResult.earlyReturnHistory!, pendingToolCall: fallbackResult.pendingToolCall };
    }
    if (fallbackResult.response) response = fallbackResult.response;
  }

  // Get final response if not yet resolved
  if (!response && fallbackResponse) {
    response = fallbackResponse;
  }

  // Append tool call/result messages to history
  if (toolCalls.length > 0) {
    messages.push({ role: 'assistant', content: '', tool_calls: adminToolCalls });
    for (const result of toolResults) messages.push(result as AdminChatMessage);
  }

  // Post-processing
  response = surfaceModelConfig(response, toolCalls, toolResults);
  const pendingJobs = extractPendingJobs(toolCalls, toolResults);

  if (shouldUseEmptyResponseFallback(response, pendingJobs)) {
    logger.error('LLM response empty after all retries', { event: 'llm_empty_after_retries', avatarId, model: effectiveModel });
    recordError({ error: 'LLM returned empty response after all retries', subsystem: 'llm', category: 'llm_empty_response', avatarId }).catch(() => {});
    response = 'I apologize, but I couldn\'t generate a response. Please try again.';
  } else if (!response && pendingJobs.length > 0) {
    logger.info('LLM response empty after pending async job', {
      event: 'llm_empty_after_pending_job',
      avatarId,
      model: effectiveModel,
      pendingJobTypes: pendingJobs.map(job => job.type),
    });
  }

  const cleaned = cleanResponse(response);
  response = cleaned.response;

  const taskActions = extractTaskActions(toolCalls, toolResults);
  allMedia.push(...extractMedia(toolResults));
  const avatarUpdates = await detectAvatarUpdates(toolCalls, toolResults, avatarId);

  messages.push({
    role: 'assistant', content: response,
    ...(cleaned.extractedThinking ? { thinking: cleaned.extractedThinking } : {}),
    // Attach media to the assistant message so it persists with chat history
    ...(allMedia.length > 0 ? { media: allMedia } : {}),
  });

  // Emit EMF metrics
  chatMetrics.trackDuration('ChatLatency', chatStartTime);
  chatMetrics.incrementCounter('ChatRequests');
  if (toolResults.length > 0) chatMetrics.incrementCounter('ToolCallsExecuted', toolResults.length);
  chatMetrics.setProperty('Outcome', response ? 'success' : 'error');
  chatMetrics.flush();

  return {
    response, history: messages,
    media: allMedia.length > 0 ? allMedia : undefined,
    pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
    avatarUpdates: (avatarUpdates.profileImageUrl || avatarUpdates.name) ? avatarUpdates : undefined,
    taskActions: taskActions.length > 0 ? taskActions : undefined,
  };
}

/**
 * Lambda handler for chat API.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Validate critical runtime config on cold start (no-op on warm invocations)
  ensureRuntimeConfig();

  const corsHeaders = getCorsHeaders(event);
  if (event.requestContext.http.method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders };

  const rawPath = event.rawPath || '/';
  const path = rawPath === '/api' ? '/' : rawPath.startsWith('/api/') ? rawPath.slice('/api'.length) : rawPath;
  const method = event.requestContext.http.method;

  const healthResponse = handleHealthCheck(method, path, corsHeaders);
  if (healthResponse) return healthResponse;

  const idempotencyKey = event.headers['idempotency-key'] || event.headers['Idempotency-Key'];

  try {
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;
    logger.setContext({ subsystem: 'chat', requestId });

    const isAdmin = requireAdmin(session);
    const publicAvatarId = resolvePublicAvatarIdFromRequest(event);
    const publicAccess = Boolean(publicAvatarId);
    const ensureAvatarAccess = createAvatarAccessChecker({
      isAdmin,
      session,
      getAvatar: avatars.getAvatar,
      corsHeaders,
      publicAvatarId,
      // #1385 — gate owner access on current NFT ownership, not stale creatorWallet.
      assertOwnership: (avatarId, walletAddress) =>
        avatars.assertAvatarOwnership(avatarId, walletAddress, { isAdmin: false }),
    });

    if (method === 'GET') return handleGetHistory(event, session, ensureAvatarAccess, corsHeaders);
    if (method === 'DELETE') return handleDeleteHistory(event, session, ensureAvatarAccess, corsHeaders);
    if (method === 'POST' && path === '/chat/message') return handleAppendMessage(event, session, ensureAvatarAccess, corsHeaders);

    // POST /chat — send a message
    const requestBody = parseJsonBody<Record<string, unknown>>(event);
    const parseResult = ChatRequestSchema.safeParse(requestBody);
    if (!parseResult.success) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid request',
          details: parseResult.error.issues.map(e => `${(e.path as PropertyKey[]).map(String).join('.')}: ${e.message}`),
        }),
      };
    }
    const { message, history, avatar, systemPrompt: customSystemPrompt, attachments, model, activeTask } = parseResult.data;

    if (idempotencyKey) {
      const cached = await chatIdempotencyStore.get(idempotencyKey) as APIGatewayProxyResultV2 | null;
      if (cached) return cached;
      const claimed = await chatIdempotencyStore.set(idempotencyKey, null);
      if (!claimed) {
        const recheck = await chatIdempotencyStore.get(idempotencyKey) as APIGatewayProxyResultV2 | null;
        if (recheck) return recheck;
        return { statusCode: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Duplicate request is already being processed' }) };
      }
    }

    const accessError = await ensureAvatarAccess(avatar?.id);
    if (accessError) {
      if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, accessError);
      return accessError;
    }

    // Rate limiting for public access
    let publicRateLimitInfo: PublicRateLimitResult | null = null;
    if (publicAccess && avatar?.id && session.userId) {
      let hasOrb = false;
      try { hasOrb = (await getGateStatus(session.userId)).nftsHeld > 0; } catch { /* default no orb */ }
      const rateLimitStatus = await checkPublicRateLimit(session.userId, avatar.id, hasOrb);
      publicRateLimitInfo = rateLimitStatus;
      if (rateLimitStatus.limited) {
        const limitMessage = hasOrb
          ? `Daily limit of ${rateLimitStatus.limit} messages reached. Try again tomorrow.`
          : `Daily limit of ${rateLimitStatus.limit} messages reached. Hold an Orb NFT for ${PUBLIC_RATE_LIMIT_ORB_HOLDERS} messages/day.`;
        const rateLimitResponse = {
          statusCode: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(rateLimitStatus.retryAfter || 3600) },
          body: JSON.stringify({ error: limitMessage, retryAfter: rateLimitStatus.retryAfter, remaining: 0, limit: rateLimitStatus.limit, isOrbHolder: hasOrb }),
        };
        if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, rateLimitResponse);
        return rateLimitResponse;
      }
      void recordPublicRateLimit(session.userId, avatar.id);
    }

    // Build avatar context
    const avatarRecord = avatar?.id ? await avatars.getAvatar(avatar.id) : null;
    const pendingModelSelectionResponse = await handlePendingModelSelectionText({
      session,
      avatarRecord,
      avatarId: avatar?.id,
      message,
      history,
      corsHeaders,
    });
    if (pendingModelSelectionResponse) {
      if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, pendingModelSelectionResponse);
      return pendingModelSelectionResponse;
    }

    const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
    const enabledToolsets = avatarRecord?.mcpConfig?.enabledToolsets || [];
    const enabledCategories = avatarRecord
      ? detectEnabledCategories({
          voice: voiceEnabled, memory: enabledToolsets.includes('memory'),
          telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
          twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
          discord: Boolean(avatarRecord.platforms?.discord?.enabled),
          nft: true, property: enabledToolsets.includes('property'),
          signalStation: enabledToolsets.includes('signal-station'),
        })
      : undefined;
    const avatarContext = avatar ? {
      id: avatar.id, name: avatarRecord?.name ?? avatar.name,
      description: avatarRecord?.description ?? avatar.description,
      persona: avatarRecord?.persona ?? avatar.persona, enabledCategories,
    } : undefined;

    const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
    const resolvedModel = (await resolveOpenRouterChatModelPlan({
      requestModel: model,
      avatarModel: avatarRecord?.llmConfig?.model,
      defaultModel: LLM_MODEL,
    })).primaryModel;

    // Async response path
    if (prefersAsyncResponse(event) && CHAT_QUEUE_URL && sqsClient) {
      const jobId = createJobId();
      await createChatJob({
        jobId, avatarId: avatar?.id ?? 'unknown', type: 'chat',
        prompt: message.length > 280 ? `${message.slice(0, 277)}...` : message,
        session: { userId: session.userId, email: session.email, isAdmin: session.isAdmin },
        request: {
          message, history,
          avatar: avatarContext ? { id: avatarContext.id, name: avatarContext.name, description: avatarContext.description, persona: avatarContext.persona, enabledCategories: avatarContext.enabledCategories } : undefined,
          sender: parseResult.data.sender, systemPrompt: customSystemPrompt, attachments, model: resolvedModel,
        },
      });
      await sqsClient.send(new SendMessageCommand({ QueueUrl: CHAT_QUEUE_URL, MessageBody: JSON.stringify({ jobId }) }));
      const asyncResponse = { statusCode: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, status: 'pending' }) };
      if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, asyncResponse);
      return asyncResponse;
    }

    // Enforce entitlement limits before processing
    if (avatar?.id) {
      const limitCheck = await checkLimit(avatar.id, 'messages');
      if (!limitCheck.allowed) {
        const limitResponse = {
          statusCode: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: limitCheck.reason || 'Daily message limit reached',
            limitType: 'messages',
            current: limitCheck.current,
            limit: limitCheck.limit,
            remaining: 0,
          }),
        };
        if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, limitResponse);
        return limitResponse;
      }
    }

    // Synchronous chat processing
    const result = await processChat(message, history, session, avatarContext, {
      customSystemPrompt, attachments, model: resolvedModel,
      maxTokens: typeof avatarMaxTokens === 'number' ? avatarMaxTokens : undefined,
      userAccountId: session.accountId,
      activeTask,
    });
    await chatHistory.saveChatHistory(session, result.history, avatar?.id);

    // Persist pending tool call so resumeChatAfterToolResult can validate
    // it even after chat history expires or gets sanitized.
    if (result.pendingToolCall && avatar?.id) {
      // Validate that we have an email to use as part of the DynamoDB key
      if (!session.email) {
        logger.error('Cannot persist pending tool - session.email is missing', {
          event: 'pending_tool_save_failed_missing_email',
          avatarId: avatar.id,
          toolCallId: result.pendingToolCall.id,
        });
      } else {
        try {
          await savePendingTool({
            email: session.email,
            avatarId: avatar.id,
            toolCallId: result.pendingToolCall.id,
            toolName: result.pendingToolCall.name,
            arguments: result.pendingToolCall.arguments,
          });
          logger.info('Persisted pending tool call', {
            event: 'pending_tool_saved',
            avatarId: avatar.id,
            toolCallId: result.pendingToolCall.id,
            toolName: result.pendingToolCall.name,
            email: session.email,
          });
        } catch (err) {
          logger.error('Failed to persist pending tool call', err, {
            event: 'pending_tool_save_failed',
            avatarId: avatar.id,
            toolCallId: result.pendingToolCall.id,
            email: session.email,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }
    }

    // Track message usage against entitlement quota
    if (avatar?.id) {
      incrementUsage(avatar.id, 'messagesProcessed').catch(() => {});
    }

    const responsePayload = {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: result.response, history: result.history, media: result.media,
        pendingJobs: result.pendingJobs, pendingToolCall: result.pendingToolCall, avatarUpdates: result.avatarUpdates, taskActions: result.taskActions,
        rateLimit: publicRateLimitInfo ? { remaining: publicRateLimitInfo.remaining - 1, limit: publicRateLimitInfo.limit, isOrbHolder: publicRateLimitInfo.isOrbHolder } : undefined,
      }),
    };
    if (idempotencyKey) await chatIdempotencyStore.update(idempotencyKey, responsePayload);
    return responsePayload;
  } catch (error) {
    const mapped = mapAdminChatHandlerError(error);
    const errorMetrics = createRuntimeMetricsLogger('AdminChat');
    errorMetrics.incrementCounter('ChatErrors');
    errorMetrics.setProperty('Outcome', 'error');
    errorMetrics.flush();
    logger.error('Handler error', error, { event: 'handler_error', requestId: event.requestContext.requestId, statusCode: mapped.statusCode });
    recordError({ error: mapped.errorMessage, stack: error instanceof Error ? error.stack : undefined, subsystem: 'chat', category: 'handler_error', requestId: event.requestContext.requestId }).catch(() => {});
    if (idempotencyKey) await chatIdempotencyStore.remove(idempotencyKey).catch(() => {});
    return {
      statusCode: mapped.statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: mapped.publicError, message: mapped.errorMessage }),
    };
  }
}

/**
 * Resume the admin chat conversation after the UI submits a tool result.
 */
export async function resumeChatAfterToolResult(params: {
  avatarId: string;
  toolCallId: string;
  result: unknown;
  session: UserSession;
}): Promise<ProcessChatResult> {
  return _resumeChatAfterToolResult(params, processChat);
}
