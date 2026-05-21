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
  createGallerySaver,
  createPresenceService,
  createRuntimeMetricsLogger,
  getRecentMessages as getSharedRoomRecentMessages,
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
  type ResponseTrigger,
  type PresenceService,
  type LLMConfig,
  type SharedRoomMessage,
  type TurnCandidate,
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
  isMemoryWriteAllowed,
} from '../services/entitlement-enforcement.js';
import { ensureReplicateKey } from '../utils/system-replicate-key.js';
import { ensureOpenRouterKey } from '../utils/system-openrouter-key.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { createRuntimeBrainService } from '../services/brain.js';
import { reserveResponseInChannelHistory } from './response-history.js';

// Extracted modules
import { callLLM, stripAvatarNamePrefix, type LLMMessage } from './llm-client.js';
import { maybeTranscribeAudio } from './tool-executor.js';
import { executeToolLoop, buildResponseFromToolLoop, type ToolLoopResult } from './tool-loop.js';
import { buildSystemPrompt, formatBrainMemoryContext } from './context-builder.js';
import { extractMediaContext, buildUserMessageContent, type MediaExtractionConfig } from './media-extractor.js';
import type { ChatWorkerMessage } from './chat-worker.js';
import { createTypingSender } from './typing-indicator.js';
import {
  registerDiscordRoomMetaResolver,
  registerTelegramRoomMetaResolver,
  runRoomCoordinator,
} from './room-coordinator-runner.js';
import { isSharedRoom } from '../services/room-ingress.js';

const REPLY_CONTEXT_MAX_LENGTH = 200;
const DEFAULT_GROUP_RESPONSE_DEADLINE_MS = 10_000;

type ResponseLlmPolicy = {
  isLatencyBoundGroup: boolean;
  llmConfig: LLMConfig;
  deadlineMs?: number;
  useFastModel: boolean;
  enableTools: boolean;
};

type MessageStalenessCandidate = {
  messageId?: string;
  timestamp?: number;
};

