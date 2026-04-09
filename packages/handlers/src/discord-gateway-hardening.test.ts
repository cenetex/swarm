/**
 * Discord Gateway Hardening Tests
 *
 * Validates:
 * - Issue #830: Heartbeat interval bounds validation and jitter
 * - Issue #831: Session state reset on close codes 4007/4009
 */
import { afterAll, beforeAll, beforeEach, describe, it, expect, mock } from 'bun:test';

// Bypass mocks below to access real @swarm/core for spreading into the factory.
import * as RealSwarmCore from '../../core/src/index.js';

// Track logger.warn calls for assertion
const loggerWarnCalls: Array<{ message: string; meta: Record<string, unknown> }> = [];

// Mock all external dependencies before importing the module under test
mock.module('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1; // OPEN
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

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
    close() {}
    send() {}

    // Test helper: emit an event
    _emit(event: string, ...args: unknown[]) {
      const list = this.handlers.get(event) || [];
      for (const fn of list) fn(...args);
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket, __esModule: true };
});

mock.module('../services/sqs-send.js', () => ({
  sendSqsMessage: async () => {},
}));

mock.module('../services/room-ingress.js', () => ({
  processSharedRoomMessage: async () => ({ isNew: false }),
  buildRoomKey: (platform: string, channel: string) => `${platform}:${channel}`,
}));

mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send() { return Promise.resolve({}); } destroy() {} },
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

// Re-export the real @swarm/core module, overriding only what the gateway test
// needs to control. This prevents global mock pollution (bun's mock.module is
// process-global and would break tests in other files that import @swarm/core).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- mock.module requires synchronous module object; dynamic import() is async
const realCore = require('@swarm/core');
mock.module('@swarm/core', () => ({
  ...RealSwarmCore,
  ...realCore,
  // Override only what this test needs to control; keep all other exports real
  // to avoid polluting other test files (bun's mock.module is process-global).
  createStateService: () => ({
    listAvatars: async () => [],
    getAvatarConfigWithStatus: async () => null,
    checkAndSetIdempotency: async () => true,
    addMessageToChannel: async () => {},
  }),
  createMessageEvaluator: () => ({ evaluate: async () => ({ shouldRespond: false, reason: 'test' }) }),
  createActivityService: () => null,
  logger: {
    info: () => {},
    warn: (message: string, meta: Record<string, unknown>) => {
      loggerWarnCalls.push({ message, meta });
    },
    error: () => {},
    debug: () => {},
    setContext: () => {},
  },
}));

type GatewayConnectionClass = typeof import('./discord/discord-gateway-shared.js').GatewayConnection;

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

/** Type alias for internal state we need to inspect in tests */
interface GatewayInternals {
  ws: { _emit: (event: string, ...args: unknown[]) => void; send: (...args: unknown[]) => void } | null;
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
}

/**
 * Helper: Create a GatewayConnection and simulate the HELLO handshake.
 */
function createAndStartConnection(heartbeatInterval = 41_250) {
  const conn = new GatewayConnection('fake-bot-token', 0);
  conn.start();

  const internals = conn as unknown as GatewayInternals;
  const ws = internals.ws!;

  // Simulate HELLO (opcode 10) from the gateway
  const helloPayload = JSON.stringify({
    op: 10,
    d: { heartbeat_interval: heartbeatInterval },
  });
  ws._emit('message', Buffer.from(helloPayload));

  return { conn, ws, internals };
}

// ─── Issue #830: Heartbeat interval bounds and jitter ─────────────────────

describe('GatewayConnection heartbeat interval validation (#830)', () => {
  beforeEach(() => {
    loggerWarnCalls.length = 0;
  });

  it('accepts normal interval without clamping', () => {
    const { conn, internals } = createAndStartConnection(41_250);
    expect(internals.heartbeatIntervalMs).toBe(41_250);

    // No clamping warning should have been logged
    const clampWarnings = loggerWarnCalls.filter(
      c => c.meta?.event === 'heartbeat_interval_clamped'
    );
    expect(clampWarnings.length).toBe(0);

    conn.stop();
  });

  it('clamps interval below 10s to 10s with warning', () => {
    const { conn, internals } = createAndStartConnection(5_000);
    expect(internals.heartbeatIntervalMs).toBe(10_000);

    const clampWarnings = loggerWarnCalls.filter(
      c => c.meta?.event === 'heartbeat_interval_clamped'
    );
    expect(clampWarnings.length).toBe(1);
    expect(clampWarnings[0].meta.originalMs).toBe(5_000);
    expect(clampWarnings[0].meta.clampedMs).toBe(10_000);

    conn.stop();
  });

  it('clamps interval above 120s to 120s with warning', () => {
    const { conn, internals } = createAndStartConnection(200_000);
    expect(internals.heartbeatIntervalMs).toBe(120_000);

    const clampWarnings = loggerWarnCalls.filter(
      c => c.meta?.event === 'heartbeat_interval_clamped'
    );
    expect(clampWarnings.length).toBe(1);
    expect(clampWarnings[0].meta.originalMs).toBe(200_000);
    expect(clampWarnings[0].meta.clampedMs).toBe(120_000);

    conn.stop();
  });

  it('applies jitter: heartbeatTimer interval is <= the stored interval', () => {
    // We can't directly inspect setInterval's delay, but we can verify
    // the stored heartbeatIntervalMs is the canonical (pre-jitter) value
    // and that jitter doesn't alter the stored value.
    // Run multiple times to exercise the random path.
    for (let i = 0; i < 5; i++) {
      const { conn, internals } = createAndStartConnection(41_250);
      // The stored interval should always be the canonical value (not jittered)
      expect(internals.heartbeatIntervalMs).toBe(41_250);
      // The heartbeat timer should exist
      expect(internals.heartbeatTimer).not.toBeNull();
      conn.stop();
    }
  });
});

