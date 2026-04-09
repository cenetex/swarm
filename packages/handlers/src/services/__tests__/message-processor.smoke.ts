/**
 * Message Processor Smoke Tests
 *
 * Tests the SQS handler that processes inbound messages, calls the LLM,
 * executes MCP tools, and enqueues responses.
 *
 * Strategy: mock all external dependencies (AWS SDK, fetch, @swarm/core,
 * @swarm/mcp-server, entitlement enforcement) and drive the handler with
 * synthetic SQS events. Because `vi.mock()` is process-global we keep
 * mock surfaces minimal and reset state in `beforeEach`.
 *
 * @see packages/handlers/src/message-processor.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCanonicalMemoryClient as createCanonicalMemoryClientActual } from '../../../../core/src/services/brain/canonical-memory.js';
// Real @swarm/core imported via relative path to bypass the '@swarm/core' mock below.
// This lets us spread the real module into the mock factory and only override
// the specific functions the test needs to stub.
import * as RealSwarmCore from '../../../../core/src/index.js';

// ---------------------------------------------------------------------------
// Shared mock primitives (declared BEFORE mock.module so they are captured)
// ---------------------------------------------------------------------------

const mockSqsSend = vi.fn(() => Promise.resolve({ MessageId: 'sqs-resp-1' }));
const mockGetAvatarConfig = vi.fn(() => Promise.resolve(null));
const mockGetOrCreateChannelState = vi.fn(() =>
  Promise.resolve({
    avatarId: 'avatar-1',
    channelId: 'conv-1',
    platform: 'telegram',
    state: 'IDLE',
    recentMessages: [],
    chatType: 'group',
  }),
);
const mockAddMessageToChannel = vi.fn(() =>
  Promise.resolve({
    avatarId: 'avatar-1',
    channelId: 'conv-1',
    platform: 'telegram',
    state: 'IDLE',
    recentMessages: [],
    chatType: 'group',
  }),
);
const mockEvaluateResponseTrigger = vi.fn(() => ({
  shouldRespond: true,
  trigger: 'mention',
  delay: 0,
  priority: 'high',
}));
const mockTransitionState = vi.fn(() => Promise.resolve());
const mockMarkResponseSent = vi.fn(() => Promise.resolve());
const mockSetUserCooldown = vi.fn(() => Promise.resolve());
const mockSaveFact = vi.fn(() => Promise.resolve());
const mockGetChannelState = vi.fn(() => Promise.resolve(null));
const mockBrainRemember = vi.fn(() => Promise.resolve({ saved: true, source: 'legacy' as const }));
const mockBrainRecall = vi.fn(() => Promise.resolve({ facts: [], source: 'legacy' as const }));

const mockStateService = {
  getAvatarConfig: mockGetAvatarConfig,
  getOrCreateChannelState: mockGetOrCreateChannelState,
  addMessageToChannel: mockAddMessageToChannel,
  evaluateResponseTrigger: mockEvaluateResponseTrigger,
  transitionState: mockTransitionState,
  markResponseSent: mockMarkResponseSent,
  setUserCooldown: mockSetUserCooldown,
  saveFact: mockSaveFact,
  getChannelState: mockGetChannelState,
};

const mockBuildPresenceContext = vi.fn(() => Promise.resolve(''));
const mockRegisterChannel = vi.fn(() => Promise.resolve());
const mockGetAllChannels = vi.fn(() => Promise.resolve([]));
const mockGetChannelWithSummary = vi.fn(() => Promise.resolve(null));
const mockPresenceService = {
  buildPresenceContext: mockBuildPresenceContext,
  registerChannel: mockRegisterChannel,
  getAllChannels: mockGetAllChannels,
  getChannelWithSummary: mockGetChannelWithSummary,
};

const mockSecretsGet = vi.fn(() => Promise.resolve(''));

const mockCheckAndIncrementMessageUsage = vi.fn(() =>
  Promise.resolve({ allowed: true, limit: 50, current: 1 }),
);
const mockCheckToolCallLimit = vi.fn(() =>
  Promise.resolve({ allowed: true, limit: 3, current: 0 }),
);
const mockIsMemoryWriteAllowed = vi.fn(() => Promise.resolve(false));

// LLM fetch mock
const mockFetchJson = vi.fn(() =>
  Promise.resolve({
    choices: [
      {
        message: {
          content: 'Hello from the LLM!',
          tool_calls: undefined,
        },
      },
    ],
  }),
);
const mockFetchResponse = () => ({
  ok: true,
  json: mockFetchJson,
  text: vi.fn(() => Promise.resolve('')),
});

// Tool registry / client mocks
const mockToolExecute = vi.fn(() =>
  Promise.resolve({ success: true, data: {} }),
);
const mockGetToolDefinitions = vi.fn(() => [
  { name: 'send_message', description: 'Send a message', parameters: {} },
]);
const mockGetOpenAIToolsForTools = vi.fn(() => []);

// ---------------------------------------------------------------------------
// vi.mock() calls
// ---------------------------------------------------------------------------

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mockSqsSend;
  },
  SendMessageCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// These are needed when running alongside response-sender smoke tests
// (mock.module is process-global).
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = vi.fn(() => Promise.resolve({}));
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: vi.fn(() => Promise.resolve({})) }),
  },
  GetCommand: class { constructor(public readonly input: unknown) {} },
  PutCommand: class { constructor(public readonly input: unknown) {} },
  UpdateCommand: class { constructor(public readonly input: unknown) {} },
}));

// NOTE: mock.module is process-global. When run alongside response-sender
// smoke tests, the last definition wins. We include all exports needed by
// BOTH handlers to avoid "export not found" errors.
vi.mock('@swarm/core', () => ({
  // Spread real module first so all enums, error classes, schemas, and pure
  // helpers (SwarmErrorCode, LLMError, etc.) are available to production code.
  // Function/service factories below override the real ones with stubs.
  ...RealSwarmCore,
  // --- shared config ---
  DEFAULT_AVATAR_CONFIG: {
    id: 'unknown',
    name: 'Assistant',
    version: '1.0.0',
    persona: 'You are a helpful AI assistant.',
    platforms: {},
    llm: {
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
    scheduling: {},
    behavior: {
      responseDelayMs: [0, 0],
      typingIndicator: false,
      ignoreBots: true,
      cooldownMinutes: 0,
      maxContextMessages: 20,
    },
    tools: ['send_message', 'react', 'ignore'],
    secrets: ['OPENROUTER_API_KEY'],
  },

  // --- message-processor needs these ---
  createStateService: () => mockStateService,
  createSecretsService: () => ({ getSecret: mockSecretsGet }),
  createMediaServiceWithDeps: () => undefined,
  createMediaDependencies: () => ({}),
  createPresenceService: () => mockPresenceService,
  createLegacyBrainService: () => ({
    remember: mockBrainRemember,
    recall: mockBrainRecall,
  }),
  // Keep canonical memory behavior aligned with the real implementation so
  // global mock ordering cannot break core package canonical-memory tests.
  createCanonicalMemoryClient: createCanonicalMemoryClientActual,
  createChannelSummaryService: () => ({
    getOrGenerateSummary: vi.fn(() => Promise.resolve(null)),
  }),
  createCircuitBreaker: () => ({
    canExecute: () => true,
    recordSuccess: () => {},
    recordFailure: () => {},
    state: () => 'closed',
  }),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    setContext: () => {},
  },
  MessageQueueItemSchema: {
    safeParse: (data: unknown) => {
      const d = data as Record<string, unknown> | undefined;
      if (!d || !d.envelope) return { success: false, error: { message: 'missing envelope' } };
      return { success: true, data: d };
    },
  },
  extractThinking: (content: string) => ({
    cleanContent: content,
    thinkingBlocks: [],
    hasThinking: false,
  }),
  CORRELATION_ID_ATTR: 'correlationId',
  extractCorrelationIdFromSqsRecord: () => 'corr-1',
  buildDynamicSystemPrompt: () => 'You are a test assistant.',
  toolsToCategories: () => ['messaging'],

  // --- response-sender also needs these ---
  TelegramAdapter: class {
    constructor() {}
    getBot() {
      return { api: { sendMessage: vi.fn(() => Promise.resolve({ message_id: 1 })) } };
    }
  },
  TwitterAdapter: class { constructor() {} },
  WebAdapter: class { constructor() {} },
  DiscordAdapter: class { constructor() {} },
  PlatformRegistry: class {
    register() {}
    get() { return null; }
  },
  createActivityService: () => ({ record: vi.fn(() => Promise.resolve()) }),
  createOutboundSender: () => ({
    send: vi.fn(() => Promise.resolve({ success: true, sentMessages: [], errors: [] })),
  }),
  // sqs-send.ts needs this from @swarm/core
  createSqsOffloadServiceFromEnv: () => null,
}));

vi.mock('@swarm/mcp-server', () => ({
  ToolRegistry: class {
    register() {}
  },
  createToolClient: () => ({
    execute: mockToolExecute,
    getToolDefinitions: mockGetToolDefinitions,
    getOpenAIToolsForTools: mockGetOpenAIToolsForTools,
  }),
  registerAllTools: () => {},
}));

vi.mock('../../services/platform-mcp-adapter.js', () => ({
  createPlatformMCPServices: () => ({}),
}));

vi.mock('../../services/entitlement-enforcement.js', () => ({
  checkAndIncrementMessageUsage: mockCheckAndIncrementMessageUsage,
  checkToolCallLimit: mockCheckToolCallLimit,
  isMemoryWriteAllowed: mockIsMemoryWriteAllowed,
}));

vi.mock('../../utils/system-replicate-key.js', () => ({
  ensureReplicateKey: () => Promise.resolve(true),
}));

vi.mock('../../utils/load-avatar-secrets.js', () => ({
  loadAvatarSecrets: () =>
    Promise.resolve({ OPENROUTER_API_KEY: 'test-key-123' }),
}));

// Also mock telegram-webhook-shared (needed when running with response-sender tests)
vi.mock('../../telegram/telegram-webhook-shared.js', () => ({
  isAllowedDmUserById: vi.fn(() => Promise.resolve(false)),
}));

// ---------------------------------------------------------------------------
// Import handler AFTER mocks are wired
// ---------------------------------------------------------------------------
const { handler } = await import('../../messaging/message-processor.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsEvent(
  records: Array<{
    messageId: string;
    body: string;
    messageAttributes?: Record<string, { dataType: string; stringValue: string }>;
  }>,
) {
  return {
    Records: records.map((r) => ({
      messageId: r.messageId,
      body: r.body,
      receiptHandle: 'receipt-1',
      attributes: {} as Record<string, string>,
      messageAttributes: r.messageAttributes ?? {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123:test-queue',
      awsRegion: 'us-east-1',
    })),
  };
}

function makeContext() {
  return {
    awsRequestId: 'req-1',
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'messageProcessor',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123:function:test',
    memoryLimitInMB: '256',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'stream-1',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    avatarId: 'avatar-1',
    platform: 'telegram',
    messageId: 'msg-100',
    conversationId: 'conv-1',
    timestamp: Date.now(),
    sender: {
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      isBot: false,
    },
    content: { text: 'Hello bot!' },
    metadata: {
      idempotencyKey: 'idem-1',
      isMention: true,
      isReplyToBot: false,
      chatType: 'group',
      chatTitle: 'Test Chat',
    },
    ...overrides,
  };
}

function makeQueueItem(envelopeOverrides: Record<string, unknown> = {}) {
  return {
    envelope: makeEnvelope(envelopeOverrides),
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Message Processor Smoke Tests', () => {
  beforeEach(() => {
    // Set required env vars
    process.env.RESPONSE_QUEUE_URL = 'https://sqs.test/response-queue';
    process.env.STATE_TABLE = 'test-state-table';
    process.env.SECRET_PREFIX = 'swarm';

    // Reset mocks
    mockSqsSend.mockClear();
    mockGetAvatarConfig.mockClear();
    mockGetOrCreateChannelState.mockClear();
    mockAddMessageToChannel.mockClear();
    mockEvaluateResponseTrigger.mockClear();
    mockTransitionState.mockClear();
    mockCheckAndIncrementMessageUsage.mockClear();
    mockCheckToolCallLimit.mockClear();
    mockIsMemoryWriteAllowed.mockClear();
    mockBrainRemember.mockClear();
    mockBrainRecall.mockClear();
    mockToolExecute.mockClear();
    mockRegisterChannel.mockClear();
    mockFetchJson.mockClear();

    // Restore default return values
    mockCheckAndIncrementMessageUsage.mockImplementation(() =>
      Promise.resolve({ allowed: true, limit: 50, current: 1 }),
    );
    mockCheckToolCallLimit.mockImplementation(() =>
      Promise.resolve({ allowed: true, limit: 3, current: 0 }),
    );
    mockEvaluateResponseTrigger.mockImplementation(() => ({
      shouldRespond: true,
      trigger: 'mention',
      delay: 0,
      priority: 'high',
    }));
    mockAddMessageToChannel.mockImplementation(() =>
      Promise.resolve({
        avatarId: 'avatar-1',
        channelId: 'conv-1',
        platform: 'telegram',
        state: 'IDLE',
        recentMessages: [],
        chatType: 'group',
      }),
    );

    // Mock global fetch for LLM calls
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() =>
      Promise.resolve(mockFetchResponse()),
    );
  });

  // --- Happy path ---

  it('should process a valid message and enqueue a response', async () => {
    const sqsEvent = makeSqsEvent([
      {
        messageId: 'sqs-1',
        body: JSON.stringify(makeQueueItem()),
      },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockGetOrCreateChannelState).toHaveBeenCalled();
    expect(mockAddMessageToChannel).toHaveBeenCalled();
    expect(mockTransitionState).toHaveBeenCalled();
    // Response enqueued to SQS
    expect(mockSqsSend).toHaveBeenCalled();
  });

  // --- JSON parse error ---

  it('should add malformed JSON records to batchItemFailures', async () => {
    const sqsEvent = makeSqsEvent([
      { messageId: 'bad-json', body: 'not json {{' },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('bad-json');
  });

  // --- Schema validation failure ---

  it('should add schema-invalid records to batchItemFailures (poison pill)', async () => {
    const sqsEvent = makeSqsEvent([
      {
        messageId: 'bad-schema',
        body: JSON.stringify({ notAnEnvelope: true }),
      },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('bad-schema');
  });

  // --- Missing avatarId ---

  it('should fail when avatarId is missing from envelope and env', async () => {
    // Clear AVATAR_ID env to force reliance on envelope
    delete process.env.AVATAR_ID;

    const item = makeQueueItem({ avatarId: '' });
    const sqsEvent = makeSqsEvent([
      { messageId: 'no-avatar', body: JSON.stringify(item) },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('no-avatar');
  });

  // --- Entitlement: message limit exceeded ---

  it('should skip processing when message limit is exceeded', async () => {
    mockCheckAndIncrementMessageUsage.mockImplementation(() =>
      Promise.resolve({
        allowed: false,
        reason: 'Daily message limit reached',
        limit: 50,
        current: 50,
      }),
    );

    const sqsEvent = makeSqsEvent([
      { messageId: 'limited', body: JSON.stringify(makeQueueItem()) },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    // Not a failure (policy rejection), just skipped
    expect(result.batchItemFailures).toHaveLength(0);
    // Should NOT enqueue a response
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  // --- Response trigger says no ---

  it('should skip when evaluateResponseTrigger says not to respond', async () => {
    mockEvaluateResponseTrigger.mockImplementation(() => ({
      shouldRespond: false,
      trigger: 'cooldown',
      delay: 0,
      priority: 'low',
    }));

    const sqsEvent = makeSqsEvent([
      { messageId: 'no-respond', body: JSON.stringify(makeQueueItem()) },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockTransitionState).not.toHaveBeenCalled();
  });

  // --- Correlation ID propagation ---

  it('should propagate correlation ID from SQS record attributes', async () => {
    const sqsEvent = makeSqsEvent([
      {
        messageId: 'corr-test',
        body: JSON.stringify(makeQueueItem()),
        messageAttributes: {
          correlationId: {
            dataType: 'String',
            stringValue: 'corr-abc-123',
          },
        },
      },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(0);
    // SQS send should include correlationId in message attributes
    expect(mockSqsSend).toHaveBeenCalled();
  });

  // --- Partial batch failure ---

  it('should handle mixed valid and invalid records in a batch', async () => {
    const sqsEvent = makeSqsEvent([
      { messageId: 'good-1', body: JSON.stringify(makeQueueItem()) },
      { messageId: 'bad-1', body: 'broken json' },
      {
        messageId: 'good-2',
        body: JSON.stringify(
          makeQueueItem({ avatarId: 'avatar-2', messageId: 'msg-200' }),
        ),
      },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    // Only the broken JSON should be in failures
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('bad-1');
  });

  // --- Empty batch ---

  it('should return empty failures for an empty batch', async () => {
    const sqsEvent = makeSqsEvent([]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(0);
  });

  // --- LLM response with no tool calls produces send_message action ---

  it('should produce a send_message action when LLM returns text', async () => {
    const sqsEvent = makeSqsEvent([
      { messageId: 'llm-text', body: JSON.stringify(makeQueueItem()) },
    ]);

    const result = await handler(sqsEvent as any, makeContext() as any);

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSqsSend).toHaveBeenCalled();

    // Verify the enqueued response contains actions
    const call = mockSqsSend.mock.calls[0];
    const cmdInput = (call?.[0] as { input?: unknown })?.input as
      | { MessageBody?: string }
      | undefined;
    if (cmdInput?.MessageBody) {
      const body = JSON.parse(cmdInput.MessageBody);
      expect(body.actions).toBeDefined();
      expect(body.actions.length).toBeGreaterThan(0);
      expect(body.actions[0].type).toBe('send_message');
    }
  });
});
