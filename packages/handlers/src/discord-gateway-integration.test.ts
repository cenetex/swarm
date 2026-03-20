/**
 * Discord Gateway Integration Tests
 *
 * Covers the full connection lifecycle, message routing, error scenarios,
 * and multi-tenant avatar binding. See issue #1066 and #1103.
 *
 * Mocks WebSocket, AWS SDK clients, and core services to test the
 * gateway logic in isolation without live Discord API calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Mock Tracking ────────────────────────────────────────────────────────────

/** Captured SQS messages for assertion */
const sqsSentMessages: Array<{ input: unknown }> = [];

/** Captured WebSocket sends for assertion */
const wsSentPayloads: Array<unknown> = [];

/** All MockWebSocket instances created (for resume/reconnect tests) */
const wsInstances: MockWebSocket[] = [];

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1; // OPEN
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor() {
    wsInstances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
  send(data: string) {
    wsSentPayloads.push(JSON.parse(data));
  }

  /** Test helper: emit a WebSocket event */
  _emit(event: string, ...args: unknown[]) {
    const list = this.handlers.get(event) || [];
    for (const fn of list) fn(...args);
  }
}

mock.module('ws', () => ({
  default: MockWebSocket,
  WebSocket: MockWebSocket,
  __esModule: true,
}));

// ─── Mock AWS SDK ─────────────────────────────────────────────────────────────

mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send(cmd: unknown) {
      sqsSentMessages.push({ input: (cmd as { input: unknown }).input });
      return Promise.resolve({});
    }
    destroy() {}
  },
  GetQueueAttributesCommand: class { constructor(public input: unknown) {} },
  SendMessageCommand: class { constructor(public input: unknown) {} },
  ReceiveMessageCommand: class { constructor(public input: unknown) {} },
  DeleteMessageCommand: class { constructor(public input: unknown) {} },
}));

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send() { return Promise.resolve({}); } },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
  CreateSecretCommand: class { constructor(public input: unknown) {} },
  UpdateSecretCommand: class { constructor(public input: unknown) {} },
  DeleteSecretCommand: class { constructor(public input: unknown) {} },
  DescribeSecretCommand: class { constructor(public input: unknown) {} },
  RestoreSecretCommand: class { constructor(public input: unknown) {} },
  PutSecretValueCommand: class { constructor(public input: unknown) {} },
}));

// ─── Mock DynamoDB (for stateService used in MESSAGE_CREATE path) ────────────

mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send() { return Promise.resolve({}); }
    destroy() {}
  },
}));

mock.module('@aws-sdk/lib-dynamodb', () => {
  class StubCommand { constructor(public input: unknown) {} }
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        send: () => Promise.resolve({ Item: null, Items: [], Attributes: {} }),
        destroy: () => {},
      }),
    },
    GetCommand: StubCommand,
    PutCommand: StubCommand,
    QueryCommand: StubCommand,
    ScanCommand: StubCommand,
    UpdateCommand: StubCommand,
    DeleteCommand: StubCommand,
    BatchGetCommand: StubCommand,
    BatchWriteCommand: StubCommand,
    TransactGetCommand: StubCommand,
    TransactWriteCommand: StubCommand,
    ExecuteStatementCommand: StubCommand,
    ExecuteTransactionCommand: StubCommand,
    BatchExecuteStatementCommand: StubCommand,
    DynamoDBDocumentClientCommand: StubCommand,
  };
});

// ─── Mock S3 (for sqs-offload) ──────────────────────────────────────────────

mock.module('@aws-sdk/client-s3', () => {
  class StubS3Command { constructor(public input: unknown) {} }
  return {
    S3Client: class {
      send() { return Promise.resolve({}); }
      destroy() {}
    },
    PutObjectCommand: StubS3Command,
    GetObjectCommand: StubS3Command,
    DeleteObjectCommand: StubS3Command,
    ListObjectsV2Command: StubS3Command,
  };
});

// ─── Module Types ─────────────────────────────────────────────────────────────

type GatewayConnectionClass = typeof import('./discord/discord-gateway-shared.js').GatewayConnection;

