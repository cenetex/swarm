/**
 * Admin Chatbot Handler
 * Conversational interface for setting up avatars with tool use
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  logger,
  // Import shared tool/prompt building from core
  buildDynamicSystemPrompt,
  extractThinking,
  detectEnabledCategories,
  type ToolCategory,
  type ProcessorAvatarConfig,
} from '@swarm/core';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import * as chatHistory from '../services/chat-history.js';
import { createChatJob, createJobId } from '../services/chat-jobs.js';
import { fromChatMessages, hasExecuteFunction, toChatMessage, stepCountIs } from '@openrouter/sdk';
import {
  ChatRequestSchema,
  type AdminChatMessage,
  type ToolResult,
  type UserSession,
} from '../types.js';
import { recordError } from '../services/auto-issues.js';
import { createAvatarAccessChecker } from '../services/chat-access.js';
import { chatIdempotencyStore } from '../services/idempotency.js';
import { createCircuitBreaker } from '@swarm/core';

const llmCircuitBreaker = createCircuitBreaker();
import {
  ToolRegistry,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createMCPServices } from '../services/mcp-adapter.js';
import { isPauseForInputTool } from '../tools/index.js';
import * as avatars from '../services/avatars.js';
import * as voice from '../services/voice.js';
import * as memory from '../services/memory.js';
import { formatDreamForPrompt, getDreamForResponse } from '../services/dreams.js';
import { configureIntegration } from '../services/integrations.js';
import { syncAvatarConfig } from '../services/config-sync.js';
import { resolveChatModel } from '../services/models-registry.js';
import { mapAdminChatHandlerError } from './chat-error-mapping.js';
import { redactMediaUrlsFromText } from '../utils/redact-media-urls.js';
import { getGateStatus } from '../services/nft-gate.js';

// Extracted modules
import {
  LLM_MODEL,
  LLM_MAX_TOKENS,
  LLM_MAX_RETRIES,
  LLM_MAX_STEPS,
  LLM_TOOL_MAX_TOKENS,
  getOpenRouterClient,
  callLlmDirectFallback,
  normalizeUsage,
  logLlmMetrics,
  sleep,
  getRetryDelayMs,
  isRetryableLlmError,
  type LlmUsage,
} from './chat-llm.js';
import {
  sanitizeMessages,
  sanitizeToolError,
  stringifyToolResultForModel,
  buildOpenRouterTools,
  executeUiTool,
  buildModelSelectorPayload,
  buildFeatureTogglePayload,
  buildPendingToolResponse,
  extractMediaFromToolResults,
  toSdkMessages,
  toAdminToolCall,
  type MediaItem,
  type SdkToolCall,
} from './chat-tool-helpers.js';
import {
  checkPublicRateLimit,
  recordPublicRateLimit,
  PUBLIC_RATE_LIMIT_ORB_HOLDERS,
  type PublicRateLimitResult,
} from './chat-rate-limiting.js';
import { resolvePublicAvatarIdFromRequest } from './chat-public-access.js';

const DREAMS_ENABLED = process.env.DREAMS_ENABLED === 'true';

const CHAT_QUEUE_URL = process.env.CHAT_QUEUE_URL;
const sqsClient = CHAT_QUEUE_URL ? new SQSClient({}) : null;

function prefersAsyncResponse(event: APIGatewayProxyEventV2): boolean {
  const prefer = event.headers['prefer'] || event.headers['Prefer'] || '';
  return typeof prefer === 'string' && prefer.toLowerCase().includes('respond-async');
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Context window management - limit messages sent to LLM for efficiency
const MAX_CONTEXT_MESSAGES = parseIntEnv('MAX_CONTEXT_MESSAGES', 20);

interface AvatarContext {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories?: ToolCategory[];
}

/**
 * Build system prompt dynamically based on enabled tool categories
 */
function buildSystemPrompt(avatar?: AvatarContext): string {
  if (avatar) {
    // Use dynamic prompt builder with enabled categories
    const categories = avatar.enabledCategories || [
      // Default categories if not specified
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'
    ];

    const avatarConfig: ProcessorAvatarConfig = {
      avatarId: avatar.id,
      name: avatar.name,
      description: avatar.description,
      persona: avatar.persona,
      enabledCategories: categories,
    };

    return buildDynamicSystemPrompt(avatarConfig, 'admin-ui');
  }

  // Fallback for no avatar context
  return `You are a Swarm avatar assistant. Please select an avatar to chat with.`;
}

function buildModelInput(systemPrompt: string, messages: AdminChatMessage[]) {
  const sanitizedMessages = sanitizeMessages(messages);
  // Limit context to prevent token bloat - keep most recent messages
  const truncatedMessages = sanitizedMessages.slice(-MAX_CONTEXT_MESSAGES);
  if (sanitizedMessages.length > truncatedMessages.length) {
    logger.info('Truncated conversation history for LLM', {
      event: 'history_truncated',
      originalCount: sanitizedMessages.length,
      truncatedCount: truncatedMessages.length,
      maxContextMessages: MAX_CONTEXT_MESSAGES,
    });
  }
  const inputMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...truncatedMessages,
  ];
  
  // JUSTIFIED TYPE ASSERTION:
  // Cast to any to work around OpenRouter SDK's strict internal types.
  // The toSdkMessages function returns the correct structure, but the SDK's
  // fromChatMessages function has overly strict type requirements that don't
  // align with the actual runtime behavior. This has been verified to work correctly.
  // See: packages/admin-api/src/handlers/chat-tool-helpers.ts:457 for toSdkMessages implementation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fromChatMessages(toSdkMessages(inputMessages) as any);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

interface ProcessChatOptions {
  customSystemPrompt?: string;
  attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>;
  model?: string; // Override default LLM model
  maxTokens?: number; // Override default max output tokens
}

/**
 * Process a chat message, executing tools as needed
 */