// ─── Issue #831: Session reset on close codes 4007/4009 ───────────────────

describe('GatewayConnection session reset on resume failure codes (#831)', () => {
  beforeEach(() => {
    loggerWarnCalls.length = 0;
  });

  it('clears session state on close code 4007 (invalid sequence)', () => {
    const { conn, ws, internals } = createAndStartConnection();

    // Simulate READY to establish a session
    const readyPayload = JSON.stringify({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'test-session-123',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: '12345', username: 'testbot' },
      },
    });
    ws._emit('message', Buffer.from(readyPayload));

    // Verify session state is established
    expect(internals.sessionId).toBe('test-session-123');
    expect(internals.sequence).toBe(1);
    expect(internals.resumeGatewayUrl).toBe('wss://resume.discord.gg');

    // Simulate close with code 4007
    ws._emit('close', 4007, Buffer.from('Invalid sequence'));

    // Session state should be cleared
    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();
    expect(internals.resumeGatewayUrl).toBeNull();

    // A session_invalidated warning should have been logged
    const invalidationWarnings = loggerWarnCalls.filter(
      c => c.meta?.event === 'session_invalidated'
    );
    expect(invalidationWarnings.length).toBe(1);
    expect(invalidationWarnings[0].meta.closeCode).toBe(4007);

    conn.stop();
  });

  it('clears session state on close code 4009 (session timed out)', () => {
    const { conn, ws, internals } = createAndStartConnection();

    // Simulate READY to establish a session
    const readyPayload = JSON.stringify({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'test-session-456',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: '12345', username: 'testbot' },
      },
    });
    ws._emit('message', Buffer.from(readyPayload));

    expect(internals.sessionId).toBe('test-session-456');

    // Simulate close with code 4009
    ws._emit('close', 4009, Buffer.from('Session timed out'));

    // Session state should be cleared
    expect(internals.sessionId).toBeNull();
    expect(internals.sequence).toBeNull();
    expect(internals.resumeGatewayUrl).toBeNull();

    // A session_invalidated warning should have been logged
    const invalidationWarnings = loggerWarnCalls.filter(
      c => c.meta?.event === 'session_invalidated'
    );
    expect(invalidationWarnings.length).toBe(1);
    expect(invalidationWarnings[0].meta.closeCode).toBe(4009);

    conn.stop();
  });

  it('schedules reconnect with resume=false after 4007/4009', () => {
    const { conn, ws, internals } = createAndStartConnection();

    // Establish session
    const readyPayload = JSON.stringify({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'test-session-789',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: '12345', username: 'testbot' },
      },
    });
    ws._emit('message', Buffer.from(readyPayload));

    // shouldResume should be true after READY
    expect(internals.shouldResume).toBe(true);

    // Simulate close with code 4007
    ws._emit('close', 4007, Buffer.from('Invalid sequence'));

    // shouldResume should be false (set by scheduleReconnect(false))
    expect(internals.shouldResume).toBe(false);

    conn.stop();
  });

  it('preserves session state for normal reconnectable close codes', () => {
    const { conn, ws, internals } = createAndStartConnection();

    // Establish session
    const readyPayload = JSON.stringify({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'test-session-normal',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: '12345', username: 'testbot' },
      },
    });
    ws._emit('message', Buffer.from(readyPayload));

    expect(internals.sessionId).toBe('test-session-normal');

    // Simulate a normal close (e.g. code 1001 going away)
    ws._emit('close', 1001, Buffer.from('Going away'));

    // Session state should be preserved for resume
    expect(internals.sessionId).toBe('test-session-normal');
    expect(internals.resumeGatewayUrl).toBe('wss://resume.discord.gg');

    conn.stop();
  });
});

afterAll(() => { mock.restore(); });