interface GatewayInternals {
  ws: MockWebSocket | null;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatAckAt: number | null;
  heartbeatAckTimeoutTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatIntervalMs: number | null;
  reconnectAttempts: number;
  destroyed: boolean;
  sessionId: string | null;
  sequence: number | null;
  resumeGatewayUrl: string | null;
  shouldResume: boolean;
  botUserId: string | null;
  botUsername: string | null;
}

let GatewayConnection: GatewayConnectionClass;
let previousStateTable: string | undefined;
let previousMessageQueueUrl: string | undefined;

beforeAll(async () => {
  previousStateTable = process.env.STATE_TABLE;
  previousMessageQueueUrl = process.env.MESSAGE_QUEUE_URL;
  process.env.STATE_TABLE = 'test-state-table';
  process.env.MESSAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';

  ({ GatewayConnection } = await import('./discord/discord-gateway-shared.js'));
});

afterAll(() => {
  if (previousStateTable === undefined) {
    delete process.env.STATE_TABLE;
  } else {
    process.env.STATE_TABLE = previousStateTable;
  }
  if (previousMessageQueueUrl === undefined) {
    delete process.env.MESSAGE_QUEUE_URL;
  } else {
    process.env.MESSAGE_QUEUE_URL = previousMessageQueueUrl;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flush microtask queue to let async handlers resolve */
function flushPromises(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createConnection(token = 'fake-bot-token') {
  const conn = new GatewayConnection(token, 0);
  conn.start();
  const internals = conn as unknown as GatewayInternals;
  const ws = internals.ws!;
  return { conn, ws, internals };
}

function sendPayload(ws: MockWebSocket, payload: Record<string, unknown>) {
  ws._emit('message', Buffer.from(JSON.stringify(payload)));
}

function sendHello(ws: MockWebSocket, heartbeatInterval = 41_250) {
  sendPayload(ws, { op: 10, d: { heartbeat_interval: heartbeatInterval } });
}

function sendReady(ws: MockWebSocket, overrides: Record<string, unknown> = {}) {
  sendPayload(ws, {
    op: 0,
    s: 1,
    t: 'READY',
    d: {
      session_id: 'test-session-id',
      resume_gateway_url: 'wss://resume.discord.gg',
      user: { id: '111222333', username: 'TestBot' },
      ...overrides,
    },
  });
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-001',
    channel_id: 'ch-100',
    guild_id: 'guild-200',
    author: { id: 'user-300', username: 'TestUser', bot: false },
    content: 'Hello from integration test',
    timestamp: new Date().toISOString(),
    mentions: [],
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

function makeAvatarBinding(overrides: Record<string, unknown> = {}) {
  return {
    avatarId: 'avatar-test-001',
    config: {
      avatarId: 'avatar-test-001',
      name: 'TestAvatar',
      platforms: {
        discord: {
          enabled: true,
          allowedGuilds: [],
          allowedChannels: [],
        },
      },
      behavior: { ignoreBots: true },
    },
    botToken: 'fake-bot-token',
    botUserId: undefined,
    isGlobalMode: false,
    ...overrides,
  };
}

/** Complete the full HELLO → IDENTIFY → READY handshake */
function doHandshake(ws: MockWebSocket) {
  sendHello(ws);
  sendReady(ws);
}

// ===========================================================================
// Connection Lifecycle
// ===========================================================================

describe('Connection lifecycle', () => {
  it('sends IDENTIFY after receiving HELLO', () => {
    const { conn, ws } = createConnection();
    wsSentPayloads.length = 0;

    sendHello(ws);

    // First payload after HELLO is the heartbeat (op 1), then IDENTIFY (op 2)
    const identifyPayload = wsSentPayloads.find(
      (p: any) => p.op === 2
    ) as any;
    expect(identifyPayload).toBeTruthy();
    expect(identifyPayload.d.token).toBe('fake-bot-token');
    expect(identifyPayload.d.properties.browser).toBe('swarm');

    conn.stop();
  });

  it('sets session state after READY dispatch', () => {
    const { conn, ws, internals } = createConnection();

    doHandshake(ws);

    expect(internals.sessionId).toBe('test-session-id');
    expect(internals.resumeGatewayUrl).toBe('wss://resume.discord.gg');
    expect(internals.botUserId).toBe('111222333');
    expect(internals.botUsername).toBe('TestBot');
    expect(internals.shouldResume).toBe(true);
    expect(internals.reconnectAttempts).toBe(0);

    conn.stop();
  });

  it('starts heartbeat timer after HELLO', () => {
    const { conn, ws, internals } = createConnection();

    sendHello(ws, 41_250);

    expect(internals.heartbeatTimer).not.toBeNull();
    expect(internals.heartbeatIntervalMs).toBe(41_250);

    conn.stop();
  });

  it('cleans up all timers and WebSocket on stop()', () => {
    const { conn, ws, internals } = createConnection();

    doHandshake(ws);

    expect(internals.heartbeatTimer).not.toBeNull();
    expect(internals.ws).not.toBeNull();

    conn.stop();

    expect(internals.heartbeatTimer).toBeNull();
    expect(internals.heartbeatAckTimeoutTimer).toBeNull();
    expect(internals.ws).toBeNull();
    expect(internals.destroyed).toBe(true);
  });

  it('does not reconnect after stop() + destroy', () => {
    const { conn, internals } = createConnection();

    conn.stop();

    expect(internals.destroyed).toBe(true);
    // reconnectAttempts should not increment after stop
    const attempts = internals.reconnectAttempts;
    expect(attempts).toBe(0);
  });

  it('updates sequence number from dispatch payloads', () => {
    const { conn, ws, internals } = createConnection();

    sendHello(ws);
    sendPayload(ws, { op: 0, s: 42, t: 'READY', d: { session_id: 'sess', user: { id: '1', username: 'B' } } });

    expect(internals.sequence).toBe(42);

    conn.stop();
  });
});

// ===========================================================================
// Error Scenarios
// ===========================================================================

describe('Error scenarios', () => {
  it('marks connection as non-reconnectable on close code 4004 (auth failed)', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    // Simulate close with 4004
    ws._emit('close', 4004, Buffer.from('Authentication failed'));

    expect(internals.destroyed).toBe(true);
    conn.stop();
  });

  it('clears session state on close code 4007 (invalid sequence)', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    expect(internals.sessionId).toBe('test-session-id');

    ws._emit('close', 4007, Buffer.from('Invalid seq'));

    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();
    expect(internals.resumeGatewayUrl).toBeNull();

    conn.stop();
  });

  it('clears session state on close code 4009 (session timed out)', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    ws._emit('close', 4009, Buffer.from('Session timed out'));

    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();

    conn.stop();
  });

  it('handles INVALID_SESSION (op 9, resumable=true) with resume flag', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    sendPayload(ws, { op: 9, d: true });

    // Should still have session info (resumable)
    expect(internals.shouldResume).toBe(true);

    conn.stop();
  });

  it('handles INVALID_SESSION (op 9, resumable=false) by clearing session', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    sendPayload(ws, { op: 9, d: false });

    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();
    expect(internals.resumeGatewayUrl).toBeNull();
    expect(internals.shouldResume).toBe(false);

    conn.stop();
  });

  it('handles server-requested reconnect (op 7)', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);

    const attemptsBefore = internals.reconnectAttempts;

    sendPayload(ws, { op: 7 });

    // Should schedule reconnect with resume=true
    expect(internals.shouldResume).toBe(true);
    expect(internals.heartbeatTimer).toBeNull();
    expect(internals.reconnectAttempts).toBeGreaterThan(attemptsBefore);

    conn.stop();
  });

  it('responds to server-requested heartbeat (op 1)', () => {
    const { conn, ws } = createConnection();
    doHandshake(ws);
    wsSentPayloads.length = 0;

    sendPayload(ws, { op: 1 });

    const heartbeats = wsSentPayloads.filter((p: any) => p.op === 1);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    conn.stop();
  });

  it('does not crash on malformed JSON payload', () => {
    const { conn, ws } = createConnection();
    doHandshake(ws);

    // Should not throw
    ws._emit('message', Buffer.from('not valid json {{{'));

    conn.stop();
  });

  it('handles WebSocket error event without crashing', () => {
    const { conn, ws } = createConnection();
    doHandshake(ws);

    // Should not throw
    ws._emit('error', new Error('Connection reset'));

    conn.stop();
  });
});

