/**
 * Shared Discord Gateway Worker (multi-tenant)
 *
 * Long-running ECS Fargate process that:
 * 1. Scans DynamoDB for all avatars with Discord enabled
 * 2. Opens one WebSocket gateway connection per unique bot token
 * 3. Routes MESSAGE_CREATE events through buildDiscordEnvelope → SQS
 *
 * Follows the same multi-tenant patterns as telegram-webhook-shared.ts
 * but runs as a persistent WebSocket client instead of a Lambda handler.
 *
 * Caching strategy (see issue #98):
 * - Avatar configs cached with 5-minute TTL to reduce DynamoDB reads
 * - Bot tokens cached with 15-minute TTL (tokens rarely change)
 * - Cache stats logged on every refresh for observability
 */
import WebSocket from 'ws';
import { sendSqsMessage } from '../services/sqs-send.js';
import { processSharedRoomMessage, buildRoomKey, isSharedRoom, registerChannelAvatarResolver } from '../services/room-ingress.js';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'node:crypto';
import {
  buildDiscordEnvelope,
  createStateService,
  createMessageEvaluator,
  createActivityService,
  logger,
  DiscordRateLimiter,
  DiscordAdapter,
  logIntentValidation,
  logGatewayClose,
  computeReconnectDelay,
  type AvatarConfig,
  type DiscordMessage,
  type Platform,
} from '@swarm/core';
import {
  isDiscordChatAllowed,
  logAccessDecision,
  type DiscordAccessContext,
} from './discord-chat-access.js';
import {
  resolveDiscordHomeChannel,
  maybeBootstrapDiscordHomeChannel,
} from './discord-home-channel.js';

// ─── Environment ─────────────────────────────────────────────────────────────

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

const STATE_TABLE = getRequiredEnv('STATE_TABLE');
const MESSAGE_QUEUE_URL = getRequiredEnv('MESSAGE_QUEUE_URL');
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE;
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Discord Gateway intents bitmask
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

// ─── Shared Clients ──────────────────────────────────────────────────────────

const secretsClient = new SecretsManagerClient({});
const stateService = createStateService(STATE_TABLE);
const activityService = ACTIVITY_TABLE ? createActivityService(ACTIVITY_TABLE) : null;

/** Shared rate limiter for Discord API calls from this worker */
const rateLimiter = new DiscordRateLimiter({
  maxQueueSize: 50,
  maxBackoffMs: 60_000,
  enableLogging: true,
});

// ─── Avatar Discovery ────────────────────────────────────────────────────────

/** Represents a Discord-enabled avatar with its runtime config */
interface DiscordAvatarBinding {
  avatarId: string;
  config: AvatarConfig;
  botToken: string;
  botUserId?: string;
  isGlobalMode?: boolean;
}

// ─── Caching Layer ───────────────────────────────────────────────────────────────

/** TTL for cached avatar configs (5 minutes) */
const AVATAR_CONFIG_CACHE_TTL_MS = 5 * 60_000;

/** TTL for cached bot tokens (15 minutes — tokens rarely change) */
const SECRET_CACHE_TTL_MS = 15 * 60_000;

/** Cached avatar config + status, keyed by avatarId */
interface CachedAvatarEntry {
  config: AvatarConfig;
  status: 'draft' | 'active' | 'paused' | 'deleted';
  expiresAt: number;
}

const avatarConfigCache = new Map<string, CachedAvatarEntry>();

/** Timestamp when the avatar list cache expires */
let avatarListCacheExpiresAt = 0;

/** Cached avatar ID list from last scan */
let cachedAvatarIds: string[] = [];

/** Cache stats for observability */
interface CacheStats {
  avatarListHits: number;
  avatarListMisses: number;
  avatarConfigHits: number;
  avatarConfigMisses: number;
  secretHits: number;
  secretMisses: number;
}

const cacheStats: CacheStats = {
  avatarListHits: 0,
  avatarListMisses: 0,
  avatarConfigHits: 0,
  avatarConfigMisses: 0,
  secretHits: 0,
  secretMisses: 0,
};

/** Reset cache stats (for logging intervals) */
function resetCacheStats(): CacheStats {
  const snapshot = { ...cacheStats };
  cacheStats.avatarListHits = 0;
  cacheStats.avatarListMisses = 0;
  cacheStats.avatarConfigHits = 0;
  cacheStats.avatarConfigMisses = 0;
  cacheStats.secretHits = 0;
  cacheStats.secretMisses = 0;
  return snapshot;
}

/**
 * Invalidate all caches. Useful when we detect a config change
 * or need to force a fresh scan.
 */
function invalidateAllCaches(): void {
  avatarConfigCache.clear();
  avatarListCacheExpiresAt = 0;
  cachedAvatarIds = [];
  botTokenCache.clear();
  globalBotTokenCache = null;
  logger.info('All caches invalidated', {
    event: 'cache_invalidated',
    subsystem: 'discord',
  });
}

// ─── Avatar Discovery ─────────────────────────────────────────────────────────────

/** Cache of Discord-enabled avatar bindings, keyed by avatarId */
const avatarBindings = new Map<string, DiscordAvatarBinding>();

/** Cache of bot tokens, keyed by avatarId */
const botTokenCache = new Map<string, { value: string; expiresAt: number }>();