export async function processChat(
  userMessage: string | null,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  avatar?: AvatarContext,
  options?: ProcessChatOptions
): Promise<{
  response: string;
  history: AdminChatMessage[];
  media?: MediaItem[];
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
  avatarUpdates?: { profileImageUrl?: string; name?: string };
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  const avatarId = avatar?.id;
  const mcpServices = avatarId ? createMCPServices(avatarId, session) : null;
  const toolRegistry = avatarId && mcpServices ? new ToolRegistry() : null;
  if (toolRegistry && mcpServices) {
    registerAllTools(toolRegistry, mcpServices);
  }
  const toolContext: ToolContext | null = avatarId ? {
    avatarId,
    platform: 'admin-ui',
    userId: session.userId,
    session: { email: session.email, isAdmin: session.isAdmin },
  } : null;
  const tools = toolRegistry && toolContext
    ? await buildOpenRouterTools(toolRegistry, toolContext, {
        enabledCategories: avatar?.enabledCategories,
      })
    : [];

  // Log tools available for debugging
  logger.info('Tools created', {
    event: 'tools_created',
    avatarId,
    toolCount: tools.length,
    toolNames: tools.map((t: { function?: { name?: string }; name?: string }) => t.function?.name ?? t.name),
  });

  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    ...(userMessage !== null ? [{ role: 'user' as const, content: userMessage }] : []),
  ];

  let response = '';
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }> = [];
  const avatarUpdates: { profileImageUrl?: string; name?: string } = {};

  // Use custom system prompt if provided (for e.g. browser automation avatars)
  let systemPrompt = options?.customSystemPrompt || buildSystemPrompt(avatar);

  // Inject dream context if enabled (adds continuity without response latency impact)
  if (!options?.customSystemPrompt && DREAMS_ENABLED && avatarId && avatar?.persona) {
    try {
      const { dream, isGenerating } = await getDreamForResponse(avatarId, avatar.persona);
      const dreamSection = formatDreamForPrompt(dream);
      if (dreamSection) {
        systemPrompt = dreamSection + systemPrompt;
      }
      logger.info('Dream context evaluated', {
        event: 'dream_context_evaluated',
        avatarId,
        hasDream: Boolean(dream),
        isGenerating,
      });
    } catch (err) {
      logger.warn('Failed to inject dream context', {
        event: 'dream_context_error',
        avatarId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Inject memory context if memory is enabled for this avatar
  if (avatarId && avatar?.enabledCategories?.includes('memory')) {
    try {
      const query = typeof userMessage === 'string' ? userMessage.trim() : '';
      const memoryContext = query.length > 0
        ? await memory.getMemoryContextForQuery(avatarId, query)
        : await memory.getMemoryContext(avatarId);
      if (memoryContext) {
        systemPrompt += `\n\n${memoryContext}`;
        logger.info('Memory context injected', {
          event: 'memory_context_injected',
          avatarId,
          contextLength: memoryContext.length,
          queryAware: query.length > 0,
          queryLength: query.length,
        });
      }
    } catch (err) {
      logger.warn('Failed to get memory context', {
        event: 'memory_context_error',
        avatarId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Auto-transcribe audio attachments (only for real user messages)
  let transcribedText = '';
  if (userMessage !== null && avatarId && options?.attachments) {
    const audioAttachments = options.attachments.filter(a => a.type === 'audio');
    if (audioAttachments.length > 0) {
      logger.info('Auto-transcribing audio attachments', {
        event: 'audio_transcription_start',
        avatarId,
        audioCount: audioAttachments.length,
      });

      for (const audio of audioAttachments) {
        try {
          const transcription = await voice.transcribeAudio({
            avatarId,
            url: audio.data, // Audio data is a URL
          });
          if (transcription.text) {
            transcribedText += `\n\n[Voice message transcription]: "${transcription.text}"`;
            logger.info('Audio transcription successful', {
              event: 'audio_transcription_success',
              avatarId,
              textLength: transcription.text.length,
            });
          }
        } catch (err) {
          logger.warn('Audio transcription failed', {
            event: 'audio_transcription_error',
            avatarId,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
          // Don't block the message if transcription fails
          transcribedText += '\n\n[Voice message received but transcription failed]';
        }
      }
    }
  }

  // Combine original message with transcribed audio
  const messageWithTranscription = userMessage !== null
    ? (transcribedText ? userMessage + transcribedText : userMessage)
    : '';

  // Build the user message content - may include attachments
  let userMessageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> = messageWithTranscription;
  if (userMessage !== null && options?.attachments && options.attachments.length > 0) {
    const imageAttachments = options.attachments.filter(a => a.type === 'image');
    if (imageAttachments.length > 0) {
      userMessageContent = [
        { type: 'text', text: messageWithTranscription },
        ...imageAttachments.map(a => ({
          type: 'image_url' as const,
          image_url: { url: a.data },
        })),
      ];
    }
  }

  // Update the last message with attachments/transcription if present
  const hasModifications = userMessage !== null
    ? (userMessageContent !== messageWithTranscription || transcribedText !== '')
    : false;
  const messagesWithAttachments: AdminChatMessage[] = userMessage === null
    ? messages
    : hasModifications
      ? [
          ...conversationHistory,
          { role: 'user' as const, content: userMessageContent as string },
        ]
      : messages;

  const input = buildModelInput(systemPrompt, messagesWithAttachments);

  // Use provided model or fall back to default
  const effectiveModel = options?.model || LLM_MODEL;
  const maxOutputTokens = clampInt(options?.maxTokens ?? LLM_MAX_TOKENS, 1, 8192);
  const effectiveMaxOutputTokens = tools.length > 0
    ? Math.min(maxOutputTokens, LLM_TOOL_MAX_TOKENS)
    : maxOutputTokens;

  logger.info('LLM request', {
    event: 'llm_request',
    model: effectiveModel,
    messageCount: messages.length,
    toolsIncluded: tools.length > 0,
  });

  // Try SDK first, fallback to direct API if SDK's Zod validation fails.
  // Retries are done ONLY before any tool execution to avoid duplicating side effects.
  let toolCalls: SdkToolCall[] = [];
  let adminToolCalls: ReturnType<typeof toAdminToolCall>[] = [];
  let modelResult: ReturnType<typeof getOpenRouterClient.prototype.callModel> | null = null;
  let usedFallback = false;
  let fallbackResponse = '';
  let lastLlmStart = 0;
  let lastLlmMode: 'sdk' | 'fallback' | null = null;
  let lastFallbackUsage: LlmUsage | undefined;
  let lastFallbackLatency: number | undefined;

  const runLlmAttempt = async (): Promise<void> => {
    if (!llmCircuitBreaker.canExecute()) {
      throw new Error('LLM circuit breaker open');
    }

    toolCalls = [];
    adminToolCalls = [];
    modelResult = null;
    usedFallback = false;
    fallbackResponse = '';
    lastLlmStart = 0;
    lastLlmMode = null;
    lastFallbackUsage = undefined;
    lastFallbackLatency = undefined;

    try {
      try {
        // Tools from the SDK are already in the correct format
        const callStart = Date.now();
        lastLlmStart = callStart;
        lastLlmMode = 'sdk';
        modelResult = getOpenRouterClient().callModel({
          model: effectiveModel,
          input,
          maxOutputTokens: effectiveMaxOutputTokens,
          ...(tools.length > 0 ? { tools, stopWhen: stepCountIs(LLM_MAX_STEPS) } : {}),
        });

        toolCalls = await modelResult.getToolCalls();
        adminToolCalls = toolCalls.map(toAdminToolCall);

        if (toolCalls.length > 0) {
          logLlmMetrics({
            avatarId,
            model: effectiveModel,
            latencyMs: Date.now() - callStart,
            usage: undefined,
            toolCalls: toolCalls.length,
            mode: 'sdk',
          });
        }
      } catch (sdkError) {
        // Check if this is a Zod validation/schema error (SDK uses zod/v4 internally)
        const errorName = sdkError instanceof Error ? sdkError.name : '';
        const errorMessage = sdkError instanceof Error ? sdkError.message : '';
        const isZodError = errorName === 'ZodError' ||
          errorMessage.includes('invalid_type') ||
          errorMessage.includes('Invalid Zod schema');

        if (!isZodError) {
          throw sdkError;
        }

        // Expected: SDK requires Zod v4 schemas but our tools use Zod v3.
        // Pre-sanitized JSON Schema parameters are used by the fallback path.
        logger.info('SDK Zod v3/v4 mismatch, using direct API with pre-sanitized schemas', {
          event: 'sdk_fallback',
          errorName,
          errorMessage: errorMessage.slice(0, 120),
        });

        // Build messages for direct API call
        const apiMessages = [
          { role: 'system', content: systemPrompt },
          ...toSdkMessages(sanitizeMessages(messages)),
        ];

        const fallbackResult = await callLlmDirectFallback(
          effectiveModel,
          apiMessages as Array<{ role: string; content: string }>,
          effectiveMaxOutputTokens,
          tools.length > 0 ? tools : undefined
        );

        usedFallback = true;
        fallbackResponse = fallbackResult.content;
        lastLlmMode = 'fallback';
        lastFallbackUsage = fallbackResult.usage;
        lastFallbackLatency = fallbackResult.latencyMs;

        // Convert fallback tool calls to admin format
        adminToolCalls = fallbackResult.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));

        // Create pseudo-SdkToolCalls for compatibility with existing code
        toolCalls = fallbackResult.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })) as unknown as SdkToolCall[];

        if (toolCalls.length > 0) {
          logLlmMetrics({
            avatarId,
            model: effectiveModel,
            latencyMs: fallbackResult.latencyMs,
            usage: fallbackResult.usage,
            toolCalls: toolCalls.length,
            mode: 'fallback',
          });
        }
      }

      llmCircuitBreaker.recordSuccess();
    } catch (error) {
      llmCircuitBreaker.recordFailure();
      throw error;
    }
  };

  // Attempt loop: retry only when no tool calls were requested.
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      await runLlmAttempt();

      // If the model requested tools, we must proceed without retrying to avoid side effects.
      if (toolCalls.length > 0) {
        break;
      }

      // No tool calls: fetch response now, and retry if empty.
      if (usedFallback) {
        response = fallbackResponse;
        if (toolCalls.length === 0 && lastLlmMode === 'fallback' && typeof lastFallbackLatency === 'number') {
          logLlmMetrics({
            avatarId,
            model: effectiveModel,
            latencyMs: lastFallbackLatency,
            usage: lastFallbackUsage,
            toolCalls: 0,
            mode: 'fallback',
          });
        }
      } else if (modelResult) {
        const finalResponse = await modelResult.getResponse();
        const assistantMessage = toChatMessage(finalResponse);
        response = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
        if (toolCalls.length === 0) {
          const finishReason = (finalResponse as { choices?: Array<{ finish_reason?: string }> })
            ?.choices?.[0]?.finish_reason;
          logLlmMetrics({
            avatarId,
            model: effectiveModel,
            latencyMs: lastLlmStart ? Date.now() - lastLlmStart : 0,
            usage: normalizeUsage((finalResponse as { usage?: Record<string, unknown> }).usage),
            toolCalls: 0,
            finishReason,
            mode: 'sdk',
          });
        }
      }

      if (response) {
        break;
      }

      if (attempt < LLM_MAX_RETRIES) {
        logger.warn('Empty LLM response, retrying', {
          event: 'llm_retry',
          attempt: attempt + 1,
          maxRetries: LLM_MAX_RETRIES,
          avatarId,
          model: effectiveModel,
        });
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }

      // Exhausted retries; keep response empty and handle below.
      break;
    } catch (err) {
      const retryable = isRetryableLlmError(err);
      if (retryable && attempt < LLM_MAX_RETRIES) {
        logger.warn('LLM call failed, retrying', {
          event: 'llm_retry_error',
          attempt: attempt + 1,
          maxRetries: LLM_MAX_RETRIES,
          avatarId,
          model: effectiveModel,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }

      // Record issue when we ran out of retries for a retryable failure.
      if (retryable) {
        recordError({
          error: err instanceof Error ? err.message : 'LLM call failed after retries',
          stack: err instanceof Error ? err.stack : undefined,
          subsystem: 'llm',
          category: 'llm_call_failed',
          avatarId,
          context: {
            attempts: attempt + 1,
            model: effectiveModel,
          },
        }).catch(() => {
          // Ignore recording failures
        });
      }

      throw err;
    }
  }

  logger.info('LLM response', {
    event: 'llm_response',
    hasToolCalls: toolCalls.length > 0,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map(tc => String(tc.name)),
    usedFallback,
  });

  // Helper to safely extract tool call args as Record<string, unknown>
  const getToolArgs = (tc: SdkToolCall): Record<string, unknown> => {
    if (tc.arguments && typeof tc.arguments === 'object') {
      return tc.arguments as Record<string, unknown>;
    }
    return {};
  };

  const pauseToolCall = toolCalls.find(tc => isPauseForInputTool(String(tc.name), getToolArgs(tc)));
  if (pauseToolCall && mcpServices && avatarId) {
    let pendingArgs = getToolArgs(pauseToolCall);
    const toolName = String(pauseToolCall.name);
    let uiToolName = toolName;
    try {
      if (toolName === 'request_model_selection') {
        const family = typeof pendingArgs.family === 'string'
          ? pendingArgs.family
          : typeof pendingArgs.preferredFamily === 'string'
            ? pendingArgs.preferredFamily
            : undefined;
        pendingArgs = await buildModelSelectorPayload(mcpServices.models, avatarId, family);
      } else if (toolName === 'request_feature_toggle') {
        pendingArgs = await buildFeatureTogglePayload(avatarId, pendingArgs);
      } else if (toolName === 'request_secret') {
        // Legacy/low-level secret prompts can be confusing for integrations because we also have
        // configure_integration panels. If the requested secret matches a known integration,
        // normalize to configure_integration to keep UX consistent.
        const secretType = typeof pendingArgs.secretType === 'string'
          ? pendingArgs.secretType
          : typeof pendingArgs.secretKey === 'string'
            ? pendingArgs.secretKey
            : undefined;

        const secretTypeToIntegration: Record<string, 'telegram' | 'twitter' | 'discord' | 'replicate' | 'openai' | 'anthropic' | 'openrouter'> = {
          telegram_bot_token: 'telegram',
          telegram_webhook_secret: 'telegram',
          twitter_api_key: 'twitter',
          twitter_api_secret: 'twitter',
          twitter_access_token: 'twitter',
          twitter_access_secret: 'twitter',
          discord_bot_token: 'discord',
          replicate_api_key: 'replicate',
          replicate_api_token: 'replicate',
          openai_api_key: 'openai',
          anthropic_api_key: 'anthropic',
          openrouter_api_key: 'openrouter',
        };

        const integration = secretType ? secretTypeToIntegration[secretType] : undefined;
        if (integration) {
          pendingArgs = {
            integration,
            reason: typeof pendingArgs.reason === 'string' ? pendingArgs.reason : undefined,
          };
          uiToolName = 'configure_integration';
        }
      } else if (toolName === 'request_twitter_connection' || toolName === 'twitter_request_integration') {
        pendingArgs = {
          integration: 'twitter',
          reason: typeof pendingArgs.message === 'string' ? pendingArgs.message : undefined,
          ...pendingArgs,
        };
        uiToolName = 'configure_integration';
      } else if (
        toolName === 'get_profile_upload_url' ||
        toolName === 'get_reference_image_upload_url' ||
        toolName === 'get_character_reference_upload_url' ||
        toolName === 'set_profile_image' ||
        toolName === 'set_character_reference'
      ) {
        pendingArgs = await executeUiTool(toolName, pendingArgs, tools);
      }
    } catch (error) {
      logger.error('Failed to build pending tool payload', error, {
        toolName,
      });
    }

    pendingToolCall = {
      id: String(pauseToolCall.id),
      name: uiToolName,
      arguments: pendingArgs,
    };

    response = buildPendingToolResponse(uiToolName, pendingArgs);
    const shouldOverrideToolCall = uiToolName !== toolName;
    const toolCallsForHistory = shouldOverrideToolCall
      ? [
          {
            id: pendingToolCall.id,
            type: 'function' as const,
            function: {
              name: uiToolName,
              arguments: JSON.stringify(pendingArgs),
            },
          },
        ]
      : adminToolCalls.length > 0
        ? adminToolCalls
        : [toAdminToolCall(pauseToolCall)];
    messages.push({
      role: 'assistant',
      content: response,
      tool_calls: toolCallsForHistory,
    });

    return {
      response,
      history: messages,
      pendingToolCall,
    };
  }

  const toolResults: ToolResult[] = [];

  // When using fallback, we need to manually execute tools since we don't have the SDK's streaming interface
  if (toolCalls.length > 0 && usedFallback) {
    const MAX_FALLBACK_TOOL_STEPS = LLM_MAX_STEPS;
    let fallbackStep = 0;
    let currentToolCalls = toolCalls;
    let currentAdminToolCalls = adminToolCalls;
    let currentAssistantContent = fallbackResponse;

    // Build a base message list in OpenAI format for the fallback calls.
    // This is separate from `messages` (AdminChatMessage[]) to avoid type mismatches.
    const baseApiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
    for (const msg of sanitizeMessages(messagesWithAttachments)) {
      if (msg.role === 'tool') {
        baseApiMessages.push({
          role: 'tool',
          tool_call_id: (msg as ToolResult).tool_call_id,
          content: msg.content,
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        baseApiMessages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });
        continue;
      }

      baseApiMessages.push({ role: msg.role, content: msg.content });
    }

    // Tool loop: execute tools, then call the model again with tool results, repeating until no tool calls.
    while (currentToolCalls.length > 0 && fallbackStep < MAX_FALLBACK_TOOL_STEPS) {
      fallbackStep++;
      logger.info('Executing tools manually (fallback mode)', {
        fallbackStep,
        toolCallCount: currentToolCalls.length,
        toolNames: currentToolCalls.map(tc => String(tc.name)),
      });

      // Add an assistant tool-call message and corresponding tool results to the API message list.
      baseApiMessages.push({
        role: 'assistant',
        content: currentAssistantContent || '',
        tool_calls: currentAdminToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });

      for (const toolCall of currentToolCalls) {
        const toolName = String(toolCall.name);
        const toolArgs = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
          ? toolCall.arguments as Record<string, unknown>
          : {};

        try {
          const tool = tools.find(t => t.function.name === toolName);
          if (tool && hasExecuteFunction(tool)) {
            logger.info('Executing tool', { toolName, toolCallId: toolCall.id, fallbackStep });
            const result = await tool.function.execute(toolArgs);
            const resultStr = stringifyToolResultForModel(result);
            toolResults.push({
              tool_call_id: String(toolCall.id),
              role: 'tool',
              content: resultStr,
            });
            baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: resultStr });
            logger.info('Tool executed successfully', {
              toolName,
              toolCallId: toolCall.id,
              fallbackStep,
              resultLength: resultStr.length,
            });
          } else {
            logger.warn('Tool not executable', {
              toolName,
              toolCallId: toolCall.id,
              fallbackStep,
              hasExecute: !!tool && hasExecuteFunction(tool),
            });
            const errStr = JSON.stringify({ error: `Tool ${toolName} is not executable` });
            toolResults.push({
              tool_call_id: String(toolCall.id),
              role: 'tool',
              content: errStr,
            });
            baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: errStr });
          }
        } catch (error) {
          logger.error('Tool execution failed', error, { toolName, toolCallId: toolCall.id, fallbackStep });
          const errStr = JSON.stringify({ error: sanitizeToolError(error instanceof Error ? error.message : 'Tool execution failed') });
          toolResults.push({
            tool_call_id: String(toolCall.id),
            role: 'tool',
            content: errStr,
          });
          baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: errStr });
        }
      }

      logger.info('Manual tool execution complete (fallback mode)', {
        fallbackStep,
        toolResultCount: toolResults.length,
      });

      // Call the model again with tool results to get either a final response or more tool calls.
      const next = await callLlmDirectFallback(
        effectiveModel,
        baseApiMessages as unknown as Array<{ role: string; content: string }>,
        effectiveMaxOutputTokens,
        tools.length > 0 ? tools : undefined
      );

      logLlmMetrics({
        avatarId,
        model: effectiveModel,
        latencyMs: next.latencyMs,
        usage: next.usage,
        toolCalls: next.toolCalls.length,
        mode: 'fallback',
        step: fallbackStep,
      });

      currentAssistantContent = next.content;
      currentToolCalls = next.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })) as unknown as SdkToolCall[];
      currentAdminToolCalls = next.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));

      // If the fallback model requested a manual/pause tool, stop and return a pending tool call.
      const nextPauseTool = currentToolCalls.find(tc => isPauseForInputTool(String(tc.name), getToolArgs(tc)));
      if (nextPauseTool && mcpServices && avatarId) {
        pendingToolCall = {
          id: String(nextPauseTool.id),
          name: String(nextPauseTool.name),
          arguments: getToolArgs(nextPauseTool),
        };

        response = buildPendingToolResponse(pendingToolCall.name, pendingToolCall.arguments);
        messages.push({
          role: 'assistant',
          content: response,
          tool_calls: [toAdminToolCall(nextPauseTool)],
        });

        return {
          response,
          history: messages,
          pendingToolCall,
        };
      }

      // No more tool calls -> we have a final response.
      if (currentToolCalls.length === 0) {
        response = currentAssistantContent;
      }
    }
  }

  // When using SDK, process the tool execution stream
  if (toolCalls.length > 0 && modelResult && !usedFallback) {
    logger.info('Processing tool execution stream', { toolCallCount: toolCalls.length });
    let streamItemCount = 0;
    for await (const item of modelResult.getNewMessagesStream()) {
      streamItemCount++;
      logger.info('Stream item received', {
        itemType: typeof item === 'object' && item !== null && 'type' in item ? (item as { type: string }).type : 'unknown',
        hasItem: !!item,
      });
      if (item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output') {
        const outputItem = item as { callId?: string; output?: string };
        if (outputItem.callId && typeof outputItem.output === 'string') {
          toolResults.push({
            tool_call_id: outputItem.callId,
            role: 'tool',
            content: outputItem.output,
          });
        }
      }
    }
    logger.info('Tool execution stream complete', { streamItemCount, toolResultCount: toolResults.length });
  }

  // Get final response - either from SDK or fallback.
  // Note: for the no-tool-call path, this may already be populated by the retry loop above.
  if (!response) {
    if (usedFallback) {
      response = fallbackResponse;
    } else if (modelResult) {
      const finalResponse = await modelResult.getResponse();
      const assistantMessage = toChatMessage(finalResponse);
      response = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
    }
  }

  if (toolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: adminToolCalls,
    });
    for (const result of toolResults) {
      messages.push(result as AdminChatMessage);
    }
  }

  // If the user asked for model config, ensure we surface it even if the fallback
  // model response is empty or unhelpful.
  if (toolCalls.length > 0 && toolResults.length > 0) {
    const toolCallNameById = new Map(toolCalls.map(tc => [String(tc.id), String(tc.name)]));
    const modelConfigResult = toolResults.find(r => toolCallNameById.get(String(r.tool_call_id)) === 'get_my_model_config');
    if (modelConfigResult?.content && typeof modelConfigResult.content === 'string') {
      try {
        const parsed = JSON.parse(modelConfigResult.content) as { success?: boolean; data?: unknown };
        if (parsed?.success === true && parsed.data && typeof parsed.data === 'object') {
          const data = parsed.data as Record<string, unknown>;
          const model = typeof data.model === 'string' ? data.model : undefined;
          const temperature = typeof data.temperature === 'number' ? data.temperature : undefined;
          const maxTokens = typeof data.maxTokens === 'number' ? data.maxTokens : undefined;
          const provider = typeof data.provider === 'string' ? data.provider : undefined;

          const summaryParts = [
            model ? `Model: ${model}` : null,
            provider ? `Provider: ${provider}` : null,
            typeof temperature === 'number' ? `Temperature: ${temperature}` : null,
            typeof maxTokens === 'number' ? `Max tokens: ${maxTokens}` : null,
          ].filter((p): p is string => !!p);

          if (summaryParts.length > 0) {
            const summary = summaryParts.join('\n');
            const responseIsEmptyOrApology = !response || response.includes("I apologize, but I couldn't generate a response");
            if (responseIsEmptyOrApology) {
              response = summary;
            } else {
              const hasModelHint = /\bmodel\b|temperature|max\s*tokens/i.test(response);
              if (!hasModelHint) {
                response = `${response}\n\n${summary}`;
              }
            }
          }
        }
      } catch {
        // Ignore JSON parsing failures
      }
    }
  }

  if (!response) {
    logger.error('LLM response empty after all retries', {
      event: 'llm_empty_after_retries',
      attempts: LLM_MAX_RETRIES + 1,
      avatarId,
      model: effectiveModel,
    });

    recordError({
      error: 'LLM returned empty response after all retries',
      subsystem: 'llm',
      category: 'llm_empty_response',
      avatarId,
      context: {
        attempts: LLM_MAX_RETRIES + 1,
        model: effectiveModel,
        messageLength: (userMessage ?? '').length,
      },
    }).catch(() => {
      // Ignore recording failures
    });

    response = 'I apologize, but I couldn\'t generate a response. Please try again.';
  }

  // Extract and strip <thinking> tags from the user-visible response.
  // Keep extracted blocks separately for admin UI introspection.
  let extractedThinking: string[] | undefined;
  if (typeof response === 'string') {
    const { cleanContent, thinkingBlocks } = extractThinking(response);
    response = cleanContent;
    const cleanedThinking = thinkingBlocks
      .map((t) => redactMediaUrlsFromText(t).trim())
      .filter((t) => t.length > 0);
    extractedThinking = cleanedThinking.length > 0 ? cleanedThinking : undefined;
  }

  // Filter out stale "Please connect your X/Twitter account:" text from LLM responses
  // This text can appear when the model repeats from chat history after a connection attempt
  if (typeof response === 'string') {
    response = response.replace(/please\s+connect\s+your\s+(x\/?twitter|twitter\/?x)\s+account\s*:/gi, '').trim();
  }

  // Avoid leaking raw CloudFront links into chat bubbles. Media should be conveyed
  // via structured attachments (response.media) instead of raw URLs.
  if (typeof response === 'string') {
    response = redactMediaUrlsFromText(response);
  }

  messages.push({
    role: 'assistant',
    content: response,
    ...(extractedThinking ? { thinking: extractedThinking } : {}),
  });

  const toolCallNames = new Map(toolCalls.map(tc => [tc.id, tc.name]));
  for (const result of toolResults) {
    logger.info('Tool result', { toolCallId: result.tool_call_id, contentLength: result.content?.length || 0 });

    if (result.content && typeof result.content === 'string') {
      try {
        const parsed = JSON.parse(result.content);
        const toolName = toolCallNames.get(result.tool_call_id);
        if (parsed._pendingJob) {
          pendingJobs.push({
            jobId: parsed._pendingJob.jobId,
            type: parsed._pendingJob.type || 'image',
            prompt: parsed._pendingJob.prompt,
            purpose: parsed._pendingJob.purpose,
          });
        } else if (parsed.jobId && (parsed.status === 'pending' || parsed.status === 'processing')) {
          pendingJobs.push({
            jobId: parsed.jobId,
            type: toolName === 'generate_video'
              ? 'video'
              : toolName === 'generate_sticker'
                ? 'sticker'
                : 'image',
            prompt: parsed.prompt,
          });
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

  const mediaFromResults = extractMediaFromToolResults(toolResults);
  logger.info('Extracted media items from tool results', { count: mediaFromResults.length });
  allMedia.push(...mediaFromResults);

  // Check for profile image updates and name changes from tool results
  for (const result of toolResults) {
    const toolName = toolCallNames.get(result.tool_call_id);
    if (result.content && typeof result.content === 'string') {
      try {
        const parsed = JSON.parse(result.content);

        // Profile image updates
        if (toolName === 'set_profile_image' || toolName === 'save_uploaded_profile_image') {
          if (parsed.success && (parsed.data?.url || parsed.url || parsed.resultUrl)) {
            avatarUpdates.profileImageUrl = parsed.data?.url || parsed.url || parsed.resultUrl;
            logger.info('Profile image updated', { profileImageUrl: avatarUpdates.profileImageUrl });
          }
        }

        // Name updates from update_my_profile
        if (toolName === 'update_my_profile') {
          if (parsed.success && parsed.data?.updated?.includes('name')) {
            // Fetch the updated avatar to get the new name
            if (avatarId) {
              const updatedAgent = await avatars.getAvatar(avatarId);
              if (updatedAgent?.name) {
                avatarUpdates.name = updatedAgent.name;
                logger.info('Avatar name updated', { name: avatarUpdates.name });
              }
            }
          }
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

  logger.info('Final response', {
    mediaCount: allMedia.length,
    pendingJobCount: pendingJobs.length,
    hasPendingToolCall: !!pendingToolCall,
    pendingToolCallName: pendingToolCall?.name,
  });
  return {
    response,
    history: messages,
    media: allMedia.length > 0 ? allMedia : undefined,
    pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
    avatarUpdates: (avatarUpdates.profileImageUrl || avatarUpdates.name) ? avatarUpdates : undefined,
    pendingToolCall,
  };
}

/**
 * Lambda handler for chat API.
 *
 * Admins can chat with any avatar; non-admin wallet users can chat only with
 * avatars they own.
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  // Lightweight health/info endpoint for humans and uptime checks.
  // Note: This runs before auth so opening https://api-*/ in a browser doesn't
  // misleadingly show an admin-only error.
  const rawPath = event.rawPath || '/';
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  if (method === 'GET' && (path === '/' || path === '/health' || path === '/healthz')) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        service: 'swarm-admin-api',
        path,
        hint: 'Try GET /auth/me (cookie auth) or POST /auth/wallet/verify (login)',
      }),
    };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;

    // Set logging context for this handler
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
    });

    // GET /chat?avatarId=xxx - Retrieve chat history
    if (method === 'GET') {
      const avatarId = event.queryStringParameters?.avatarId;
      const accessError = await ensureAvatarAccess(avatarId);
      if (accessError) return accessError;
      const history = await chatHistory.getChatHistory(session, avatarId);

      const cleanedHistory = history.map((msg) => {
        if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;

        const existingThinking = Array.isArray((msg as unknown as { thinking?: unknown }).thinking)
          ? ((msg as unknown as { thinking?: string[] }).thinking ?? [])
          : [];

        const { cleanContent, thinkingBlocks } = extractThinking(msg.content);
        const mergedThinking = [...existingThinking, ...thinkingBlocks]
          .map((t) => redactMediaUrlsFromText(String(t)).trim())
          .filter((t) => t.length > 0);

        return {
          ...msg,
          content: cleanContent,
          ...(mergedThinking.length > 0 ? { thinking: mergedThinking } : {}),
        };
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: cleanedHistory }),
      };
    }

    // DELETE /chat?avatarId=xxx - Clear chat history
    if (method === 'DELETE') {
      const avatarId = event.queryStringParameters?.avatarId;
      const accessError = await ensureAvatarAccess(avatarId);
      if (accessError) return accessError;
      await chatHistory.clearChatHistory(session, avatarId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    // POST /chat/message - Append a system message to chat history
    // Used for status updates (OAuth success, errors, etc.) that both AI and users should see
    if (method === 'POST' && path === '/chat/message') {
      const body = parseJsonBody<{
        avatarId?: unknown;
        message?: {
          role?: unknown;
          content?: unknown;
        };
      }>(event);
      const { avatarId, message } = body;

      if (!avatarId || typeof avatarId !== 'string') {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId is required' }),
        };
      }

      const role: 'assistant' | 'user' | null =
        message?.role === 'assistant' || message?.role === 'user'
          ? message.role
          : null;
      const content = typeof message?.content === 'string' ? message.content : null;

      if (!role || !content) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'message with role (assistant|user) and content is required' }),
        };
      }

      const accessError = await ensureAvatarAccess(avatarId);
      if (accessError) return accessError;

      const history = await chatHistory.appendSystemMessage(session, avatarId, {
        role,
        content,
      });

      logger.info('System message appended', {
        event: 'system_message_appended',
        avatarId,
        role,
        contentLength: content.length,
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, history }),
      };
    }

    // POST /chat - Send a message
    // Parse and validate request body
    const requestBody = parseJsonBody<Record<string, unknown>>(event);
    const parseResult = ChatRequestSchema.safeParse(requestBody);
    if (!parseResult.success) {
      logger.error('Validation error', undefined, {
        event: 'validation_error',
        avatarId: (requestBody.avatar as { id?: string } | undefined)?.id,
        requestId,
        errors: parseResult.error.errors,
        bodyPreview: event.body?.substring(0, 500),
      });
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid request',
          details: parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        }),
      };
    }
    const { message, history, avatar, systemPrompt: customSystemPrompt, attachments, model } = parseResult.data;

    const idempotencyKey = event.headers['idempotency-key'] || event.headers['Idempotency-Key'];
    if (idempotencyKey) {
      // Check for a previously completed result
      const cached = await chatIdempotencyStore.get(idempotencyKey) as APIGatewayProxyResultV2 | null;
      if (cached) {
        return cached;
      }
      // Atomically claim the key before doing work to prevent concurrent execution
      const claimed = await chatIdempotencyStore.set(idempotencyKey, null);
      if (!claimed) {
        // Another invocation already claimed this key and is processing
        return {
          statusCode: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Duplicate request is already being processed' }),
        };
      }
    }

    const accessError = await ensureAvatarAccess(avatar?.id);
    if (accessError) return accessError;

    // Apply rate limiting for public access mode (daily limits based on Orb ownership)
    let publicRateLimitInfo: PublicRateLimitResult | null = null;
    if (publicAccess && avatar?.id && session.userId) {
      // Check if user holds an Orb NFT (determines rate limit tier)
      let hasOrb = false;
      try {
        const gateStatus = await getGateStatus(session.userId);
        hasOrb = gateStatus.nftsHeld > 0;
      } catch (error) {
        // On error, assume no Orb (default rate limit)
        logger.warn('Failed to check Orb ownership for rate limiting', {
          subsystem: 'chat',
          userId: session.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const rateLimitStatus = await checkPublicRateLimit(session.userId, avatar.id, hasOrb);
      publicRateLimitInfo = rateLimitStatus;

      if (rateLimitStatus.limited) {
        const limitMessage = hasOrb
          ? `Daily limit of ${rateLimitStatus.limit} messages reached. Try again tomorrow.`
          : `Daily limit of ${rateLimitStatus.limit} messages reached. Hold an Orb NFT for ${PUBLIC_RATE_LIMIT_ORB_HOLDERS} messages/day.`;

        logger.info('Rate limited public chat request', {
          event: 'rate_limited',
          subsystem: 'chat',
          avatarId: avatar.id,
          userId: session.userId,
          retryAfter: rateLimitStatus.retryAfter,
          hasOrb,
          limit: rateLimitStatus.limit,
        });
        return {
          statusCode: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(rateLimitStatus.retryAfter || 3600),
          },
          body: JSON.stringify({
            error: limitMessage,
            retryAfter: rateLimitStatus.retryAfter,
            remaining: 0,
            limit: rateLimitStatus.limit,
            isOrbHolder: hasOrb,
          }),
        };
      }
      // Record the message for rate limiting (fire and forget)
      void recordPublicRateLimit(session.userId, avatar.id);
    }

    const avatarRecord = avatar?.id ? await avatars.getAvatar(avatar.id) : null;
    const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
    // Get enabled toolsets from mcpConfig, defaulting to voice enabled
    const mcpConfig = avatarRecord?.mcpConfig;
    const enabledToolsets = mcpConfig?.enabledToolsets || [];
    const enabledCategories = avatarRecord
      ? detectEnabledCategories({
          // Voice enabled by default (unless env var disables it)
          voice: voiceEnabled,
          // Memory enabled if in mcpConfig.enabledToolsets
          memory: enabledToolsets.includes('memory'),
          // Platform toolsets enabled based on platform config
          telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
          twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
          discord: Boolean(avatarRecord.platforms?.discord?.enabled),
          // NFT tools enabled by default
          nft: true,
          // Property requires explicit opt-in via mcpConfig
          property: enabledToolsets.includes('property'),
          // Moltbook requires explicit opt-in via mcpConfig
          moltbook: enabledToolsets.includes('moltbook'),
        })
      : undefined;
    const avatarContext = avatar ? {
      id: avatar.id,
      name: avatarRecord?.name ?? avatar.name,
      description: avatarRecord?.description ?? avatar.description,
      persona: avatarRecord?.persona ?? avatar.persona,
      enabledCategories,
    } : undefined;

    // Log request entry
    logger.info('Request received', {
      event: 'request_received',
      avatarId: avatar?.id,
      requestId,
      messageLength: message.length,
      historyLength: history.length,
      hasCustomPrompt: Boolean(customSystemPrompt),
      attachmentCount: attachments?.length || 0,
    });

    // Process the chat with avatar context
    const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
    const resolvedModel = resolveChatModel({
      requestModel: model,
      avatarModel: avatarRecord?.llmConfig?.model,
      defaultModel: LLM_MODEL,
    });

    // Prefer async response when configured to avoid API Gateway/CloudFront timeouts.
    if (prefersAsyncResponse(event) && CHAT_QUEUE_URL && sqsClient) {
      const jobId = createJobId();
      const jobPrompt = message.length > 280 ? `${message.slice(0, 277)}...` : message;

      await createChatJob({
        jobId,
        avatarId: avatar?.id ?? 'unknown',
        type: 'chat',
        prompt: jobPrompt,
        session: {
          userId: session.userId,
          email: session.email,
          isAdmin: session.isAdmin,
        },
        request: {
          message,
          history,
          // Persist enabledCategories so the worker uses the same tool gating as the sync path.
          avatar: avatarContext
            ? {
                id: avatarContext.id,
                name: avatarContext.name,
                description: avatarContext.description,
                persona: avatarContext.persona,
                enabledCategories: avatarContext.enabledCategories,
              }
            : undefined,
          sender: parseResult.data.sender,
          systemPrompt: customSystemPrompt,
          attachments,
          model: resolvedModel,
        },
      });

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: CHAT_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId }),
      }));

      return {
        statusCode: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'pending' }),
      };
    }

    const result = await processChat(message, history, session, avatarContext, {
      customSystemPrompt,
      attachments,
      model: resolvedModel,
      maxTokens: typeof avatarMaxTokens === 'number' ? avatarMaxTokens : undefined,
    });

    // Save the updated history to DynamoDB for cross-device sync
    await chatHistory.saveChatHistory(session, result.history, avatar?.id);

    const responsePayload = {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: result.response,
        history: result.history,
        // Include media generated during this response
        media: result.media,
        // Include pending jobs for async generation (image/video)
        pendingJobs: result.pendingJobs,
        // Include pending tool call if one needs user input
        pendingToolCall: result.pendingToolCall,
        // Include avatar updates (e.g., profile image changes)
        avatarUpdates: result.avatarUpdates,
        // Include rate limit info for public access mode (limited mode indicator)
        rateLimit: publicRateLimitInfo ? {
          remaining: publicRateLimitInfo.remaining - 1, // Subtract 1 for current message
          limit: publicRateLimitInfo.limit,
          isOrbHolder: publicRateLimitInfo.isOrbHolder,
        } : undefined,
      }),
    };

    if (idempotencyKey) {
      await chatIdempotencyStore.update(idempotencyKey, responsePayload);
    }

    return responsePayload;
  } catch (error) {
    const errorStack = error instanceof Error ? error.stack : undefined;
    const mapped = mapAdminChatHandlerError(error);
    const statusCode = mapped.statusCode;
    const errorMessage = mapped.errorMessage;

    logger.error('Handler error', error, {
      event: 'handler_error',
      requestId: event.requestContext.requestId,
      statusCode,
    });

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'chat',
      category: 'handler_error',
      requestId: event.requestContext.requestId,
    }).catch(() => {
      // Ignore recording failures
    });

    return {
      statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: mapped.publicError,
        message: errorMessage,
      }),
    };
  }
}