// ===========================================================================
// Multi-tenant Avatar Binding
// ===========================================================================

describe('Multi-tenant avatar binding', () => {
  it('adds and removes avatar bindings', () => {
    const conn = new GatewayConnection('token-1', 0);
    const binding1 = makeAvatarBinding({ avatarId: 'avatar-1' });
    const binding2 = makeAvatarBinding({ avatarId: 'avatar-2' });

    conn.addAvatar(binding1 as any);
    conn.addAvatar(binding2 as any);
    expect(conn.avatarBindings.size).toBe(2);

    conn.removeAvatar('avatar-1');
    expect(conn.avatarBindings.size).toBe(1);
    expect(conn.avatarBindings.has('avatar-2')).toBe(true);
  });

  it('propagates botUserId to all bindings on READY', () => {
    const { conn, ws } = createConnection();
    const binding1 = makeAvatarBinding({ avatarId: 'a1' });
    const binding2 = makeAvatarBinding({ avatarId: 'a2' });
    conn.addAvatar(binding1 as any);
    conn.addAvatar(binding2 as any);

    doHandshake(ws);

    for (const binding of conn.avatarBindings.values()) {
      expect(binding.botUserId).toBe('111222333');
    }

    conn.stop();
  });

  it('returns botUserId via getBotUserId() after READY', () => {
    const { conn, ws } = createConnection();
    expect(conn.getBotUserId()).toBeNull();

    doHandshake(ws);
    expect(conn.getBotUserId()).toBe('111222333');

    conn.stop();
  });

  it('reports isConnected correctly', () => {
    const { conn, internals } = createConnection();
    expect(conn.isConnected).toBe(true);

    // Simulate close
    (internals.ws as MockWebSocket).readyState = MockWebSocket.CLOSED;
    expect(conn.isConnected).toBe(false);

    conn.stop();
  });
});

