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
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'node:crypto';
import {
  buildDiscordEnvelope,
  createStateService,
  createMessageEvaluator,
  createActivityService,
  logger,
  type AvatarConfig,
  type DiscordMessage,
  type Platform,
} from '@swarm/core';

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

// ─── Avatar Discovery ────────────────────────────────────────────────────────

/** Represents a Discord-enabled avatar with its runtime config */
interface DiscordAvatarBinding {
  avatarId: string;
  config: AvatarConfig;
  botToken: string;
  botUserId?: string;
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
  } catch (err) {
    logger.error('Failed to discover Discord avatars', err, {
      event: 'avatar_discovery_error',
      subsystem: 'discord',
    });
  }

  return bindings;
}

// ─── Message Handling ────────────────────────────────────────────────────────

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
    ignoreBots: config.behavior?.ignoreBots ?? true,
  });

  if (!envelope) return;

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
  if (!evaluation.shouldRespond) {
    logger.info('Not responding to Discord message', { reason: evaluation.reason });
    return;
  }

  envelope.metadata.shouldRespond = evaluation.shouldRespond;
  envelope.metadata.responseReason = evaluation.reason;
  envelope.metadata.priority = evaluation.priority;

  // Store in channel history
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
      logger.warn('Discord gateway closed', {
        event: 'gateway_closed',
        subsystem: 'discord',
        code,
        reason: reason.toString(),
      });
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
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), hello.heartbeat_interval);

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

      logger.info('Discord gateway ready', {
        event: 'gateway_ready',
        subsystem: 'discord',
        botUserId: this.botUserId,
        botUsername: this.botUsername,
        avatarCount: this.avatarBindings.size,
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

      // Route to all avatar bindings that should handle this message
      for (const binding of this.avatarBindings.values()) {
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

  private sendHeartbeat(): void {
    this.send({ op: 1, d: this.sequence });
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

  private scheduleReconnect(resume = true): void {
    if (this.destroyed) return;

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.shouldResume = resume;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;

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
  // Export caching internals for testing
  invalidateAllCaches,
  avatarConfigCache,
  botTokenCache,
  resetCacheStats,
  AVATAR_CONFIG_CACHE_TTL_MS,
  SECRET_CACHE_TTL_MS,
  getAvatarIds,
  getAvatarConfigCached,
};
