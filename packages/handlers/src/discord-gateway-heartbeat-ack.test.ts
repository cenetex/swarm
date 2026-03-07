/**
 * Discord Gateway Heartbeat ACK Timeout Tests
 *
 * Validates that the GatewayConnection properly tracks heartbeat ACK
 * responses and forces a reconnect when the server stops acknowledging.
 * See issue #829.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

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

// Enumerate every named export other test files import from these SDK modules,
// because bun's mock.module() is process-global and ESM resolves named exports
// at link time (Proxy traps don't help).
const Cmd = class { constructor(public input?: unknown) {} };

mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send() { return Promise.resolve({}); } destroy() {} },
  SendMessageCommand: Cmd,
  GetQueueAttributesCommand: Cmd,
  ReceiveMessageCommand: Cmd,
  DeleteMessageCommand: Cmd,
}));

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send() { return Promise.resolve({}); } },
  GetSecretValueCommand: Cmd,
  CreateSecretCommand: Cmd,
  UpdateSecretCommand: Cmd,
  DeleteSecretCommand: Cmd,
  DescribeSecretCommand: Cmd,
  RestoreSecretCommand: Cmd,
  PutSecretValueCommand: Cmd,
}));

type GatewayConnectionClass = typeof import('./discord/discord-gateway-shared.js').GatewayConnection;

let GatewayConnection: GatewayConnectionClass;
let previousStateTable: string | undefined;
let previousMessageQueueUrl: string | undefined;

beforeAll(async () => {
  // Stub required env vars before loading the module under test.
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
}

/**
 * Helper: Create a GatewayConnection and simulate the HELLO handshake
 * so that heartbeating is active.
 */
function createAndStartConnection(heartbeatInterval = 10_000) {
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

function sendAck(ws: { _emit: (event: string, ...args: unknown[]) => void }) {
  ws._emit('message', Buffer.from(JSON.stringify({ op: 11 })));
}

describe('GatewayConnection heartbeat ACK timeout', () => {
  it('records lastHeartbeatSentAt when heartbeat is sent', () => {
    const { conn, internals } = createAndStartConnection();
    expect(internals.lastHeartbeatSentAt).not.toBeNull();
    expect(internals.lastHeartbeatSentAt).toBeGreaterThan(0);
    conn.stop();
  });

  it('stores heartbeatIntervalMs from HELLO payload', () => {
    const { conn, internals } = createAndStartConnection(41_250);
    expect(internals.heartbeatIntervalMs).toBe(41_250);
    conn.stop();
  });

  it('schedules ACK timeout timer after sending heartbeat', () => {
    const { conn, internals } = createAndStartConnection();
    // A timeout timer should be set after the initial heartbeat
    expect(internals.heartbeatAckTimeoutTimer).not.toBeNull();
    conn.stop();
  });

  it('clears ACK timeout when HEARTBEAT_ACK (opcode 11) is received', () => {
    const { conn, ws, internals } = createAndStartConnection();

    // Timer should be set after heartbeat
    expect(internals.heartbeatAckTimeoutTimer).not.toBeNull();

    // Send ACK
    sendAck(ws);

    // Timer should be cleared
    expect(internals.heartbeatAckTimeoutTimer).toBeNull();
    // lastHeartbeatAckAt should be set
    expect(internals.lastHeartbeatAckAt).not.toBeNull();
    expect(internals.lastHeartbeatAckAt!).toBeGreaterThan(0);

    conn.stop();
  });

  it('records ACK time >= send time (latency tracking)', () => {
    const { conn, ws, internals } = createAndStartConnection();

    sendAck(ws);

    expect(internals.lastHeartbeatAckAt).not.toBeNull();
    expect(internals.lastHeartbeatSentAt).not.toBeNull();
    expect(internals.lastHeartbeatAckAt!).toBeGreaterThanOrEqual(internals.lastHeartbeatSentAt!);

    conn.stop();
  });

  it('cleans up ACK timeout timer on stop()', () => {
    const { conn, internals } = createAndStartConnection();

    expect(internals.heartbeatAckTimeoutTimer).not.toBeNull();

    conn.stop();

    expect(internals.heartbeatAckTimeoutTimer).toBeNull();
  });

  it('cleans up ACK timeout timer on scheduleReconnect (opcode 7)', () => {
    const { conn, ws, internals } = createAndStartConnection();

    expect(internals.heartbeatAckTimeoutTimer).not.toBeNull();

    // Simulate server-requested reconnect (opcode 7)
    ws._emit('message', Buffer.from(JSON.stringify({ op: 7 })));

    // scheduleReconnect clears the ACK timeout
    expect(internals.heartbeatAckTimeoutTimer).toBeNull();
    // It also clears the heartbeat timer
    expect(internals.heartbeatTimer).toBeNull();

    conn.stop();
  });

  it('triggers reconnect when ACK timeout fires', async () => {
    // Use a very short heartbeat interval so the 1.5x timeout fires quickly
    const heartbeatInterval = 50; // 50ms -> timeout at 75ms
    const { conn, internals } = createAndStartConnection(heartbeatInterval);

    // Stop the periodic heartbeat interval to avoid interference,
    // but keep the ACK timeout timer active
    if (internals.heartbeatTimer) {
      clearInterval(internals.heartbeatTimer);
      internals.heartbeatTimer = null;
    }

    const attemptsBefore = internals.reconnectAttempts;
    expect(internals.heartbeatAckTimeoutTimer).not.toBeNull();

    // Do NOT send ACK. Wait for the timeout to fire (1.5x 50ms = 75ms + margin).
    await new Promise(resolve => setTimeout(resolve, 200));

    // scheduleReconnect should have fired, incrementing reconnectAttempts
    expect(internals.reconnectAttempts).toBeGreaterThan(attemptsBefore);

    conn.stop();
  });

  it('does not trigger reconnect if ACK is received in time', async () => {
    const heartbeatInterval = 100; // 100ms -> timeout at 150ms
    const { conn, ws, internals } = createAndStartConnection(heartbeatInterval);

    const attemptsBefore = internals.reconnectAttempts;

    // Send ACK promptly
    sendAck(ws);

    // Wait past when the timeout would have fired
    await new Promise(resolve => setTimeout(resolve, 200));

    // Should NOT have reconnected
    expect(internals.reconnectAttempts).toBe(attemptsBefore);

    conn.stop();
  });
});