// ===========================================================================
// MESSAGE_CREATE Dispatch
// ===========================================================================

describe('MESSAGE_CREATE dispatch', () => {
  it('enqueues SQS message for a DM from a human user', async () => {
    const { conn, ws } = createConnection();
    const binding = makeAvatarBinding({
      config: {
        avatarId: 'avatar-test-001',
        name: 'TestAvatar',
        platforms: {
          discord: {
            enabled: true,
            respondInDMs: true,
            allowedGuilds: [],
            allowedChannels: [],
          },
        },
        behavior: { ignoreBots: true },
      },
    });
    conn.addAvatar(binding as any);
    doHandshake(ws);

    sqsSentMessages.length = 0;

    // DM message (no guild_id) — evaluateDiscord returns shouldRespond=true for DMs
    const message = makeDiscordMessage({
      guild_id: undefined,
      channel_id: 'dm-ch-42',
      content: 'Hello bot, this is a DM',
    });

    sendPayload(ws, { op: 0, s: 2, t: 'MESSAGE_CREATE', d: message });
    await flushPromises(100);

    // Assert at least one SQS SendMessageCommand was captured
    expect(sqsSentMessages.length).toBeGreaterThanOrEqual(1);

    // The SQS message should target the test queue
    const sqsMsg = sqsSentMessages.find(
      (m: any) => m.input?.QueueUrl === 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue'
    );
    expect(sqsMsg).toBeTruthy();

    // The MessageBody should contain the envelope with the correct conversationId
    const body = JSON.parse((sqsMsg as any).input.MessageBody);
    expect(body.envelope.conversationId).toBe('dm-ch-42');
    expect(body.envelope.platform).toBe('discord');
    expect(body.envelope.avatarId).toBe('avatar-test-001');

    conn.stop();
  });

  it('enqueues SQS message when bot is mentioned in a guild', async () => {
    const { conn, ws, internals } = createConnection();
    const binding = makeAvatarBinding();
    conn.addAvatar(binding as any);
    doHandshake(ws);

    sqsSentMessages.length = 0;

    // Guild message with bot mention — evaluateDiscord reaches isBotMentioned
    const botUserId = internals.botUserId!;
    const message = makeDiscordMessage({
      channel_id: 'ch-mention-test',
      guild_id: 'guild-200',
      content: `Hey <@${botUserId}> what's up?`,
      mentions: [{ id: botUserId, username: 'TestBot' }],
    });

    sendPayload(ws, { op: 0, s: 3, t: 'MESSAGE_CREATE', d: message });
    await flushPromises(100);

    expect(sqsSentMessages.length).toBeGreaterThanOrEqual(1);

    const sqsMsg = sqsSentMessages.find(
      (m: any) => m.input?.QueueUrl === 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue'
    );
    expect(sqsMsg).toBeTruthy();

    const body = JSON.parse((sqsMsg as any).input.MessageBody);
    expect(body.envelope.conversationId).toBe('ch-mention-test');
    expect(body.envelope.metadata.isMention).toBe(true);

    conn.stop();
  });

  it('does not enqueue when a guild message has no mention (shouldRespond=false)', async () => {
    const { conn, ws } = createConnection();
    const binding = makeAvatarBinding();
    conn.addAvatar(binding as any);
    doHandshake(ws);

    sqsSentMessages.length = 0;

    // Guild message without mention — evaluateDiscord returns shouldRespond=false
    const message = makeDiscordMessage({
      channel_id: 'ch-no-mention',
      guild_id: 'guild-200',
      content: 'Just chatting among humans',
      mentions: [],
    });

    sendPayload(ws, { op: 0, s: 4, t: 'MESSAGE_CREATE', d: message });
    await flushPromises(100);

    // No SQS message should be sent for this channel
    const sqsMsg = sqsSentMessages.find((m: any) => {
      const body = m.input?.MessageBody;
      if (!body) return false;
      try {
        return JSON.parse(body).envelope?.conversationId === 'ch-no-mention';
      } catch { return false; }
    });
    expect(sqsMsg).toBeUndefined();

    conn.stop();
  });

  it('ignores dispatch events with no event type', async () => {
    const { conn, ws } = createConnection();
    doHandshake(ws);

    // op: 0 with no `t` field — should be silently ignored
    sendPayload(ws, { op: 0, s: 3, d: {} });

    await flushPromises();
    conn.stop();
  });

  it('handles RESUMED event without error', () => {
    const { conn, ws, internals } = createConnection();
    doHandshake(ws);
    internals.reconnectAttempts = 5;

    sendPayload(ws, { op: 0, s: 10, t: 'RESUMED', d: {} });

    expect(internals.reconnectAttempts).toBe(0);
    conn.stop();
  });

  it('skips bot-authored messages when ignoreBots is true', async () => {
    const { conn, ws } = createConnection();
    const binding = makeAvatarBinding();
    conn.addAvatar(binding as any);
    doHandshake(ws);

    sqsSentMessages.length = 0;

    // DM from a bot — should be filtered by buildDiscordEnvelope or evaluator
    const message = makeDiscordMessage({
      guild_id: undefined,
      channel_id: 'dm-bot-ch',
      author: { id: 'bot-999', username: 'AnotherBot', bot: true },
      content: 'I am a bot',
    });

    sendPayload(ws, { op: 0, s: 5, t: 'MESSAGE_CREATE', d: message });
    await flushPromises(100);

    // No SQS enqueue for bot messages
    const sqsMsg = sqsSentMessages.find((m: any) => {
      const body = m.input?.MessageBody;
      if (!body) return false;
      try {
        return JSON.parse(body).envelope?.conversationId === 'dm-bot-ch';
      } catch { return false; }
    });
    expect(sqsMsg).toBeUndefined();

    conn.stop();
  });
});