/** Cached global bot token (shared across all global-mode avatars) */
let globalBotTokenCache: { value: string; expiresAt: number } | null = null;

/**
 * Parse a Discord bot token from a secret string that may be JSON-wrapped.
 * Supports `{"DISCORD_BOT_TOKEN":"..."}`, `{"discord_bot_token":"..."}`,
 * `{"token":"..."}`, or a plain token string.
 */
function parseDiscordTokenSecret(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed.DISCORD_BOT_TOKEN || parsed.discord_bot_token || parsed.token || raw;
  } catch {
    // Not JSON — use raw string as token
    return raw;
  }
}

/**
 * Fetch the global Discord bot token from Secrets Manager.
 * Tries both underscore and hyphen naming conventions.
 */
async function getGlobalBotToken(): Promise<string | null> {
  if (globalBotTokenCache && globalBotTokenCache.expiresAt > Date.now()) {
    cacheStats.secretHits++;
    return globalBotTokenCache.value;
  }
  cacheStats.secretMisses++;

  for (const name of [
    `${SECRET_PREFIX}/global/discord_bot_token/global-bot`,
    `${SECRET_PREFIX}/global/discord-bot-token/global-bot`,
    `${SECRET_PREFIX}/global/discord_bot_token/default`,
    `${SECRET_PREFIX}/global/discord-bot-token/default`,
  ]) {
    try {
      const r = await secretsClient.send(new GetSecretValueCommand({ SecretId: name }));
      if (r.SecretString) {
        const token = parseDiscordTokenSecret(r.SecretString);
        globalBotTokenCache = { value: token, expiresAt: Date.now() + SECRET_CACHE_TTL_MS };
        return token;
      }
    } catch (err) {
      logger.debug('Global Discord token not found at path', {
        secretId: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn('No global Discord bot token found in Secrets Manager');
  return null;
}

async function getBotToken(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = botTokenCache.get(avatarId);
  if (cached && cached.expiresAt > now) {
    cacheStats.secretHits++;
    return cached.value;
  }
  cacheStats.secretMisses++;

  // Try JSON secrets blob first (standard pattern)
  const jsonSecretName = `${SECRET_PREFIX}/${avatarId}/secrets`;
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: jsonSecretName })
    );
    if (response.SecretString) {
      const secrets = JSON.parse(response.SecretString) as Record<string, string>;
      const token = secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token;
      if (token) {
        botTokenCache.set(avatarId, { value: token, expiresAt: now + SECRET_CACHE_TTL_MS });
        return token;
      }
    }
  } catch {
    // Fall through to per-secret pattern
  }

  // Try individual secret (admin API pattern)
  const individualSecretName = `${SECRET_PREFIX}/${avatarId}/discord_bot_token/default`;
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: individualSecretName })
    );
    const token = response.SecretString || '';
    if (token) {
      botTokenCache.set(avatarId, { value: token, expiresAt: now + SECRET_CACHE_TTL_MS });
      return token;
    }
  } catch {
    // No token found
  }

  return null;
}

/**
 * Get avatar IDs with caching. Only queries DynamoDB when the cache expires.
 */
async function getAvatarIds(): Promise<string[]> {
  const now = Date.now();
  if (avatarListCacheExpiresAt > now && cachedAvatarIds.length > 0) {
    cacheStats.avatarListHits++;
    return cachedAvatarIds;
  }
  cacheStats.avatarListMisses++;

  const ids = await stateService.listAvatars();
  cachedAvatarIds = ids;
  avatarListCacheExpiresAt = now + AVATAR_CONFIG_CACHE_TTL_MS;
  return ids;
}

/**
 * Get avatar config + status with caching. Only queries DynamoDB when expired.
 */
