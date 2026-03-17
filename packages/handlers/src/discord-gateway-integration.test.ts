/**
 * Discord Gateway Integration Tests
 *
 * Covers the full connection lifecycle, message routing, error scenarios,
 * and multi-tenant avatar binding. See issue #1066.
 *
 * Mocks WebSocket, AWS SDK clients, and core services to test the
 * gateway logic in isolation without live Discord API calls.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// ─── Mock Tracking ────────────────────────────────────────────────────────────

/** Captured SQS messages for assertion */
const sqsSentMessages: Array<{ input: unknown }> = [];

/** Captured WebSocket sends for assertion */
const wsSentPayloads: Array<unknown> = [];

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1; // OPEN
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor() {
    wsSentPayloads.length = 0;
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
  it('dispatches MESSAGE_CREATE to handlePayload without crashing', async () => {
    const { conn, ws } = createConnection();
    const binding = makeAvatarBinding();
    conn.addAvatar(binding as any);
    doHandshake(ws);

    const message = makeDiscordMessage();

    // Dispatch MESSAGE_CREATE — this exercises the full handlePayload path
    // but may not enqueue because of the stateService/evaluator mocks
    sendPayload(ws, { op: 0, s: 2, t: 'MESSAGE_CREATE', d: message });

    // Give async handlers time to resolve
    await new Promise(resolve => setTimeout(resolve, 50));

    conn.stop();
  });

  it('ignores dispatch events with no event type', async () => {
    const { conn, ws } = createConnection();
    doHandshake(ws);

    // op: 0 with no `t` field — should be silently ignored
    sendPayload(ws, { op: 0, s: 3, d: {} });

    await new Promise(resolve => setTimeout(resolve, 20));
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