// ===========================================================================
// Session Resume Flow
// ===========================================================================

describe('Session resume flow', () => {
  it('sends RESUME (op 6) when shouldResume is true and session exists', () => {
    const { conn, ws, internals } = createConnection();

    // Complete initial handshake
    doHandshake(ws);

    // Verify shouldResume is set after READY
    expect(internals.shouldResume).toBe(true);
    expect(internals.sessionId).toBe('test-session-id');

    // Now simulate what happens when a new HELLO arrives on the same ws
    // after a reconnect (shouldResume=true + valid session → RESUME)
    wsSentPayloads.length = 0;
    sendHello(ws);

    const resumePayload = wsSentPayloads.find((p: any) => p.op === 6) as any;
    expect(resumePayload).toBeTruthy();
    expect(resumePayload.d.session_id).toBe('test-session-id');
    expect(resumePayload.d.token).toBe('fake-bot-token');

    conn.stop();
  });

  it('falls back to IDENTIFY when resume has no session_id', () => {
    const { conn, ws, internals } = createConnection();

    // Set shouldResume but no sessionId
    internals.shouldResume = true;
    internals.sessionId = null;

    wsSentPayloads.length = 0;
    sendHello(ws);

    const identifyPayload = wsSentPayloads.find((p: any) => p.op === 2) as any;
    expect(identifyPayload).toBeTruthy();

    conn.stop();
  });
});