/**
 * Resume the admin chat conversation after the UI submits a tool result.
 * This appends a proper `role: tool` message (with `tool_call_id`) and lets the model continue.
 */
export async function resumeChatAfterToolResult(params: {
  avatarId: string;
  toolCallId: string;
  result: unknown;
  session: UserSession;
}): Promise<{
  response: string;
  history: AdminChatMessage[];
  media?: MediaItem[];
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
  avatarUpdates?: { profileImageUrl?: string; name?: string };
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  const { avatarId, toolCallId, result, session } = params;

  const avatarRecord = await avatars.getAvatar(avatarId);
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const mcpConfig = avatarRecord?.mcpConfig;
  const enabledToolsets = mcpConfig?.enabledToolsets || [];
  const enabledCategories = avatarRecord
    ? detectEnabledCategories({
        voice: voiceEnabled,
        memory: enabledToolsets.includes('memory'),
        telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
        twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
        discord: Boolean(avatarRecord.platforms?.discord?.enabled),
        nft: true,
        property: enabledToolsets.includes('property'),
        moltbook: enabledToolsets.includes('moltbook'),
      })
    : undefined;
  const avatarContext: AvatarContext | undefined = avatarRecord
    ? {
        id: avatarId,
        name: avatarRecord.name,
        description: avatarRecord.description,
        persona: avatarRecord.persona,
        enabledCategories,
      }
    : { id: avatarId, enabledCategories };

  const history = await chatHistory.getChatHistory(session, avatarId);

  const hasMatchingToolCall = history.some(m =>
    m.role === 'assistant' &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.some(tc => tc.id === toolCallId)
  );
  if (!hasMatchingToolCall) {
    throw new Error(`Unknown or expired toolCallId: ${toolCallId}`);
  }

  // Handle configure_integration results - persist models and settings to DynamoDB
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    if (resultObj.configured === true && typeof resultObj.integration === 'string') {
      const integration = resultObj.integration as 'replicate' | 'openai' | 'anthropic' | 'openrouter' | 'telegram' | 'twitter' | 'discord' | 'solana' | 'ethereum' | 'web';
      const useGlobalKey = typeof resultObj.useGlobalKey === 'boolean' ? resultObj.useGlobalKey : undefined;
      const models = resultObj.models && typeof resultObj.models === 'object'
        ? resultObj.models as Record<string, string>
        : undefined;

      try {
        await configureIntegration({
          avatarId,
          integration,
          enabled: true,
          useGlobalKey,
          models,
          session,
        });
        console.log(`[resumeChatAfterToolResult] Saved ${integration} config for avatar ${avatarId}`);

        // Sync to STATE_TABLE so handlers pick up the new config
        const updatedAvatar = await avatars.getAvatar(avatarId);
        if (updatedAvatar) {
          await syncAvatarConfig(updatedAvatar);
          console.log(`[resumeChatAfterToolResult] Synced config to STATE_TABLE for avatar ${avatarId}`);
        }
      } catch (err) {
        console.error(`[resumeChatAfterToolResult] Failed to save ${integration} config:`, err instanceof Error ? err.message : 'Unknown error');
        // Don't throw - allow the conversation to continue even if config save fails
      }
    }
  }

  const toolContent = typeof result === 'string' ? result : JSON.stringify(result ?? {});
  const nextHistory: AdminChatMessage[] = [
    ...history,
    {
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent,
    } as ToolResult,
  ];

  const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
  const resolvedModel = resolveChatModel({
    requestModel: undefined,
    avatarModel: avatarRecord?.llmConfig?.model,
    defaultModel: LLM_MODEL,
  });
  const chatResult = await processChat(null, nextHistory, session, avatarContext, {
    model: resolvedModel,
    maxTokens: typeof avatarMaxTokens === 'number' ? avatarMaxTokens : undefined,
  });

  await chatHistory.saveChatHistory(session, chatResult.history, avatarId);
  return chatResult;
}
