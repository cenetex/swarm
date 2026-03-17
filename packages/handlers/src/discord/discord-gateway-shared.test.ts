/**
 * Discord Gateway Shared — Integration Tests
 *
 * Tests for the multi-tenant Discord Gateway worker covering:
 * - Connection lifecycle (connect, heartbeat, reconnect, graceful shutdown)
 * - Error scenarios (WebSocket disconnection, rate limiting, invalid token, session invalidation)
 * - Message routing (MESSAGE_CREATE → SQS dispatch with correct avatar context)
 * - Multi-tenant avatar-to-bot-token mapping and cache invalidation
 * - Token parsing (JSON-wrapped and plain string formats)
 *
 * Uses bun:test. Mocks WebSocket, AWS SDK clients, and @swarm/core services
 * to avoid live Discord API calls.
 *
 * @see packages/handlers/src/discord/discord-gateway-shared.ts
 * Closes #1066
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';

// ─── Mock WebSocket ────────────────────────────────────────────────────────

/** Minimal mock WebSocket that emits events like the real `ws` library */
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }

  removeAllListeners() {
    super.removeAllListeners();
    return this;
  }
}

// Track instances so tests can interact with the "server side"
let wsInstances: MockWebSocket[] = [];

function createMockWs() {
  const instance = new MockWebSocket();
  wsInstances.push(instance);
  // Emit 'open' asynchronously to mirror real ws behavior
  setTimeout(() => instance.emit('open'), 0);
  return instance;
}

// ─── Mock modules (must be before import of SUT) ──────────────────────────

// Set required environment variables before the module loads
process.env.STATE_TABLE = 'test-state-table';
process.env.MESSAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';
process.env.SECRET_PREFIX = 'test-swarm';
process.env.ACTIVITY_TABLE = 'test-activity-table';
process.env.ENVIRONMENT = 'test';

// Mock ws module
mock.module('ws', () => ({
  default: Object.assign(
    function WebSocket() { return createMockWs(); },
    { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }
  ),
  WebSocket: Object.assign(
    function WebSocket() { return createMockWs(); },
    { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }
  ),
}));

// Mock SQS send
const mockSendSqsMessage = mock(() => Promise.resolve());
mock.module('../services/sqs-send.js', () => ({
  sendSqsMessage: mockSendSqsMessage,
}));

// Mock room ingress
const mockProcessSharedRoomMessage = mock(() => Promise.resolve({ isNew: false }));
const mockBuildRoomKey = mock((platform: string, channelId: string) => `${platform}:${channelId}`);
const mockIsSharedRoom = mock(() => Promise.resolve(false));
const mockRegisterChannelAvatarResolver = mock(() => {});

mock.module('../services/room-ingress.js', () => ({
  processSharedRoomMessage: mockProcessSharedRoomMessage,
  buildRoomKey: mockBuildRoomKey,
  isSharedRoom: mockIsSharedRoom,
  registerChannelAvatarResolver: mockRegisterChannelAvatarResolver,
}));

// Mock AWS SDK clients
mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class MockSQSClient {
    send() { return Promise.resolve({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123456789:test-queue' } }); }
    destroy() {}
  },
  GetQueueAttributesCommand: class MockGetQueueAttributesCommand {
    constructor(public input: unknown) {}
  },
}));

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class MockSecretsManagerClient {
    send() { return Promise.resolve({ SecretString: '{"DISCORD_BOT_TOKEN":"mock-bot-token-123"}' }); }
  },
  GetSecretValueCommand: class MockGetSecretValueCommand {
    constructor(public input: unknown) {}
  },
}));

// Mock @swarm/core
const mockBuildDiscordEnvelope = mock(() => ({
  messageId: 'msg-123',
  conversationId: 'channel-123',
  sender: { id: 'user-1', username: 'testuser', displayName: 'Test User', isBot: false },
  content: { text: 'hello world' },
  timestamp: Date.now(),
  metadata: { idempotencyKey: 'idem-123', shouldRespond: false, responseReason: '', priority: 0 },
  traceId: '',
}));