// ===========================================================================
// Close Code Handling
// ===========================================================================

describe('Close code handling', () => {
  const reconnectableCodes = [1006, 4000, 4001, 4002, 4003, 4005, 4008];
  const nonReconnectableCodes = [4004, 4010, 4011, 4012, 4013, 4014];
  const sessionInvalidatingCodes = [4007, 4009];

  for (const code of reconnectableCodes) {
    it(`schedules reconnect on close code ${code}`, () => {
      const { conn, ws, internals } = createConnection();
      doHandshake(ws);

      ws._emit('close', code, Buffer.from('Test close'));

      // Should not be destroyed (reconnectable)
      expect(internals.destroyed).toBe(false);
      expect(internals.reconnectAttempts).toBeGreaterThan(0);

      conn.stop();
    });
  }

  for (const code of nonReconnectableCodes) {
    it(`stops permanently on close code ${code}`, () => {
      const { conn, ws, internals } = createConnection();
      doHandshake(ws);

      ws._emit('close', code, Buffer.from('Test close'));

      expect(internals.destroyed).toBe(true);

      conn.stop();
    });
  }

  for (const code of sessionInvalidatingCodes) {
    it(`clears session on close code ${code} but allows reconnect`, () => {
      const { conn, ws, internals } = createConnection();
      doHandshake(ws);

      expect(internals.sessionId).toBe('test-session-id');

      ws._emit('close', code, Buffer.from('Session invalid'));

      expect(internals.sessionId).toBeNull();
      expect(internals.sequence).toBeNull();
      expect(internals.destroyed).toBe(false);

      conn.stop();
    });
  }
});

// ===========================================================================
// Shared Room / Multi-Avatar Routing
// ===========================================================================