type GroupActivityStaleness = {
  stale: boolean;
  source?: 'channel-state' | 'shared-room';
  latestMessageId?: string;
  latestTimestamp?: number;
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isLatencyBoundGroupConversation(
  envelope: Pick<SwarmEnvelope, 'platform' | 'metadata'>,
): boolean {
  const chatType = envelope.metadata.chatType;
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') return true;
  return envelope.platform === 'discord' && chatType !== 'private';
}

export function resolveGroupResponseDeadlineMs(
  avatarConfig: Pick<AvatarConfig, 'behavior'>,
): number {
  return parseOptionalPositiveInt(String(avatarConfig.behavior.groupResponseDeadlineMs ?? ''))
    ?? parseOptionalPositiveInt(process.env.GROUP_RESPONSE_DEADLINE_MS)
    ?? DEFAULT_GROUP_RESPONSE_DEADLINE_MS;
}

export function resolveResponseLlmPolicy(
  avatarConfig: Pick<AvatarConfig, 'llm' | 'behavior'>,
  envelope: Pick<SwarmEnvelope, 'platform' | 'metadata'>,
): ResponseLlmPolicy {
  const isLatencyBoundGroup = isLatencyBoundGroupConversation(envelope);
  const thinkingModel = trimToUndefined(avatarConfig.llm.thinkingModel);

  if (!isLatencyBoundGroup) {
    return {
      isLatencyBoundGroup: false,
      llmConfig: thinkingModel
        ? { ...avatarConfig.llm, model: thinkingModel }
        : avatarConfig.llm,
      useFastModel: false,
      enableTools: true,
    };
  }

  const deadlineMs = resolveGroupResponseDeadlineMs(avatarConfig);
  const fastModel = trimToUndefined(avatarConfig.llm.fastModel)
    ?? trimToUndefined(process.env.GROUP_FAST_LLM_MODEL)
    ?? trimToUndefined(process.env.FAST_LLM_MODEL);
  const enableTools = process.env.GROUP_RESPONSE_ENABLE_TOOLS === 'true';

  return {
    isLatencyBoundGroup: true,
    llmConfig: {
      ...avatarConfig.llm,
      model: fastModel ?? avatarConfig.llm.model,
      timeoutMs: deadlineMs,
    },
    deadlineMs,
    useFastModel: Boolean(fastModel),
    enableTools,
  };
}

export function shouldEnableGroupToolsForMessage(
  envelope: Pick<SwarmEnvelope, 'content' | 'metadata'>,
): boolean {
  if (!envelope.metadata.isMention && !envelope.metadata.isReplyToBot) return false;

  const text = (envelope.content.text || '').toLowerCase();
  if (!text.trim()) return false;

  return /\b(use|call|run|invoke)\s+(the\s+)?tool\b/.test(text)
    || /\b(generate|create|make|draw|render|show)\b[\s\S]{0,80}\b(image|picture|photo|video|sticker|art)\b/.test(text)
    || /\b(image|picture|photo|video|sticker)\b[\s\S]{0,80}\b(generate|create|make|draw|render|tool)\b/.test(text);
}

export function hasNewerMessageThanEnvelope(
  envelope: Pick<SwarmEnvelope, 'messageId' | 'timestamp'>,
  messages: MessageStalenessCandidate[],
): boolean {
  return messages.some((message) => {
    if (!message.messageId || typeof message.timestamp !== 'number') return false;
    if (message.messageId === envelope.messageId) return false;
    return message.timestamp > envelope.timestamp;
  });
}

function latestNewerMessageThanEnvelope(
  envelope: Pick<SwarmEnvelope, 'messageId' | 'timestamp'>,
  messages: MessageStalenessCandidate[],
): MessageStalenessCandidate | undefined {
  return messages
    .filter((message) => {
      if (!message.messageId || typeof message.timestamp !== 'number') return false;
      if (message.messageId === envelope.messageId) return false;
      return message.timestamp > envelope.timestamp;
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /abort|timeout|timed out/i.test(error.message);
}

function appendGroupLatencyInstruction(
  systemPrompt: string,
  policy: ResponseLlmPolicy,
): string {
  if (!policy.isLatencyBoundGroup) return systemPrompt;

  const modelLine = policy.useFastModel
    ? 'You are using the fast response model for this turn.'
    : 'You are using the regular model under a strict group-chat deadline.';
  const toolLine = policy.enableTools
    ? 'Tools may be available, but keep the first response concise.'
    : 'Do not attempt tool-heavy work in this first response; answer briefly from the visible context.';

  return [
    systemPrompt,
    '## Group Chat Response Policy',
    `This is a busy group conversation with a ${policy.deadlineMs}ms response budget.`,
    modelLine,
    toolLine,
    'Answer only while the reply is still directly relevant to the latest visible message.',
    'Keep the reply short enough that it will not feel awkward if other participants continue talking.',
  ].join('\n\n');
}

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

  // Register the Telegram meta resolver so the room coordinator can score
  // turns by display name + @-handle. The resolver reads HOME_CHANNELS and
  // joins each registered avatar's name from its CONFIG record.
  registerTelegramRoomMetaResolver(stateService);
  registerDiscordRoomMetaResolver(stateService);
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
      'generate_sticker',
      'create_sticker',
      'send_sticker',
      'get_sticker_pack',
      'get_gallery_for_stickers',
      'get_job_status',
      'list_jobs',
    ].forEach(t => effectiveTools.add(t));
  }

  if (effectiveTools.size !== (avatarConfig.tools || []).length) {
    avatarConfig.tools = Array.from(effectiveTools);
  }

  // Fetch individual secrets from Secrets Manager using direct paths
  const secrets = await fetchAvatarSecrets(avatarId);

  // If avatar secrets don't include OpenRouter/Replicate, fall back to system keys.
  try {
    const ok = await ensureOpenRouterKey(secrets, secretsService);
    if (ok && !secrets.openrouter_api_key && secrets.OPENROUTER_API_KEY) {
      logger.info('Loaded system OpenRouter key for runtime handler');
    } else if (!ok) {
      logger.warn('System OpenRouter key not configured for runtime handler', {
        hasEnvKey: Boolean(process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY),
        hasSecretArn: Boolean(process.env.OPENROUTER_API_KEY_SECRET_ARN || process.env.LLM_API_KEY_SECRET_ARN),
      });
    }
  } catch (err) {
    logger.warn('Failed to load system OpenRouter key', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
  // Override gallery saver to write to ADMIN_TABLE so gallery reads
  // (get_my_gallery, search_gallery, send_gallery_image) can find the items.
  const adminTable = process.env.ADMIN_TABLE;
  if (adminTable) {
    mediaDeps.saveToGallery = createGallerySaver({ tableName: adminTable });
  }
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
    adminTable,
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

export function shouldCheckGroupResponseStaleness(
  envelope: Pick<SwarmEnvelope, 'platform' | 'metadata'>,
): boolean {
  if (!isLatencyBoundGroupConversation(envelope)) return false;
  return !envelope.metadata.isMention && !envelope.metadata.isReplyToBot;
}

export function sharedRoomMessagesToContextMessages(
  messages: SharedRoomMessage[],
  avatarNamesById: Record<string, string | undefined> = {},
  currentEnvelope?: SwarmEnvelope,
): ContextMessage[] {
  return messages.map((message) => {
    const isCurrentMessage = currentEnvelope?.messageId === message.messageId;
    const senderName = message.senderType === 'avatar'
      ? (avatarNamesById[message.senderId] ?? message.senderId)
      : message.senderId;

    return {
      messageId: message.messageId,
      sender: senderName,
      isBot: message.senderType === 'avatar',
      content: message.content,
      timestamp: message.timestamp,
      userId: message.senderId,
      username: message.senderId,
      isMention: isCurrentMessage ? currentEnvelope?.metadata.isMention : undefined,
      isReplyToBot: isCurrentMessage ? currentEnvelope?.metadata.isReplyToBot : undefined,
      replyToMessageId: isCurrentMessage ? currentEnvelope?.replyTo : undefined,
    };
  });
}

export function contextMessageToLlmMessage(
  msg: ContextMessage,
  currentAvatarId: string,
  prefix = '',
): LLMMessage {
  const isOtherAvatarMessage = msg.isBot && msg.username && msg.username !== currentAvatarId;

  if (msg.isBot && !isOtherAvatarMessage) {
    return {
      role: 'assistant',
      content: `${prefix}${msg.content}`,
    };
  }

  return {
    role: 'user',
    content: `${prefix}${formatMentionContext(msg)}[${msg.sender}]: ${msg.content}`,
  };
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

type GenerateResponseResult =
  | { type: 'complete'; response: SwarmResponse }
  | { type: 'needs_worker'; payload: ChatWorkerMessage }
  | { type: 'suppressed'; reason: 'group_response_timeout' | 'group_response_empty'; details?: Record<string, unknown> };

/**
 * Generate response with iterative tool execution.
 *
 * If the first LLM call returns tool_calls AND a chat worker queue is
 * configured, returns a `needs_worker` result so the caller can delegate
 * tool execution to the async chat-worker Lambda. Otherwise (no tools or
 * no worker queue), runs the full tool loop inline.
 */
async function generateResponse(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext,
  avatarRuntime: AvatarRuntime,
  channelHistory?: ContextMessage[],
  refreshTyping?: () => Promise<void>,
  extraContext?: {
    traceId: string;
    correlationId: string;
    cooldownMinutes: number;
    responseTrigger: ResponseTrigger;
    sharedRoomId?: string;
  },
): Promise<GenerateResponseResult> {
  await maybeTranscribeAudio(envelope, toolClient, toolContext, avatarRuntime.avatarConfig);
  const brainService = createRuntimeBrainService(stateService, avatarRuntime.avatarConfig.brain);
  const baseResponsePolicy = resolveResponseLlmPolicy(avatarRuntime.avatarConfig, envelope);
  const groupToolOverride = baseResponsePolicy.isLatencyBoundGroup
    && !baseResponsePolicy.enableTools
    && shouldEnableGroupToolsForMessage(envelope);
  const responsePolicy: ResponseLlmPolicy = groupToolOverride
    ? { ...baseResponsePolicy, enableTools: true }
    : baseResponsePolicy;

  if (groupToolOverride) {
    logger.info('Enabling tools for explicit group tool request', {
      event: 'group_tools_enabled_for_explicit_request',
      subsystem: 'chat',
      avatarId: avatarRuntime.avatarId,
      platform: envelope.platform,
      conversationId: envelope.conversationId,
      messageId: envelope.messageId,
    });
  }

  const systemPrompt = await buildSystemPrompt(
    envelope,
    avatarRuntime.avatarConfig,
    avatarRuntime.avatarId,
    avatarRuntime.secrets,
    presenceService,
    stateService,
    { fastResponseMode: responsePolicy.isLatencyBoundGroup }
  );
  // Inject memory context into system prompt (gated by BRAIN_INJECT_CONTEXT flag)
  let enrichedSystemPrompt = appendGroupLatencyInstruction(systemPrompt, responsePolicy);
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
            enrichedSystemPrompt = enrichedSystemPrompt + '\n\n' + memoryContext;
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
  const enabledTools = responsePolicy.enableTools
    ? toolClient.getOpenAIToolsForTools(toolDefinitions)
    : [];

  if (responsePolicy.isLatencyBoundGroup) {
    logger.info('Using latency-bound group response policy', {
      event: 'group_response_policy_applied',
      subsystem: 'chat',
      avatarId: avatarRuntime.avatarId,
      platform: envelope.platform,
      conversationId: envelope.conversationId,
      deadlineMs: responsePolicy.deadlineMs,
      useFastModel: responsePolicy.useFastModel,
      model: responsePolicy.llmConfig.model,
      toolsEnabled: responsePolicy.enableTools,
    });
  }

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

      // Own bot messages are assistant history. Other avatars in shared-room
      // context are participants, so keep their names visible as user turns.
      messages.push(contextMessageToLlmMessage(msg, avatarRuntime.avatarId, prefix));
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

  // ─── First LLM call ─────────────────────────────────────────────────────
  if (refreshTyping) await refreshTyping();

  let llmResponse: Awaited<ReturnType<typeof callLLM>>;
  try {
    llmResponse = await callLLM(messages, enabledTools, responsePolicy.llmConfig, avatarRuntime.secrets);
  } catch (error) {
    if (responsePolicy.isLatencyBoundGroup && isTimeoutLikeError(error)) {
      logger.info('Suppressing group response after LLM deadline', {
        event: 'group_response_timeout_suppressed',
        subsystem: 'chat',
        avatarId: avatarRuntime.avatarId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
        messageId: envelope.messageId,
        deadlineMs: responsePolicy.deadlineMs,
        model: responsePolicy.llmConfig.model,
      });
      return {
        type: 'suppressed',
        reason: 'group_response_timeout',
        details: {
          deadlineMs: responsePolicy.deadlineMs,
          model: responsePolicy.llmConfig.model,
        },
      };
    }
    throw error;
  }

  // ─── Fast path: no tool calls → return response directly ──────────────
  if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
    const finalContent = llmResponse.content;
    let cleanFinalContent: string | undefined;

    if (finalContent) {
      const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(finalContent);
      cleanFinalContent = cleanContent;

      if (hasThinking && thinkingBlocks.length > 0) {
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
        }
      }

      cleanFinalContent = stripAvatarNamePrefix(cleanFinalContent, avatarRuntime.avatarConfig.name);
    }

    const outputContent = cleanFinalContent || finalContent;
    let actions: ResponseAction[] = [];
    if (outputContent) {
      actions = [{ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId }];
    } else if (responsePolicy.isLatencyBoundGroup) {
      return {
        type: 'suppressed',
        reason: 'group_response_empty',
        details: { model: responsePolicy.llmConfig.model },
      };
    }

    return {
      type: 'complete',
      response: {
        avatarId: envelope.avatarId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
        replyToMessageId: envelope.messageId,
        actions,
        generatedAt: Date.now(),
        llmModel: responsePolicy.llmConfig.model,
        tokensUsed: 100,
        responseTrigger: extraContext?.responseTrigger,
      },
    };
  }

  // ─── Tool calls detected: delegate to async worker if available ───────
  const chatWorkerQueueUrl = process.env.CHAT_WORKER_QUEUE_URL;

  if (chatWorkerQueueUrl && extraContext) {
    // Add the assistant message with tool_calls to the messages array
    // so the worker has the full conversation state
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

    const workerPayload: ChatWorkerMessage = {
      envelope,
      avatarId: envelope.avatarId,
      messages,
      pendingToolCalls: llmResponse.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
      enabledTools,
      traceId: extraContext.traceId,
      correlationId: extraContext.correlationId,
      processingStartedAt: Date.now(),
      toolResultCount: 0,
      cooldownMinutes: extraContext.cooldownMinutes,
      responseTrigger: extraContext.responseTrigger,
      sharedRoomId: extraContext.sharedRoomId,
    };

    logger.info('Delegating tool loop to chat worker', {
      event: 'chat_worker_delegation',
      subsystem: 'chat',
      toolCount: llmResponse.toolCalls.length,
      toolNames: llmResponse.toolCalls.map(tc => tc.name),
    });

    return { type: 'needs_worker', payload: workerPayload };
  }

  // ─── Fallback: run tool loop synchronously (no worker queue) ──────────
  // Add assistant message with tool_calls
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

  // Execute the pending tool calls inline
  const preExecutedToolResults: ToolLoopResult['allToolResults'] = [];
  for (const toolCall of llmResponse.toolCalls) {
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
  }

  // Run remaining iterations
  const toolLoopResult = await executeToolLoop({
    messages,
    enabledTools,
    toolClient,
    toolContext,
    avatarId: envelope.avatarId,
    avatarName: avatarRuntime.avatarConfig.name,
    llmConfig: responsePolicy.llmConfig,
    secrets: avatarRuntime.secrets,
    envelope,
    brainService,
    refreshTyping,
    preExecutedToolResults,
    startIteration: 1,
  });

  const { response } = buildResponseFromToolLoop(envelope, toolLoopResult, responsePolicy.llmConfig.model);
  response.responseTrigger = extraContext?.responseTrigger;

  return { type: 'complete', response };
}

async function detectNewerGroupActivity(
  envelope: SwarmEnvelope,
  avatarId: string,
  options: { checkSharedRoom: boolean },
): Promise<GroupActivityStaleness> {
  try {
    const currentState = await stateService.getChannelState(avatarId, envelope.conversationId);
    const channelLatest = latestNewerMessageThanEnvelope(
      envelope,
      currentState?.recentMessages ?? [],
    );
    if (channelLatest) {
      return {
        stale: true,
        source: 'channel-state',
        latestMessageId: channelLatest.messageId,
        latestTimestamp: channelLatest.timestamp,
      };
    }
  } catch (error) {
    logger.warn('Failed to check channel state for group response staleness', {
      event: 'group_response_staleness_check_failed',
      subsystem: 'chat',
      source: 'channel-state',
      avatarId,
      conversationId: envelope.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!options.checkSharedRoom) {
    return { stale: false };
  }

  try {
    const recentRoomMessages = await getSharedRoomRecentMessages(envelope.conversationId, 8);
    const sharedLatest = latestNewerMessageThanEnvelope(envelope, recentRoomMessages);
    if (sharedLatest) {
      return {
        stale: true,
        source: 'shared-room',
        latestMessageId: sharedLatest.messageId,
        latestTimestamp: sharedLatest.timestamp,
      };
    }
  } catch (error) {
    logger.warn('Failed to check shared room ledger for group response staleness', {
      event: 'group_response_staleness_check_failed',
      subsystem: 'chat',
      source: 'shared-room',
      avatarId,
      conversationId: envelope.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { stale: false };
}

async function loadSharedRoomHistoryForContext(params: {
  envelope: SwarmEnvelope;
  candidates: TurnCandidate[];
  limit: number;
}): Promise<ContextMessage[] | null> {
  const { envelope, candidates, limit } = params;
  try {
    const recentRoomMessages = await getSharedRoomRecentMessages(envelope.conversationId, limit);
    if (recentRoomMessages.length === 0) return null;
    const avatarNamesById = Object.fromEntries(
      candidates.map((candidate) => [candidate.avatarId, candidate.avatarName]),
    );
    return sharedRoomMessagesToContextMessages(
      recentRoomMessages,
      avatarNamesById,
      envelope,
    );
  } catch (error) {
    logger.warn('Failed to load shared room ledger for response context', {
      event: 'shared_room_context_load_failed',
      subsystem: 'chat',
      avatarId: envelope.avatarId,
      conversationId: envelope.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resetSuppressedMessageState(
  avatarId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  try {
    await stateService.transitionState(avatarId, conversationId, 'IDLE');
  } catch (error) {
    logger.warn('Failed to reset channel state after suppressed response', {
      event: 'suppressed_response_state_reset_failed',
      subsystem: 'state',
      avatarId,
      conversationId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const handler = async (event: SQSEvent, context: Context): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  logger.setContext({
    avatarId: process.env.AVATAR_ID || 'shared',
    requestId: context.awsRequestId,
  });

  await initialize();

  const metrics = createRuntimeMetricsLogger('MessageProcessor');
  metrics.incrementCounter('MessagesReceived', event.Records.length);

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const recordStartTime = Date.now();
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
      let avatarId = envelope.avatarId || process.env.AVATAR_ID;
      if (!avatarId) {
        logger.error('Missing avatarId (shared handler requires envelope.avatarId)', {
          event: 'validation_error',
          subsystem: 'chat',
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      // ---- Room coordinator (gated by ROOM_COORDINATOR_ENABLED) ----
      // For shared rooms, re-decide the primary responder using the full
      // coordinator (mention + name-hit signals today). The webhook stamps
      // `envelope.avatarId` with whichever bot's webhook won the dedup race;
      // that's the wrong avatar when the user mentioned (or named) someone
      // else. Off by default — flip via env var on the deploying lambda
      // after staging validation. See #1571.
      let isSharedRoomForProcessing = false;
      if (envelope.platform && envelope.conversationId) {
        isSharedRoomForProcessing = await isSharedRoom(envelope.platform, envelope.conversationId);
      }
      const shouldRunRoomCoordinator =
        process.env.ROOM_COORDINATOR_ENABLED === 'true' &&
        isSharedRoomForProcessing;
      let roomCoordinatorCandidates: TurnCandidate[] = [];

      if (shouldRunRoomCoordinator) {
        try {
          const result = await runRoomCoordinator(envelope);
          if (result) {
            const { decision, candidates } = result;
            roomCoordinatorCandidates = candidates;
            if (!decision.primary) {
              logger.info('Room coordinator: no primary — skipping record', {
                event: 'room_coordinator_no_primary',
                subsystem: 'room-coordinator',
                messageId: envelope.messageId,
                conversationId: envelope.conversationId,
                decisionReason: decision.decisionReason,
              });
              continue;
            }
            if (decision.decisionReason === 'direct-mention') {
              envelope.metadata.isMention = true;
              envelope.metadata.priority = 'high';
            } else if (decision.decisionReason === 'reply-to-avatar') {
              envelope.metadata.isReplyToBot = true;
              envelope.metadata.priority = 'high';
            }
            if (decision.primary.avatarId !== avatarId) {
              logger.info('Room coordinator: routing to chosen primary', {
                event: 'room_coordinator_override',
                subsystem: 'room-coordinator',
                messageId: envelope.messageId,
                fromAvatarId: avatarId,
                toAvatarId: decision.primary.avatarId,
                decisionReason: decision.decisionReason,
              });
              avatarId = decision.primary.avatarId;
              envelope.avatarId = decision.primary.avatarId;
            }
          }
        } catch (coordErr) {
          logger.warn('Room coordinator failed; falling back to envelope avatar', {
            event: 'room_coordinator_error',
            subsystem: 'room-coordinator',
            error: coordErr instanceof Error ? coordErr.message : String(coordErr),
          });
        }
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

      // =========================================================
      // IDEMPOTENCY CHECK
      // =========================================================
      // Check if this message has already been processed.
      // SQS can redeliver messages due to Lambda timeout/crash, so we use
      // envelope.messageId as the processing key with 1hr TTL.
      const messageProcessingKey = `msgproc:${avatarId}:${envelope.messageId}`;
      const isFirstProcessing = await stateService.checkAndSetIdempotency(messageProcessingKey, 3600);
      if (!isFirstProcessing) {
        logger.info('Message already processed, skipping', {
          event: 'message_deduplicated',
          subsystem: 'chat',
          messageId: envelope.messageId,
        });
        continue;
      }

      logger.info('Processing message', {
        event: 'processing_started',
        subsystem: 'chat',
        sender: envelope.sender.username,
        text: envelope.content.text?.slice(0, 50),
        isMention: envelope.metadata.isMention,
        isReplyToBot: envelope.metadata.isReplyToBot,
      });

      // =========================================================
      // KYRO-STYLE CHANNEL STATE MANAGEMENT
      // =========================================================
      // Note: state is updated for every inbound message regardless of whether
      // the bot will respond — visibility != response. The message belongs in
      // the buffer for context. Quota is debited later, only when we actually
      // call the LLM. See #1509.

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
        suppressionReason: decision.suppressionReason,
        suppressionDetails: decision.suppressionDetails,
      });

      if (!decision.shouldRespond) {
        logger.info('Skipping response', {
          event: 'response_skipped',
          subsystem: 'chat',
          reason: decision.trigger,
          suppressionReason: decision.suppressionReason,
          suppressionDetails: decision.suppressionDetails,
        });
        continue;
      }

      // =========================================================
      // ENTITLEMENT ENFORCEMENT
      // =========================================================
      // Debit ONLY when we have committed to responding (#1509). Previously
      // this fired before evaluateResponseTrigger, so every ignored ambient
      // message in a group still consumed quota — meaningful waste after
      // #1505 disabled ambient triggers.
      const usageCheck = await checkAndIncrementMessageUsage(avatarId);
      if (!usageCheck.allowed) {
        logger.warn('Message rejected due to limit', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          reason: usageCheck.reason,
          limit: usageCheck.limit,
          current: usageCheck.current,
        });
        metrics.incrementCounter('EntitlementRejections');
        metrics.setProperty('Outcome', 'rejected');
        // Don't retry - this is a policy rejection, not an error
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

      // Send typing indicator before LLM call so the user sees feedback
      // during the slowest phase of processing.  The callback is also passed
      // to generateResponse() to refresh between tool iterations.
      const refreshTyping = createTypingSender(
        envelope.platform,
        avatarRuntime.secrets,
        envelope.conversationId,
      );
      if (refreshTyping) await refreshTyping();

      let responseContextHistory = updatedState.recentMessages;
      if (isSharedRoomForProcessing) {
        const sharedHistory = await loadSharedRoomHistoryForContext({
          envelope,
          candidates: roomCoordinatorCandidates,
          limit: Math.max(avatarRuntime.avatarConfig.behavior.maxContextMessages || 20, 20),
        });
        if (sharedHistory) {
          responseContextHistory = sharedHistory;
          logger.info('Using shared room ledger for response context', {
            event: 'shared_room_context_selected',
            subsystem: 'chat',
            historyCount: sharedHistory.length,
          });
        }
      }

      const result = await generateResponse(
        envelope, toolClient, toolContext, avatarRuntime,
        responseContextHistory, refreshTyping,
        {
          traceId,
          correlationId,
          cooldownMinutes: avatarRuntime.avatarConfig.behavior.cooldownMinutes,
          responseTrigger: decision.trigger,
          sharedRoomId: isSharedRoomForProcessing ? envelope.conversationId : undefined,
        },
      );

      metrics.trackDuration('ProcessingLatency', recordStartTime);
      metrics.incrementCounter('MessagesProcessed');

      if (result.type === 'suppressed') {
        metrics.incrementCounter('GroupResponsesSuppressed');
        metrics.setProperty('Outcome', result.reason);
        await resetSuppressedMessageState(avatarId, envelope.conversationId, result.reason);

        logger.info('Response suppressed', {
          event: 'response_suppressed',
          subsystem: 'chat',
          reason: result.reason,
          details: result.details,
        });

        if (wasOffloaded) {
          await cleanupSqsRecord(rawBody);
        }
        continue;
      }

      if (shouldCheckGroupResponseStaleness(envelope)) {
        const staleness = await detectNewerGroupActivity(envelope, avatarId, {
          checkSharedRoom: isSharedRoomForProcessing,
        });
        if (staleness.stale) {
          metrics.incrementCounter('GroupResponsesSuppressed');
          metrics.setProperty('Outcome', 'group_response_stale');
          await resetSuppressedMessageState(avatarId, envelope.conversationId, 'group_response_stale');

          logger.info('Suppressing stale group response', {
            event: 'group_response_stale_suppressed',
            subsystem: 'chat',
            source: staleness.source,
            messageId: envelope.messageId,
            latestMessageId: staleness.latestMessageId,
            latestTimestamp: staleness.latestTimestamp,
          });

          if (wasOffloaded) {
            await cleanupSqsRecord(rawBody);
          }
          continue;
        }
      }

      if (result.type === 'needs_worker') {
        // Delegate tool execution to the async chat worker
        const chatWorkerQueueUrl = process.env.CHAT_WORKER_QUEUE_URL!;
        await sendSqsMessage({
          QueueUrl: chatWorkerQueueUrl,
          MessageAttributes: {
            traceId: { DataType: 'String', StringValue: traceId },
            [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
          },
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: `chatworker_${avatarId}_${envelope.conversationId}_${envelope.messageId}`,
        }, result.payload);

        metrics.incrementCounter('ToolLoopsDelegated');
        metrics.setProperty('Outcome', 'delegated');

        logger.info('Tool loop delegated to chat worker', {
          event: 'delegated_to_worker',
          subsystem: 'chat',
          toolCount: result.payload.pendingToolCalls.length,
        });
      } else {
        // Direct response (no tools or sync fallback)
        const response = result.response;

        try {
          const contextMessageId = await reserveResponseInChannelHistory({
            stateService,
            envelope,
            response,
            avatarName: avatarRuntime.avatarConfig.name,
            sharedRoom: isSharedRoomForProcessing ? { roomId: envelope.conversationId } : undefined,
          });
          if (contextMessageId) {
            logger.info('Reserved generated response in channel history', {
              event: 'response_context_reserved',
              subsystem: 'state',
              contextMessageId,
            });
          }
        } catch (error) {
          logger.warn('Failed to reserve generated response in channel history', {
            event: 'response_context_reservation_failed',
            subsystem: 'state',
            error: error instanceof Error ? error.message : String(error),
          });
        }

        metrics.incrementCounter('ResponsesEnqueued');
        metrics.setProperty('Outcome', 'success');

        logger.info('Response generated', {
          event: 'response_generated',
          subsystem: 'llm',
          actions: response.actions.length,
          tokensUsed: response.tokensUsed,
        });

        await sendSqsMessage({
          QueueUrl: getResponseQueueUrl(),
          MessageAttributes: {
            traceId: { DataType: 'String', StringValue: traceId },
            [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
          },
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: `resp_${avatarId}_${envelope.conversationId}_${envelope.messageId}`,
        }, response);

        // Post-response state: cooldown (only when completing inline)
        if (avatarRuntime.avatarConfig.behavior.cooldownMinutes > 0) {
          await stateService.setUserCooldown({
            avatarId,
            platform: envelope.platform,
            userId: envelope.sender.id,
            cooldownUntil: Date.now() + (avatarRuntime.avatarConfig.behavior.cooldownMinutes * 60 * 1000),
          });
        }
      }

      // Clean up offloaded S3 payload from the inbound message (if any)
      if (wasOffloaded) {
        await cleanupSqsRecord(rawBody);
      }

    } catch (error) {
      metrics.trackDuration('ProcessingLatency', recordStartTime);
      metrics.incrementCounter('ProcessingErrors');
      metrics.setProperty('Outcome', 'error');

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

  metrics.flush();

  return { batchItemFailures };
};