const mockCreateStateService = mock(() => ({
  listAvatars: mock(() => Promise.resolve(['avatar-1', 'avatar-2'])),
  getAvatarConfigWithStatus: mock((id: string) => {
    if (id === 'avatar-1') {
      return Promise.resolve({
        config: {
          name: 'TestBot',
          platforms: {
            discord: {
              enabled: true,
              mode: 'bot',
              allowedGuilds: ['guild-1'],
              allowedChannels: ['channel-1'],
            },
          },
          behavior: { ignoreBots: true },
        },
        status: 'active' as const,
      });
    }
    if (id === 'avatar-2') {
      return Promise.resolve({
        config: {
          name: 'TestBot2',
          platforms: {
            discord: {
              enabled: true,
              mode: 'global',
            },
          },
          behavior: { ignoreBots: true },
        },
        status: 'active' as const,
      });
    }
    return Promise.resolve(null);
  }),
  checkAndSetIdempotency: mock(() => Promise.resolve(true)),
  addMessageToChannel: mock(() => Promise.resolve()),
}));

const mockCreateMessageEvaluator = mock(() => ({
  evaluate: mock(() => Promise.resolve({
    shouldRespond: true,
    reason: 'direct_mention',
    priority: 1,
    admitToContext: true,
  })),
}));

const mockCreateActivityService = mock(() => ({
  logMessageReceived: mock(() => Promise.resolve()),
}));

const mockLogIntentValidation = mock(() => ({
  valid: true,
  missingRequired: [],
  missingRecommended: [],
  enabledIntents: ['GUILDS', 'GUILD_MESSAGES', 'MESSAGE_CONTENT'],
  diagnostics: ['All required and recommended intents are enabled'],
}));

const mockLogGatewayClose = mock((code: number) => ({
  code,
  description: code === 4004 ? 'Authentication failed' : 'Normal closure',
  reconnectable: code !== 4004 && code !== 4010 && code !== 4013 && code !== 4014,
  severity: code >= 4004 ? 'error' : 'info',
  remediation: code === 4004 ? 'INVALID BOT TOKEN' : undefined,
}));

const mockComputeReconnectDelay = mock((_code: number, _attempt: number) => 100);

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  setContext: mock(() => {}),
};

const mockDiscordRateLimiter = class {
  constructor() {}
};