describe('Shared room / multi-avatar routing', () => {
  it('routes a shared-room message once with a room-scoped key when 2+ avatars share a channel', async () => {
    // Import room-ingress to register a custom Discord channel resolver
    const { registerChannelAvatarResolver, unregisterChannelAvatarResolver } = await import(
      './services/room-ingress.js'
    );

    const sharedChannelId = 'shared-ch-999';

    // Register a Discord resolver that reports 2 avatars in the shared channel
    registerChannelAvatarResolver('discord' as any, async (channelId: string) => {
      if (channelId === sharedChannelId) return ['avatar-A', 'avatar-B'];
      return [];
    });

    try {
      const { conn, ws } = createConnection();
      const bindingA = makeAvatarBinding({
        avatarId: 'avatar-A',
        config: {
          avatarId: 'avatar-A',
          name: 'AvatarA',
          platforms: {
            discord: {
              enabled: true,
              allowedGuilds: [],
              allowedChannels: [],
            },
          },
          behavior: { ignoreBots: true },
        },
      });
      const bindingB = makeAvatarBinding({
        avatarId: 'avatar-B',
        config: {
          avatarId: 'avatar-B',
          name: 'AvatarB',
          platforms: {
            discord: {
              enabled: true,
              allowedGuilds: [],
              allowedChannels: [],
            },
          },
          behavior: { ignoreBots: true },
        },
      });
      conn.addAvatar(bindingA as any);
      conn.addAvatar(bindingB as any);
      doHandshake(ws);

      sqsSentMessages.length = 0;

      const message = makeDiscordMessage({
        id: 'shared-msg-001',
        channel_id: sharedChannelId,
        guild_id: 'guild-shared',
        content: 'Hello shared room',
      });

      sendPayload(ws, { op: 0, s: 2, t: 'MESSAGE_CREATE', d: message });
      await flushPromises(150);

      // Find SQS messages for this channel
      const sharedSqsMsgs = sqsSentMessages.filter((m: any) => {
        const body = m.input?.MessageBody;
        if (!body) return false;
        try {
          const parsed = JSON.parse(body);
          return parsed.roomKey === `discord:${sharedChannelId}`;
        } catch { return false; }
      });

      // Exactly one SQS message should be sent for the shared room
      expect(sharedSqsMsgs.length).toBe(1);

      // The MessageGroupId should be the room-scoped key, not per-avatar
      const sqsInput = (sharedSqsMsgs[0] as any).input;
      expect(sqsInput.MessageGroupId).toBe(`discord:${sharedChannelId}`);

      // The MessageDeduplicationId should reference the message ID
      expect(sqsInput.MessageDeduplicationId).toBe(`discord:shared-msg-001`);

      conn.stop();
    } finally {
      unregisterChannelAvatarResolver('discord' as any);
    }
  });

  it('uses per-avatar enqueue when only one avatar listens to a channel', async () => {
    const { registerChannelAvatarResolver, unregisterChannelAvatarResolver } = await import(
      './services/room-ingress.js'
    );

    const singleChannelId = 'single-ch-123';

    // Only one avatar in this channel — not a shared room
    registerChannelAvatarResolver('discord' as any, async (channelId: string) => {
      if (channelId === singleChannelId) return ['avatar-solo'];
      return [];
    });

    try {
      const { conn, ws, internals } = createConnection();
      const binding = makeAvatarBinding({
        avatarId: 'avatar-solo',
        config: {
          avatarId: 'avatar-solo',
          name: 'SoloAvatar',
          platforms: {
            discord: {
              enabled: true,
              respondInDMs: true,
              allowedGuilds: [],
              allowedChannels: [],
            },
          },
          behavior: { ignoreBots: true },
        },
      });
      conn.addAvatar(binding as any);
      doHandshake(ws);

      sqsSentMessages.length = 0;
      const botUserId = internals.botUserId!;

      // DM to ensure shouldRespond=true
      const message = makeDiscordMessage({
        id: 'solo-msg-001',
        channel_id: singleChannelId,
        guild_id: undefined,
        content: 'Hello solo avatar',
      });

      sendPayload(ws, { op: 0, s: 2, t: 'MESSAGE_CREATE', d: message });
      await flushPromises(150);

      // Should go through single-avatar path (per-avatar MessageGroupId)
      const soloSqsMsgs = sqsSentMessages.filter((m: any) => {
        const body = m.input?.MessageBody;
        if (!body) return false;
        try {
          const parsed = JSON.parse(body);
          return parsed.envelope?.conversationId === singleChannelId;
        } catch { return false; }
      });

      expect(soloSqsMsgs.length).toBeGreaterThanOrEqual(1);

      // Per-avatar path uses avatarId#channelId as MessageGroupId
      const sqsInput = (soloSqsMsgs[0] as any).input;
      expect(sqsInput.MessageGroupId).toBe(`avatar-solo#${singleChannelId}`);

      conn.stop();
    } finally {
      unregisterChannelAvatarResolver('discord' as any);
    }
  });
});

// ===========================================================================
// Resume / Reconnect Flow (real reconnect cycle)
// ===========================================================================