async function getAvatarConfigCached(avatarId: string): Promise<{
  config: AvatarConfig;
  status: 'draft' | 'active' | 'paused' | 'deleted';
} | null> {
  const now = Date.now();
  const cached = avatarConfigCache.get(avatarId);
  if (cached && cached.expiresAt > now) {
    cacheStats.avatarConfigHits++;
    return { config: cached.config, status: cached.status };
  }
  cacheStats.avatarConfigMisses++;

  const result = await stateService.getAvatarConfigWithStatus(avatarId);
  if (!result) {
    // Remove stale cache entry if avatar no longer exists
    avatarConfigCache.delete(avatarId);
    return null;
  }

  avatarConfigCache.set(avatarId, {
    config: result.config,
    status: result.status,
    expiresAt: now + AVATAR_CONFIG_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Scan DynamoDB for all avatars with Discord enabled and load their bot tokens.
 * Uses caching to minimize API calls on repeated invocations.
 * Returns a map of avatarId → DiscordAvatarBinding.
 */
async function discoverDiscordAvatars(): Promise<Map<string, DiscordAvatarBinding>> {
  const bindings = new Map<string, DiscordAvatarBinding>();

  try {
    const globalToken = await getGlobalBotToken();
    const avatarIds = await getAvatarIds();

    for (const avatarId of avatarIds) {
      const result = await getAvatarConfigCached(avatarId);
      if (!result) continue;

      const { config, status } = result;
      if (!config.platforms?.discord?.enabled) continue;

      if (status !== 'active') {
        logger.debug('Skipping inactive Discord avatar', { avatarId, status });
        continue;
      }

      const discordMode = config.platforms.discord?.mode;

      if (discordMode === 'global') {
        // Global mode: all avatars share the single global bot token
        if (!globalToken) {
          logger.warn('Avatar configured for global Discord but no global token found', { avatarId });
          continue;
        }
        bindings.set(avatarId, {
          avatarId,
          config,
          botToken: globalToken,
          isGlobalMode: true,
        });
      } else {
        // Existing: per-avatar bot token
        const botToken = await getBotToken(avatarId);
        if (!botToken) {
          logger.warn('Discord-enabled avatar has no bot token', { avatarId });
          continue;
        }
        bindings.set(avatarId, {
          avatarId,
          config,
          botToken,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to discover Discord avatars', err, {
      event: 'avatar_discovery_error',
      subsystem: 'discord',
    });
  }

  return bindings;
}

// ─── Message Handling ────────────────────────────────────────────────────────

function applyResolvedDiscordHomeChannel(
  discordConfig: NonNullable<AvatarConfig['platforms']['discord']>,
  channel: {
    channelId: string;
    guildId?: string;
    channelName?: string;
  }
): void {
  discordConfig.homeChannelId = channel.channelId;
  if (channel.guildId) {
    discordConfig.homeGuildId = channel.guildId;
  }
  if (channel.channelName) {
    discordConfig.homeChannelName = channel.channelName;
  }
}

async function ensureDiscordHomeChannelForEngagedMessage(
  message: DiscordMessage,
  binding: DiscordAvatarBinding
): Promise<void> {
  const discordConfig = binding.config.platforms.discord;
  if (!discordConfig || discordConfig.homeChannelId || message.author.bot) {
    return;
  }

  const botUserId = binding.botUserId;
  if (!botUserId) {
    return;
  }

  const isMention = message.mentions.some((mention) => mention.id === botUserId);
  const isReplyToBot = !!(
    message.referenced_message &&
    message.referenced_message.author.id === botUserId
  );

  if (!isMention && !isReplyToBot) {
    return;
  }

  const resolved = await resolveDiscordHomeChannel({
    avatarId: binding.avatarId,
    avatarConfig: binding.config,
  });

  if (resolved) {
    applyResolvedDiscordHomeChannel(discordConfig, resolved);
    return;
  }

  const bootstrapped = await maybeBootstrapDiscordHomeChannel({
    avatarId: binding.avatarId,
    avatarConfig: binding.config,
    channelId: message.channel_id,
    guildId: message.guild_id,
    isMention,
    isReplyToBot,
  });

  if (bootstrapped) {
    applyResolvedDiscordHomeChannel(discordConfig, {
      channelId: message.channel_id,
      guildId: message.guild_id,
    });
  }
}

async function handleDiscordMessage(
  message: DiscordMessage,
  binding: DiscordAvatarBinding
): Promise<void> {
  const { avatarId, config } = binding;
  const traceId = randomUUID();

  logger.setContext({
    avatarId,
    platform: 'discord',
    messageId: message.id,
    conversationId: message.channel_id,
    traceId,
  });

  // Build envelope using the existing core utility
  const discordConfig = config.platforms.discord!;
  const envelope = buildDiscordEnvelope(message, {
    avatarId,
    botUserId: binding.botUserId,
    allowedGuilds: discordConfig.allowedGuilds,
    allowedChannels: discordConfig.allowedChannels,
    allowedRoleIds: discordConfig.allowedRoleIds,
    ignoreBots: config.behavior?.ignoreBots ?? true,
  });

  if (!envelope) return;

  // ── Access control (parity with Telegram's isTelegramChatAllowed) ───────
  const accessCtx: DiscordAccessContext = {
    channelId: message.channel_id,
    guildId: message.guild_id,
    isDm: !message.guild_id,
    senderId: message.author.id,
    senderUsername: message.author.username,
    senderRoleIds: message.member?.roles,
  };
  const accessResult = isDiscordChatAllowed(accessCtx, discordConfig);
  logAccessDecision(avatarId, accessCtx, accessResult);
  if (!accessResult.allowed) {
    return;
  }

  envelope.traceId = traceId;

  // Log activity
  if (activityService) {
    try {
      await activityService.logMessageReceived(
        avatarId,
        'discord',
        envelope.sender.displayName || envelope.sender.username || 'Unknown',
        envelope.content.text || '[message]'
      );
    } catch {
      // Activity logging should not block message processing
    }
  }

  // Idempotency check
  const isNew = await stateService.checkAndSetIdempotency(envelope.metadata.idempotencyKey);
  if (!isNew) {
    logger.info('Duplicate Discord message, skipping', { messageId: message.id });
    return;
  }

  // Evaluate whether to respond
  const evaluator = createMessageEvaluator(config, stateService, {
    botUsernames: [],
    botUserIds: binding.botUserId ? [binding.botUserId] : [],
  } as Parameters<typeof createMessageEvaluator>[2]);

  const evaluation = await evaluator.evaluate(envelope);

  envelope.metadata.shouldRespond = evaluation.shouldRespond;
  envelope.metadata.responseReason = evaluation.reason;
  envelope.metadata.priority = evaluation.priority;

  // Store in channel history when admitted to context (even without response).
  // This gives Discord guild messages the same context visibility as Telegram
  // group messages — the system sees them for shared-room context building.
  const shouldAdmit = evaluation.shouldRespond || evaluation.admitToContext;

  if (shouldAdmit) {
    const meta = envelope.metadata as unknown as Record<string, unknown>;
    const chatType = meta.chatType as string | undefined;
    await stateService.addMessageToChannel(
      avatarId,
      envelope.conversationId,
      'discord' as Platform,
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
        isBot: envelope.sender.isBot,
        content: envelope.content.text || '[message]',
        timestamp: envelope.timestamp,
      },
      undefined, // maxMessages - use default
      chatType === 'dm' ? 'private' : 'group',
      meta.guildId as string | undefined
    );
  }

  if (!evaluation.shouldRespond) {
    logger.info('Not responding to Discord message', {
      reason: evaluation.reason,
      admittedToContext: shouldAdmit,
    });
    return;
  }

  // Send typing indicator immediately so user sees instant feedback
  // (only for guild messages getting a response - typing is expected user feedback)
  if (envelope.metadata.chatType !== 'private') {
    try {
      const discordAdapter = new DiscordAdapter(config, {
        botToken: binding.botToken,
      });
      await discordAdapter.sendTypingIndicator(envelope.conversationId);
    } catch { /* non-critical */ }
  }

  // Enqueue to shared message queue (with S3 offload for large payloads)
  await sendSqsMessage({
    QueueUrl: MESSAGE_QUEUE_URL,
    MessageAttributes: {
      traceId: { DataType: 'String', StringValue: traceId },
    },
    MessageGroupId: `${avatarId}#${envelope.conversationId}`,
    MessageDeduplicationId: envelope.metadata.idempotencyKey,
  }, {
    envelope,
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
  });

  logger.info('Discord message queued', {
    event: 'message_queued',
    subsystem: 'discord',
    messageId: message.id,
    reason: evaluation.reason,
  });
}

// ─── Gateway Connection ──────────────────────────────────────────────────────

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

interface GatewayHello {
  heartbeat_interval: number;
}

interface GatewayReady {
  session_id: string;
  resume_gateway_url?: string;
  user: { id: string; username: string };
}

/**
 * Manages a single Discord Gateway WebSocket connection for one bot token.
 * Multiple avatars can share the same connection if they use the same token.
 */
class GatewayConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatAckTimeoutTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private lastHeartbeatAckAt: number | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectAttempts = 0;
  private shouldResume = false;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private destroyed = false;

  /** Avatars bound to this connection (same bot token) */
  readonly avatarBindings = new Map<string, DiscordAvatarBinding>();

  constructor(
    private readonly botToken: string,
    private readonly intents: number
  ) {}

  /** The bot's user ID (available after READY) */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /** Add an avatar binding to this connection */
  addAvatar(binding: DiscordAvatarBinding): void {
    this.avatarBindings.set(binding.avatarId, binding);
  }

  /** Remove an avatar binding */
  removeAvatar(avatarId: string): void {
    this.avatarBindings.delete(avatarId);
  }

  /** Start the gateway connection */
  start(): void {
    this.destroyed = false;
    this.connect();
  }

  /** Gracefully stop the connection */
  stop(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatAckTimeoutTimer) {
      clearTimeout(this.heartbeatAckTimeoutTimer);
      this.heartbeatAckTimeoutTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.destroyed) return;

    const gatewayUrl = this.shouldResume && this.resumeGatewayUrl
      ? `${this.resumeGatewayUrl}?v=10&encoding=json`
      : DEFAULT_GATEWAY_URL;

    logger.info('Connecting to Discord gateway', {
      event: 'gateway_connecting',
      subsystem: 'discord',
      resume: this.shouldResume,
      avatarCount: this.avatarBindings.size,
    });

    this.ws = new WebSocket(gatewayUrl);

    this.ws.on('open', () => {
      logger.info('Discord gateway WebSocket opened', {
        event: 'gateway_connected',
        subsystem: 'discord',
      });
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as GatewayPayload;
        if (typeof payload.s === 'number') {
          this.sequence = payload.s;
        }
        this.handlePayload(payload).catch(err => {
          logger.error('Error handling gateway payload', err, {
            event: 'payload_error',
            subsystem: 'discord',
            opcode: payload.op,
            eventType: payload.t,
          });
        });
      } catch (err) {
        logger.error('Failed to parse gateway payload', err, {
          event: 'parse_error',
          subsystem: 'discord',
        });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const closeInfo = logGatewayClose(code, reason.toString(), {
        reconnectAttempt: this.reconnectAttempts,
        sessionId: this.sessionId ?? undefined,
        botUserId: this.botUserId ?? undefined,
        avatarCount: this.avatarBindings.size,
      });

      if (!closeInfo.reconnectable) {
        logger.error(`Discord gateway close code ${code} is non-reconnectable. Stopping connection.`, undefined, {
          event: 'gateway_non_reconnectable',
          subsystem: 'discord',
          closeCode: code,
          description: closeInfo.description,
          remediation: closeInfo.remediation,
        });
        this.destroyed = true;
        return;
      }

      // Close codes 4007 (invalid sequence) and 4009 (session timed out)
      // indicate the session is no longer valid. Clear session state to
      // force a full IDENTIFY on the next connection instead of RESUME.
      if (code === 4007 || code === 4009) {
        logger.warn('Session invalidated by close code, clearing session state', {
          event: 'session_invalidated',
          subsystem: 'discord',
          closeCode: code,
          description: closeInfo.description,
          previousSessionId: this.sessionId,
          botUserId: this.botUserId,
        });
        this.sessionId = null;
        this.sequence = null;
        this.resumeGatewayUrl = null;
        this.scheduleReconnect(false);
        return;
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (error: Error) => {
      logger.error('Discord gateway error', error, {
        event: 'gateway_error',
        subsystem: 'discord',
      });
    });
  }

  private async handlePayload(payload: GatewayPayload): Promise<void> {
    switch (payload.op) {
      case 10: // HELLO
        this.handleHello(payload.d as GatewayHello);
        return;
      case 11: // HEARTBEAT_ACK
        this.handleHeartbeatAck();
        return;
      case 0: // DISPATCH
        await this.handleDispatch(payload.t, payload.d);
        return;
      case 1: // HEARTBEAT (server-requested)
        this.sendHeartbeat();
        return;
      case 7: // RECONNECT
        logger.warn('Discord gateway requested reconnect', {
          event: 'gateway_reconnect_requested',
          subsystem: 'discord',
        });
        this.scheduleReconnect(true);
        return;
      case 9: // INVALID_SESSION
        logger.warn('Discord gateway invalid session', {
          event: 'gateway_invalid_session',
          subsystem: 'discord',
          resumable: payload.d as boolean,
        });
        if (payload.d) {
          // Session is resumable, wait a bit then resume
          this.scheduleReconnect(true);
        } else {
          // Session is not resumable, full reconnect
          this.sessionId = null;
          this.sequence = null;
          this.resumeGatewayUrl = null;
          this.scheduleReconnect(false);
        }
        return;
    }
  }

  private handleHello(hello: GatewayHello): void {
    // Start heartbeating
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Validate and clamp heartbeat interval to [10s, 120s]
    const MIN_HEARTBEAT_MS = 10_000;
    const MAX_HEARTBEAT_MS = 120_000;
    let interval = hello.heartbeat_interval;

    if (interval < MIN_HEARTBEAT_MS || interval > MAX_HEARTBEAT_MS) {
      const original = interval;
      interval = Math.max(MIN_HEARTBEAT_MS, Math.min(MAX_HEARTBEAT_MS, interval));
      logger.warn('Heartbeat interval out of bounds, clamping', {
        event: 'heartbeat_interval_clamped',
        subsystem: 'discord',
        originalMs: original,
        clampedMs: interval,
        minMs: MIN_HEARTBEAT_MS,
        maxMs: MAX_HEARTBEAT_MS,
        botUserId: this.botUserId,
      });
    }

    // Apply random jitter of up to -10% to prevent thundering herd
    const jitter = Math.floor(Math.random() * interval * 0.1);
    const jitteredInterval = interval - jitter;

    this.heartbeatIntervalMs = interval;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), jitteredInterval);

    // Send initial heartbeat
    this.sendHeartbeat();

    // Identify or resume
    if (this.shouldResume && this.sessionId && this.sequence !== null) {
      this.resume();
    } else {
      this.identify();
    }
  }

  private async handleDispatch(eventType?: string, data?: unknown): Promise<void> {
    if (!eventType || !data) return;

    if (eventType === 'READY') {
      const ready = data as GatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url || null;
      this.botUserId = ready.user.id;
      this.botUsername = ready.user.username;
      this.reconnectAttempts = 0;
      this.shouldResume = true;

      // Update all avatar bindings with the bot's user ID
      for (const binding of this.avatarBindings.values()) {
        binding.botUserId = ready.user.id;
      }

      // Validate gateway intents after READY
      const intentResult = logIntentValidation(this.intents);
      if (!intentResult.valid) {
        logger.error('Discord gateway intents are misconfigured. Messages may not be received.', undefined, {
          event: 'gateway_intent_warning',
          subsystem: 'discord',
          missingRequired: intentResult.missingRequired,
          diagnostics: intentResult.diagnostics,
        });
      }

      logger.info('Discord gateway ready', {
        event: 'gateway_ready',
        subsystem: 'discord',
        botUserId: this.botUserId,
        botUsername: this.botUsername,
        avatarCount: this.avatarBindings.size,
        intentsValid: intentResult.valid,
      });
      return;
    }

    if (eventType === 'RESUMED') {
      this.reconnectAttempts = 0;
      logger.info('Discord gateway resumed', {
        event: 'gateway_resumed',
        subsystem: 'discord',
      });
      return;
    }

    if (eventType === 'MESSAGE_CREATE') {
      const message = data as DiscordMessage;

      // Collect eligible avatar bindings for this message
      const eligible: DiscordAvatarBinding[] = [];
      for (const binding of this.avatarBindings.values()) {
        if (binding.isGlobalMode) {
          if (message.author.id === this.botUserId) continue;
          if (message.webhook_id) continue;

          const dc = binding.config.platforms?.discord;
          if (dc?.enabled) {
            const accessCtx: DiscordAccessContext = {
              channelId: message.channel_id,
              guildId: message.guild_id,
              isDm: !message.guild_id,
              senderId: message.author.id,
              senderUsername: message.author.username,
              senderRoleIds: message.member?.roles,
            };
            const accessResult = isDiscordChatAllowed(accessCtx, dc);
            if (!accessResult.allowed) {
              logAccessDecision(binding.avatarId, accessCtx, accessResult);
              continue;
            }
          }
        }

        await ensureDiscordHomeChannelForEngagedMessage(message, binding);
        eligible.push(binding);
      }

      // Shared room path: use platform-agnostic isSharedRoom check.
      // The Discord resolver is registered at startup (see main()) so
      // this uses the same abstraction as Telegram's shared-room detection.
      const shared = await isSharedRoom('discord', message.channel_id);
      if (shared) {
        const traceId = randomUUID();
        try {
          const ingressResult = await processSharedRoomMessage('discord', message.channel_id, {
            messageId: message.id,
            senderId: message.author.id,
            senderType: message.author.bot ? 'avatar' : 'human',
            content: message.content || '[media]',
            timestamp: Date.now(),
          });

          if (ingressResult.isNew) {
            // Build envelope from the first eligible binding for the SQS payload
            const firstBinding = eligible[0];
            const discordConfig = firstBinding.config.platforms.discord!;
            const envelope = buildDiscordEnvelope(message, {
              avatarId: firstBinding.avatarId,
              botUserId: firstBinding.botUserId,
              allowedGuilds: discordConfig.allowedGuilds,
              allowedChannels: discordConfig.allowedChannels,
              allowedRoleIds: discordConfig.allowedRoleIds,
              ignoreBots: firstBinding.config.behavior?.ignoreBots ?? true,
            });

            if (envelope) {
              envelope.traceId = traceId;
              const roomKey = buildRoomKey('discord', message.channel_id);
              await sendSqsMessage({
                QueueUrl: MESSAGE_QUEUE_URL,
                MessageAttributes: {
                  traceId: { DataType: 'String', StringValue: traceId },
                },
                MessageGroupId: roomKey,
                MessageDeduplicationId: `discord:${message.id}`,
              }, {
                envelope,
                roomKey,
                enqueuedAt: Date.now(),
                attempts: 0,
                maxAttempts: 3,
              });

              logger.info('Discord shared room message queued (room-scoped)', {
                event: 'room_message_queued',
                subsystem: 'discord',
                roomKey,
                messageId: message.id,
                eligibleAvatars: eligible.map(b => b.avatarId),
              });
            }
          }
        } catch (err) {
          logger.error('Error in Discord shared room ingress', err, {
            event: 'room_ingress_error',
            subsystem: 'discord',
            channelId: message.channel_id,
            messageId: message.id,
          });
        }
      } else {
        // Single-avatar path: legacy per-avatar enqueue
        for (const binding of eligible) {
          try {
            await handleDiscordMessage(message, binding);
          } catch (err) {
            logger.error('Error handling Discord message for avatar', err, {
              event: 'message_handler_error',
              subsystem: 'discord',
              avatarId: binding.avatarId,
              messageId: message.id,
            });
          }
        }
      }
    }
  }

  private sendHeartbeat(): void {
    this.lastHeartbeatSentAt = Date.now();
    this.send({ op: 1, d: this.sequence });

    // Schedule ACK timeout at 1.5x heartbeat interval
    if (this.heartbeatAckTimeoutTimer) {
      clearTimeout(this.heartbeatAckTimeoutTimer);
    }
    if (this.heartbeatIntervalMs) {
      const timeoutMs = Math.floor(this.heartbeatIntervalMs * 1.5);
      this.heartbeatAckTimeoutTimer = setTimeout(() => {
        logger.warn('Heartbeat ACK not received within timeout — forcing reconnect', {
          event: 'heartbeat_ack_timeout',
          subsystem: 'discord',
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          timeoutMs,
          lastHeartbeatSentAt: this.lastHeartbeatSentAt,
          lastHeartbeatAckAt: this.lastHeartbeatAckAt,
          botUserId: this.botUserId,
          avatarCount: this.avatarBindings.size,
        });
        this.scheduleReconnect(true);
      }, timeoutMs);
    }
  }

  private handleHeartbeatAck(): void {
    this.lastHeartbeatAckAt = Date.now();
    if (this.heartbeatAckTimeoutTimer) {
      clearTimeout(this.heartbeatAckTimeoutTimer);
      this.heartbeatAckTimeoutTimer = null;
    }
    if (this.lastHeartbeatSentAt) {
      const latencyMs = this.lastHeartbeatAckAt - this.lastHeartbeatSentAt;
      logger.debug('Heartbeat ACK received', {
        event: 'heartbeat_ack',
        subsystem: 'discord',
        latencyMs,
        botUserId: this.botUserId,
      });
    }
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.botToken,
        intents: this.intents,
        properties: {
          os: process.platform,
          browser: 'swarm',
          device: 'swarm',
        },
      },
    });
  }

  private resume(): void {
    if (!this.sessionId || this.sequence === null) {
      this.identify();
      return;
    }

    this.send({
      op: 6,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(resume = true, closeCode?: number): void {
    if (this.destroyed) return;

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.heartbeatAckTimeoutTimer) {
      clearTimeout(this.heartbeatAckTimeoutTimer);
      this.heartbeatAckTimeoutTimer = null;
    }

    this.shouldResume = resume;
    const delay = closeCode !== undefined
      ? computeReconnectDelay(closeCode, this.reconnectAttempts)
      : Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;

    if (delay < 0) {
      // Non-reconnectable close code
      logger.error('Close code is non-reconnectable, not scheduling reconnect', undefined, {
        event: 'gateway_reconnect_aborted',
        subsystem: 'discord',
        closeCode,
        attempt: this.reconnectAttempts,
      });
      return;
    }

    logger.info('Scheduling gateway reconnect', {
      event: 'gateway_reconnect_scheduled',
      subsystem: 'discord',
      delay,
      attempt: this.reconnectAttempts,
      resume,
    });

    setTimeout(() => this.connect(), delay);
  }
}

// ─── Connection Manager ──────────────────────────────────────────────────────

/** Active gateway connections, keyed by bot token */
const connections = new Map<string, GatewayConnection>();

/**
 * Reconcile avatar bindings against active gateway connections.
 * - Start new connections for new tokens
 * - Update bindings on existing connections
 * - Stop connections with no avatars
 */
function reconcileConnections(bindings: Map<string, DiscordAvatarBinding>): void {
  // Group avatars by bot token
  const tokenToAvatars = new Map<string, DiscordAvatarBinding[]>();
  for (const binding of bindings.values()) {
    const existing = tokenToAvatars.get(binding.botToken) || [];
    existing.push(binding);
    tokenToAvatars.set(binding.botToken, existing);
  }

  // Start or update connections
  for (const [token, avatars] of tokenToAvatars) {
    let conn = connections.get(token);
    if (!conn) {
      // Determine intents from first avatar (all share the same bot, so intents should match)
      const intents = avatars[0].config.platforms.discord?.intents || DEFAULT_INTENTS;
      conn = new GatewayConnection(token, intents);
      connections.set(token, conn);

      // Add all avatar bindings before starting
      for (const avatar of avatars) {
        conn.addAvatar(avatar);
      }

      conn.start();
      logger.info('Started new gateway connection', {
        event: 'connection_started',
        subsystem: 'discord',
        avatarIds: avatars.map(a => a.avatarId),
      });
    } else {
      // Update bindings on existing connection
      const currentIds = new Set(conn.avatarBindings.keys());
      const newIds = new Set(avatars.map(a => a.avatarId));

      // Add new avatars
      for (const avatar of avatars) {
        if (!currentIds.has(avatar.avatarId)) {
          // Inherit botUserId from connection if already known
          if (conn.getBotUserId()) {
            avatar.botUserId = conn.getBotUserId()!;
          }
          conn.addAvatar(avatar);
          logger.info('Added avatar to existing connection', {
            event: 'avatar_added',
            subsystem: 'discord',
            avatarId: avatar.avatarId,
          });
        } else {
          // Update config on existing binding
          const existing = conn.avatarBindings.get(avatar.avatarId)!;
          existing.config = avatar.config;
        }
      }

      // Remove avatars no longer bound to this token
      for (const id of currentIds) {
        if (!newIds.has(id)) {
          conn.removeAvatar(id);
          logger.info('Removed avatar from connection', {
            event: 'avatar_removed',
            subsystem: 'discord',
            avatarId: id,
          });
        }
      }
    }
  }

  // Stop connections with no active avatars
  for (const [token, conn] of connections) {
    if (conn.avatarBindings.size === 0) {
      conn.stop();
      connections.delete(token);
      logger.info('Stopped orphaned gateway connection', {
        event: 'connection_stopped',
        subsystem: 'discord',
      });
    }
  }
}

// ─── Preflight Checks ────────────────────────────────────────────────────────

/**
 * Verify that the configured SQS queue exists and is reachable.
 * Fails fast at startup if the queue URL is stale or the queue was deleted,
 * instead of silently dropping messages at runtime.
 */
async function verifyQueueReachable(queueUrl: string): Promise<void> {
  const sqsClient = new SQSClient({});
  try {
    await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }));
    logger.info('SQS queue preflight check passed', {
      event: 'queue_preflight_ok',
      subsystem: 'discord',
      queueUrl,
    });
  } catch (err: unknown) {
    const errorName = err instanceof Error ? err.constructor.name : String(err);
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check for NonExistentQueue / QueueDoesNotExist errors
    const isNonExistent =
      errorName === 'QueueDoesNotExist' ||
      errorName === 'NonExistentQueue' ||
      (errorName === 'AWS.SimpleQueueService.NonExistentQueue') ||
      errorMessage.includes('NonExistentQueue') ||
      errorMessage.includes('QueueDoesNotExist');

    if (isNonExistent) {
      logger.error(
        `FATAL: SQS queue does not exist: ${queueUrl}. ` +
        'The MESSAGE_QUEUE_URL environment variable may be stale. ' +
        'Verify the queue exists or redeploy via CDK to provision the correct queue.',
        err instanceof Error ? err : undefined,
        {
          event: 'queue_preflight_failed',
          subsystem: 'discord',
          queueUrl,
          errorName,
        }
      );
      throw new Error(
        `SQS queue does not exist: ${queueUrl}. ` +
        'Cannot start Discord gateway without a valid message queue. ' +
        'Redeploy the CDK stack to provision the queue, or update MESSAGE_QUEUE_URL.'
      );
    }

    // For other errors (permissions, network), log a warning but allow startup
    // since the queue may exist but be temporarily unreachable
    logger.warn('SQS queue preflight check could not confirm queue existence — proceeding with caution', {
      event: 'queue_preflight_warning',
      subsystem: 'discord',
      queueUrl,
      errorName,
      errorMessage,
    });
  } finally {
    sqsClient.destroy();
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

const AVATAR_REFRESH_INTERVAL_MS = 60_000; // Re-scan for avatars every 60s

async function refreshAvatarBindings(): Promise<void> {
  logger.info('Refreshing Discord avatar bindings', {
    event: 'avatar_refresh',
    subsystem: 'discord',
  });

  const bindings = await discoverDiscordAvatars();

  // Update global cache
  avatarBindings.clear();
  for (const [id, binding] of bindings) {
    avatarBindings.set(id, binding);
  }

  // Reconcile gateway connections
  reconcileConnections(bindings);

  // Log cache stats and reset for next interval
  const stats = resetCacheStats();
  logger.info('Avatar refresh complete', {
    event: 'avatar_refresh_complete',
    subsystem: 'discord',
    avatarCount: bindings.size,
    connectionCount: connections.size,
    cacheStats: stats,
  });
}

async function main(): Promise<void> {
  logger.setContext({
    subsystem: 'discord',
    service: 'discord-gateway',
    environment: ENVIRONMENT,
  });

  logger.info('Discord gateway worker starting', {
    event: 'worker_starting',
    subsystem: 'discord',
    environment: ENVIRONMENT,
    stateTable: STATE_TABLE,
    messageQueue: MESSAGE_QUEUE_URL,
    secretPrefix: SECRET_PREFIX,
    avatarConfigCacheTtlMs: AVATAR_CONFIG_CACHE_TTL_MS,
    secretCacheTtlMs: SECRET_CACHE_TTL_MS,
  });

  // Preflight: verify the SQS queue exists before accepting messages.
  // This catches stale MESSAGE_QUEUE_URL values early instead of failing
  // silently at runtime with NonExistentQueue errors.
  await verifyQueueReachable(MESSAGE_QUEUE_URL);

  // Register the Discord channel-avatar resolver so isSharedRoom uses
  // the in-memory gateway bindings rather than the Telegram-specific
  // home-channel registry. This brings both platforms onto one abstraction.
  registerChannelAvatarResolver('discord', async (channelId: string) => {
    const ids: string[] = [];
    for (const binding of avatarBindings.values()) {
      const dc = binding.config.platforms?.discord;
      // An avatar is "in" this channel if it has no channel filter, or the
      // channel is in its allowedChannels list, and the guild (if any) is
      // in its allowedGuilds list.
      const guildOk = !dc?.allowedGuilds?.length || true; // guild check happens at message level
      const channelOk = !dc?.allowedChannels?.length || dc.allowedChannels.includes(channelId);
      if (guildOk && channelOk) {
        ids.push(binding.avatarId);
      }
    }
    return ids;
  });

  // Initial avatar discovery
  await refreshAvatarBindings();

  if (connections.size === 0) {
    logger.warn('No Discord-enabled avatars found. Waiting for avatars to be configured...', {
      event: 'no_avatars',
      subsystem: 'discord',
    });
  }

  // Periodic refresh to pick up new/changed avatars
  const refreshTimer = setInterval(async () => {
    try {
      await refreshAvatarBindings();
    } catch (err) {
      logger.error('Avatar refresh failed', err, {
        event: 'avatar_refresh_error',
        subsystem: 'discord',
      });
    }
  }, AVATAR_REFRESH_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Discord gateway worker shutting down', {
      event: 'worker_stopping',
      subsystem: 'discord',
    });
    clearInterval(refreshTimer);
    for (const conn of connections.values()) {
      conn.stop();
    }
    connections.clear();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Health log every 5 minutes
  setInterval(() => {
    const connectionStatus = Array.from(connections.entries()).map(([_token, conn]) => ({
      avatarCount: conn.avatarBindings.size,
      avatarIds: Array.from(conn.avatarBindings.keys()),
      connected: conn.isConnected,
      botUserId: conn.getBotUserId(),
    }));

    logger.info('Discord gateway health', {
      event: 'health_check',
      subsystem: 'discord',
      totalConnections: connections.size,
      totalAvatars: avatarBindings.size,
      connections: connectionStatus,
      avatarConfigCacheSize: avatarConfigCache.size,
      botTokenCacheSize: botTokenCache.size,
    });
  }, 5 * 60_000);
}

// Run if invoked directly (not when imported as a module)
const isDirectExecution = process.argv[1]?.endsWith('discord-gateway-shared.js');
if (isDirectExecution) {
  main().catch((error) => {
    logger.error('Discord gateway worker fatal error', error, {
      event: 'worker_fatal',
      subsystem: 'discord',
    });
    process.exit(1);
  });
}

export {
  main,
  discoverDiscordAvatars,
  GatewayConnection,
  rateLimiter,
  verifyQueueReachable,
  getGlobalBotToken,
  // Export caching internals for testing
  invalidateAllCaches,
  avatarConfigCache,
  botTokenCache,
  resetCacheStats,
  AVATAR_CONFIG_CACHE_TTL_MS,
  SECRET_CACHE_TTL_MS,
  getAvatarIds,
  getAvatarConfigCached,
  parseDiscordTokenSecret,
};