mock.module('@swarm/core', () => ({
  buildDiscordEnvelope: mockBuildDiscordEnvelope,
  createStateService: mockCreateStateService,
  createMessageEvaluator: mockCreateMessageEvaluator,
  createActivityService: mockCreateActivityService,
  logger: mockLogger,
  DiscordRateLimiter: mockDiscordRateLimiter,
  logIntentValidation: mockLogIntentValidation,
  logGatewayClose: mockLogGatewayClose,
  computeReconnectDelay: mockComputeReconnectDelay,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────

const {
  GatewayConnection,
  parseDiscordTokenSecret,
  invalidateAllCaches,
  avatarConfigCache,
  botTokenCache,
  resetCacheStats,
  verifyQueueReachable,
} = await import('./discord-gateway-shared.js');

// ─── Helpers ─────────────────────────────────────────────────────────────

function getLatestWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1];
}

/** Simulate server sending a Gateway payload to the latest WS */
function serverSend(ws: MockWebSocket, payload: { op: number; d?: unknown; s?: number | null; t?: string }) {
  ws.emit('message', Buffer.from(JSON.stringify(payload)));
}

/** Parse sent payloads from the mock WS */
function parseSent(ws: MockWebSocket): Array<{ op: number; d?: unknown }> {
  return ws.sentMessages.map(m => JSON.parse(m));
}

/** Wait for microtasks/timers to flush */
function tick(ms = 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Discord Gateway Shared', () => {
  beforeEach(() => {
    wsInstances = [];
    mockSendSqsMessage.mockClear();
    mockBuildDiscordEnvelope.mockClear();
    mockIsSharedRoom.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  // ── Token Parsing ──────────────────────────────────────────────────────

  describe('parseDiscordTokenSecret', () => {
    it('should parse DISCORD_BOT_TOKEN from JSON blob', () => {
      expect(parseDiscordTokenSecret('{"DISCORD_BOT_TOKEN":"abc123"}')).toBe('abc123');
    });

    it('should parse discord_bot_token (lowercase) from JSON blob', () => {
      expect(parseDiscordTokenSecret('{"discord_bot_token":"xyz789"}')).toBe('xyz789');
    });

    it('should parse token key from JSON blob', () => {
      expect(parseDiscordTokenSecret('{"token":"tok-456"}')).toBe('tok-456');
    });

    it('should return raw string when not JSON', () => {
      expect(parseDiscordTokenSecret('plain-token-string')).toBe('plain-token-string');
    });

    it('should return raw string when JSON has no recognized keys', () => {
      const raw = '{"unrelated":"value"}';
      // Falls back to raw because none of the known keys exist → returns raw
      expect(parseDiscordTokenSecret(raw)).toBe(raw);
    });

    it('should prefer DISCORD_BOT_TOKEN over other keys', () => {
      expect(parseDiscordTokenSecret('{"DISCORD_BOT_TOKEN":"first","token":"second"}')).toBe('first');
    });
  });

  // ── GatewayConnection Lifecycle ────────────────────────────────────────

  describe('GatewayConnection', () => {
    let conn: InstanceType<typeof GatewayConnection>;

    beforeEach(() => {
      conn = new GatewayConnection('test-bot-token', 0x8201); // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
    });

    afterEach(() => {
      conn.stop();
    });

    it('should start and create a WebSocket connection', async () => {
      conn.start();
      await tick();
      expect(wsInstances.length).toBeGreaterThanOrEqual(1);
    });

    it('should send IDENTIFY (op 2) after receiving HELLO (op 10)', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      const sent = parseSent(ws);
      // Should have sent heartbeat (op 1) and identify (op 2)
      const identify = sent.find(m => m.op === 2);
      expect(identify).toBeDefined();
      expect((identify!.d as Record<string, unknown>).token).toBe('test-bot-token');
    });

    it('should send heartbeat (op 1) on receiving HELLO', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      const sent = parseSent(ws);
      const heartbeat = sent.find(m => m.op === 1);
      expect(heartbeat).toBeDefined();
    });

    it('should track sequence numbers from dispatches', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      // Send a dispatch with sequence 42
      serverSend(ws, { op: 0, s: 42, t: 'GUILD_CREATE', d: { id: 'guild-1' } });
      await tick();

      // Next heartbeat should include sequence 42
      ws.sentMessages = [];
      serverSend(ws, { op: 1, d: null }); // Server requests heartbeat
      await tick();

      const sent = parseSent(ws);
      const hb = sent.find(m => m.op === 1);
      expect(hb).toBeDefined();
      expect(hb!.d).toBe(42);
    });

    it('should handle READY dispatch and store session info', async () => {
      conn.addAvatar({
        avatarId: 'avatar-1',
        config: { name: 'Test', platforms: { discord: { enabled: true } } } as any,
        botToken: 'test-bot-token',
      });

      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: {
          session_id: 'sess-abc',
          resume_gateway_url: 'wss://resume.discord.gg',
          user: { id: 'bot-user-123', username: 'testbot' },
        },
      });
      await tick();

      expect(conn.getBotUserId()).toBe('bot-user-123');
    });

    it('should set botUserId on all avatar bindings after READY', async () => {
      const binding = {
        avatarId: 'avatar-1',
        config: { name: 'Test', platforms: { discord: { enabled: true } } } as any,
        botToken: 'test-bot-token',
      };
      conn.addAvatar(binding);

      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: {
          session_id: 'sess-abc',
          resume_gateway_url: 'wss://resume.discord.gg',
          user: { id: 'bot-user-999', username: 'testbot' },
        },
      });
      await tick();

      expect(binding.botUserId).toBe('bot-user-999');
    });

    it('should respond to server-requested heartbeat (op 1)', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();
      ws.sentMessages = [];

      // Server requests an immediate heartbeat
      serverSend(ws, { op: 1, d: null });
      await tick();

      const sent = parseSent(ws);
      expect(sent.some(m => m.op === 1)).toBe(true);
    });

    it('should handle heartbeat ACK (op 11) without error', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      // Should not throw
      serverSend(ws, { op: 11, d: null });
      await tick();
    });

    it('should clamp heartbeat interval below minimum to 10s', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      // Send HELLO with heartbeat interval below the 10s minimum
      serverSend(ws, { op: 10, d: { heartbeat_interval: 1000 } });
      await tick();

      // Logger should have warned about clamping
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should clamp heartbeat interval above maximum to 120s', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 200000 } });
      await tick();

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should report isConnected as true when WebSocket is open', async () => {
      conn.start();
      await tick();

      expect(conn.isConnected).toBe(true);
    });

    it('should report isConnected as false after stop()', async () => {
      conn.start();
      await tick();

      conn.stop();
      expect(conn.isConnected).toBe(false);
    });

    it('should not send on closed WebSocket', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();
      ws.readyState = MockWebSocket.CLOSED;

      // HELLO should not cause a send since WS is closed
      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      expect(ws.sentMessages.length).toBe(0);
    });
  });

  // ── Reconnect Behavior ─────────────────────────────────────────────────

  describe('Reconnect behavior', () => {
    let conn: InstanceType<typeof GatewayConnection>;

    beforeEach(() => {
      conn = new GatewayConnection('test-bot-token', 0x8201);
    });

    afterEach(() => {
      conn.stop();
    });

    it('should not reconnect on non-reconnectable close code (4004)', async () => {
      mockLogGatewayClose.mockImplementationOnce(() => ({
        code: 4004,
        description: 'Authentication failed',
        reconnectable: false,
        severity: 'error' as const,
        remediation: 'INVALID BOT TOKEN',
      }));

      conn.start();
      await tick();
      const ws = getLatestWs();
      const initialCount = wsInstances.length;

      ws.emit('close', 4004, Buffer.from('Authentication failed'));
      await tick(200);

      // Should NOT have created a new connection
      expect(wsInstances.length).toBe(initialCount);
    });

    it('should schedule reconnect on reconnectable close code (1006)', async () => {
      mockLogGatewayClose.mockImplementationOnce(() => ({
        code: 1006,
        description: 'Abnormal closure',
        reconnectable: true,
        severity: 'warn' as const,
      }));

      conn.start();
      await tick();
      const ws = getLatestWs();

      ws.emit('close', 1006, Buffer.from('Abnormal closure'));
      // The internal scheduleReconnect uses exponential backoff (1s base),
      // so wait long enough for the reconnect timer to fire
      await tick(1500);

      // Should have logged reconnect scheduling
      const infoCalls = mockLogger.info.mock.calls as unknown[][];
      const reconnectLog = infoCalls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('Scheduling gateway reconnect')
      );
      expect(reconnectLog).toBeDefined();
    });

    it('should clear session state on close code 4007 (invalid sequence)', async () => {
      mockLogGatewayClose.mockImplementationOnce(() => ({
        code: 4007,
        description: 'Invalid sequence',
        reconnectable: true,
        severity: 'warn' as const,
      }));

      conn.start();
      await tick();
      const ws = getLatestWs();

      // Establish session first
      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();
      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: { session_id: 'sess-123', user: { id: 'bot-1', username: 'bot' } },
      });
      await tick();

      // Close with 4007
      ws.emit('close', 4007, Buffer.from('Invalid sequence'));
      await tick(200);

      // Should have logged warning about session invalidation
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should clear session state on close code 4009 (session timed out)', async () => {
      mockLogGatewayClose.mockImplementationOnce(() => ({
        code: 4009,
        description: 'Session timed out',
        reconnectable: true,
        severity: 'info' as const,
      }));

      conn.start();
      await tick();
      const ws = getLatestWs();

      ws.emit('close', 4009, Buffer.from('Session timed out'));
      await tick(200);

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ── INVALID_SESSION (op 9) ─────────────────────────────────────────────

  describe('INVALID_SESSION handling', () => {
    let conn: InstanceType<typeof GatewayConnection>;

    beforeEach(() => {
      conn = new GatewayConnection('test-bot-token', 0x8201);
    });

    afterEach(() => {
      conn.stop();
    });

    it('should handle resumable invalid session (op 9, d=true)', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      // Invalid session but resumable
      serverSend(ws, { op: 9, d: true });
      await tick();

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle non-resumable invalid session (op 9, d=false)', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      // Invalid session, not resumable
      serverSend(ws, { op: 9, d: false });
      await tick();

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ── RECONNECT (op 7) ──────────────────────────────────────────────────

  describe('RECONNECT request from server', () => {
    it('should handle server-requested reconnect (op 7)', async () => {
      const conn = new GatewayConnection('test-bot-token', 0x8201);
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      serverSend(ws, { op: 7, d: null });
      await tick();

      expect(mockLogger.warn).toHaveBeenCalled();
      conn.stop();
    });
  });

  // ── Message Routing ────────────────────────────────────────────────────

  describe('MESSAGE_CREATE routing', () => {
    let conn: InstanceType<typeof GatewayConnection>;

    beforeEach(() => {
      conn = new GatewayConnection('test-bot-token', 0x8201);
      conn.addAvatar({
        avatarId: 'avatar-1',
        config: {
          name: 'TestBot',
          platforms: {
            discord: {
              enabled: true,
              mode: 'bot',
              allowedGuilds: ['guild-1'],
              allowedChannels: ['channel-1'],
            },
          },
          behavior: { ignoreBots: true },
        } as any,
        botToken: 'test-bot-token',
        botUserId: 'bot-user-123',
      });
    });

    afterEach(() => {
      conn.stop();
    });

    it('should route MESSAGE_CREATE through handleDiscordMessage', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      // Simulate READY so botUserId is set
      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: { session_id: 'sess-1', user: { id: 'bot-user-123', username: 'bot' } },
      });
      await tick();

      // Now send a MESSAGE_CREATE
      serverSend(ws, {
        op: 0, s: 2, t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-001',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'Hello bot!',
          author: { id: 'user-42', username: 'human', bot: false },
        },
      });
      await tick(50);

      // buildDiscordEnvelope should have been called
      expect(mockBuildDiscordEnvelope).toHaveBeenCalled();
    });

    it('should send message to SQS when evaluation says shouldRespond', async () => {
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();
      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: { session_id: 'sess-1', user: { id: 'bot-user-123', username: 'bot' } },
      });
      await tick();

      serverSend(ws, {
        op: 0, s: 2, t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-002',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'Hey!',
          author: { id: 'user-42', username: 'human', bot: false },
        },
      });
      await tick(50);

      expect(mockSendSqsMessage).toHaveBeenCalled();
    });

    it('should not process messages when no eligible avatars exist', async () => {
      // Create a connection with no avatar bindings
      const emptyConn = new GatewayConnection('test-bot-token-2', 0x8201);
      emptyConn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();
      serverSend(ws, {
        op: 0, s: 1, t: 'READY',
        d: { session_id: 'sess-2', user: { id: 'bot-user-456', username: 'bot2' } },
      });
      await tick();

      mockBuildDiscordEnvelope.mockClear();
      serverSend(ws, {
        op: 0, s: 2, t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-003',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'Nobody home',
          author: { id: 'user-42', username: 'human', bot: false },
        },
      });
      await tick(50);

      // No avatars bound → no processing
      expect(mockBuildDiscordEnvelope).not.toHaveBeenCalled();
      emptyConn.stop();
    });
  });

  // ── Avatar Binding Management ──────────────────────────────────────────

  describe('Avatar binding management', () => {
    it('should add and remove avatar bindings', () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      const binding = {
        avatarId: 'avatar-1',
        config: { name: 'Bot1', platforms: { discord: { enabled: true } } } as any,
        botToken: 'test-token',
      };

      conn.addAvatar(binding);
      expect(conn.avatarBindings.size).toBe(1);
      expect(conn.avatarBindings.has('avatar-1')).toBe(true);

      conn.removeAvatar('avatar-1');
      expect(conn.avatarBindings.size).toBe(0);
    });

    it('should support multiple avatars on one connection', () => {
      const conn = new GatewayConnection('shared-token', 0x8201);

      conn.addAvatar({
        avatarId: 'avatar-1',
        config: { name: 'Bot1', platforms: { discord: { enabled: true } } } as any,
        botToken: 'shared-token',
      });
      conn.addAvatar({
        avatarId: 'avatar-2',
        config: { name: 'Bot2', platforms: { discord: { enabled: true } } } as any,
        botToken: 'shared-token',
      });

      expect(conn.avatarBindings.size).toBe(2);
    });

    it('should return null for botUserId before READY', () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      expect(conn.getBotUserId()).toBeNull();
    });
  });

  // ── Cache Management ───────────────────────────────────────────────────

  describe('Cache management', () => {
    it('should clear all caches on invalidateAllCaches()', () => {
      avatarConfigCache.set('test', {
        config: {} as any,
        status: 'active' as const,
        expiresAt: Date.now() + 60000,
      });
      botTokenCache.set('test', { value: 'tok', expiresAt: Date.now() + 60000 });

      invalidateAllCaches();

      expect(avatarConfigCache.size).toBe(0);
      expect(botTokenCache.size).toBe(0);
    });

    it('should reset and return cache stats', () => {
      const stats = resetCacheStats();
      expect(stats).toHaveProperty('avatarListHits');
      expect(stats).toHaveProperty('avatarListMisses');
      expect(stats).toHaveProperty('avatarConfigHits');
      expect(stats).toHaveProperty('avatarConfigMisses');
      expect(stats).toHaveProperty('secretHits');
      expect(stats).toHaveProperty('secretMisses');

      // After reset, all should be 0
      const afterReset = resetCacheStats();
      expect(afterReset.avatarListHits).toBe(0);
      expect(afterReset.avatarConfigHits).toBe(0);
      expect(afterReset.secretHits).toBe(0);
    });
  });

  // ── Graceful Shutdown ──────────────────────────────────────────────────

  describe('Graceful shutdown', () => {
    it('should clean up timers and close WebSocket on stop()', async () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      conn.start();
      await tick();
      const ws = getLatestWs();

      // Start heartbeat by sending HELLO
      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      conn.stop();

      expect(conn.isConnected).toBe(false);
    });

    it('should not reconnect after being destroyed', async () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      conn.start();
      await tick();

      conn.stop(); // sets destroyed = true

      const countBefore = wsInstances.length;
      // start() after stop() should not create new connections
      // (internal destroyed flag prevents connect)
      await tick(200);

      expect(wsInstances.length).toBe(countBefore);
    });
  });

  // ── WebSocket Error Handling ───────────────────────────────────────────

  describe('WebSocket error handling', () => {
    it('should log WebSocket errors without crashing', async () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      conn.start();
      await tick();
      const ws = getLatestWs();

      ws.emit('error', new Error('Connection reset'));
      await tick();

      expect(mockLogger.error).toHaveBeenCalled();
      conn.stop();
    });

    it('should handle malformed JSON in gateway payload', async () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      conn.start();
      await tick();
      const ws = getLatestWs();

      ws.emit('message', Buffer.from('not valid json'));
      await tick();

      expect(mockLogger.error).toHaveBeenCalled();
      conn.stop();
    });
  });

  // ── SQS Queue Preflight ────────────────────────────────────────────────

  describe('verifyQueueReachable', () => {
    it('should succeed when queue exists', async () => {
      // Default mock returns successful response
      await expect(verifyQueueReachable('https://sqs.us-east-1.amazonaws.com/123/test-queue'))
        .resolves.toBeUndefined();
    });
  });

  // ── RESUMED Event ──────────────────────────────────────────────────────

  describe('RESUMED event', () => {
    it('should handle RESUMED dispatch without error', async () => {
      const conn = new GatewayConnection('test-token', 0x8201);
      conn.start();
      await tick();
      const ws = getLatestWs();

      serverSend(ws, { op: 10, d: { heartbeat_interval: 41250 } });
      await tick();

      serverSend(ws, { op: 0, s: 5, t: 'RESUMED', d: {} });
      await tick();

      // Should not throw, just log
      conn.stop();
    });
  });
});