describe('Resume / reconnect flow', () => {
  it('creates a new WebSocket and sends RESUME after a recoverable close', async () => {
    wsInstances.length = 0;
    wsSentPayloads.length = 0;

    const conn = new GatewayConnection('resume-token', 0);
    conn.start();
    const internals = conn as unknown as GatewayInternals;

    // First WebSocket instance (initial connection)
    const ws1 = internals.ws! as unknown as MockWebSocket;
    expect(wsInstances.length).toBe(1);

    // Complete handshake on ws1
    sendHello(ws1);
    sendReady(ws1, {
      session_id: 'resume-sess-001',
      resume_gateway_url: 'wss://resume.discord.gg',
      user: { id: 'bot-resume-42', username: 'ResumeBot' },
    });

    expect(internals.sessionId).toBe('resume-sess-001');
    expect(internals.resumeGatewayUrl).toBe('wss://resume.discord.gg');
    expect(internals.shouldResume).toBe(true);

    const seqBefore = internals.sequence;

    // Simulate a recoverable close (code 4000 = unknown error, reconnectable)
    ws1._emit('close', 4000, Buffer.from('Unknown error'));

    // scheduleReconnect sets shouldResume=true, clears ws, increments attempts
    expect(internals.shouldResume).toBe(true);
    expect(internals.ws).toBeNull();
    expect(internals.reconnectAttempts).toBe(1);

    // Wait for the reconnect timer to fire and create a new WebSocket
    // Reconnect delay for attempt 0 with code 4000 is ~1s, but we wait up to 3s
    await flushPromises(3000);

    // A new WebSocket instance should have been created
    expect(wsInstances.length).toBeGreaterThanOrEqual(2);

    // Get the new WebSocket
    const ws2 = internals.ws as unknown as MockWebSocket;
    expect(ws2).not.toBeNull();
    expect(ws2).not.toBe(ws1);

    // Simulate the new connection receiving HELLO
    wsSentPayloads.length = 0;
    sendHello(ws2);

    // Since shouldResume=true and sessionId exists, it should send RESUME (op 6)
    const resumePayload = wsSentPayloads.find((p: any) => p.op === 6) as any;
    expect(resumePayload).toBeTruthy();
    expect(resumePayload.d.token).toBe('resume-token');
    expect(resumePayload.d.session_id).toBe('resume-sess-001');
    expect(resumePayload.d.seq).toBe(seqBefore);

    // Should NOT have sent IDENTIFY (op 2)
    const identifyPayload = wsSentPayloads.find((p: any) => p.op === 2);
    expect(identifyPayload).toBeUndefined();

    conn.stop();
  });

  it('sends IDENTIFY (not RESUME) after a session-invalidating close', async () => {
    wsInstances.length = 0;
    wsSentPayloads.length = 0;

    const conn = new GatewayConnection('identify-token', 0);
    conn.start();
    const internals = conn as unknown as GatewayInternals;

    const ws1 = internals.ws! as unknown as MockWebSocket;

    // Complete handshake
    sendHello(ws1);
    sendReady(ws1, {
      session_id: 'doomed-sess',
      resume_gateway_url: 'wss://resume.discord.gg',
      user: { id: 'bot-id-7', username: 'IdentifyBot' },
    });

    expect(internals.sessionId).toBe('doomed-sess');

    // Close code 4007 (invalid sequence) invalidates the session
    ws1._emit('close', 4007, Buffer.from('Invalid seq'));

    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();
    expect(internals.resumeGatewayUrl).toBeNull();

    // Wait for reconnect
    await flushPromises(3000);

    const ws2 = internals.ws as unknown as MockWebSocket;
    expect(ws2).not.toBeNull();

    // Simulate HELLO on new connection
    wsSentPayloads.length = 0;
    sendHello(ws2);

    // Should send IDENTIFY (op 2), not RESUME
    const identifyPayload = wsSentPayloads.find((p: any) => p.op === 2) as any;
    expect(identifyPayload).toBeTruthy();
    expect(identifyPayload.d.token).toBe('identify-token');

    const resumePayload = wsSentPayloads.find((p: any) => p.op === 6);
    expect(resumePayload).toBeUndefined();

    conn.stop();
  });

  it('preserves avatar bindings across reconnect', async () => {
    wsInstances.length = 0;

    const conn = new GatewayConnection('persist-token', 0);
    const bindingX = makeAvatarBinding({ avatarId: 'persist-avatar-X' });
    const bindingY = makeAvatarBinding({ avatarId: 'persist-avatar-Y' });
    conn.addAvatar(bindingX as any);
    conn.addAvatar(bindingY as any);
    conn.start();
    const internals = conn as unknown as GatewayInternals;

    const ws1 = internals.ws! as unknown as MockWebSocket;
    doHandshake(ws1);

    expect(conn.avatarBindings.size).toBe(2);

    // Trigger reconnect
    ws1._emit('close', 4000, Buffer.from('Reconnect'));
    await flushPromises(3000);

    // Bindings should still be present after reconnect
    expect(conn.avatarBindings.size).toBe(2);
    expect(conn.avatarBindings.has('persist-avatar-X')).toBe(true);
    expect(conn.avatarBindings.has('persist-avatar-Y')).toBe(true);

    conn.stop();
  });
});
