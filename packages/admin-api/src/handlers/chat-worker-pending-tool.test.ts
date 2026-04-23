/**
 * Regression test for #1461.
 *
 * The async chat path (UI sends `Prefer: respond-async`) used to drop the
 * pending tool record entirely: the chat handler returned 202 + jobId without
 * calling savePendingTool, and chat-worker also never called it. As a result,
 * every Save click in tool prompts (e.g. "Lets configure telegram") failed
 * with `Unknown or expired toolCallId` because `resumeChatAfterToolResult`
 * couldn't validate the submission.
 *
 * This test pins the worker contract: when `processChat` returns a
 * `pendingToolCall`, the worker MUST persist it to the pending tool store
 * keyed by `(session.email, avatarId)`.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

const savePendingToolSpy = mock(async (_args: {
  email: string;
  avatarId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}) => {});

const saveChatHistorySpy = mock(async () => {});
const updateChatJobStatusSpy = mock(async () => {});
const processChatSpy = mock(async () => ({
  response: 'Configure your Telegram integration:',
  history: [],
  media: [],
  pendingJobs: [],
  pendingToolCall: {
    id: 'toolu_bdrk_01DY42fJTGYF5LSSQhx9wvHD',
    name: 'configure_integration',
    arguments: { integration: 'telegram' },
  },
  avatarUpdates: undefined,
}));

mock.module('../services/pending-tools.js', () => ({
  savePendingTool: savePendingToolSpy,
  getPendingTool: mock(async () => null),
  removePendingTool: mock(async () => {}),
}));

mock.module('../services/chat-history.js', () => ({
  saveChatHistory: saveChatHistorySpy,
  getChatHistory: mock(async () => []),
  clearChatHistory: mock(async () => {}),
  appendSystemMessage: mock(async () => []),
}));

mock.module('../services/chat-jobs.js', () => ({
  getChatJob: mock(async () => ({
    jobId: 'job-1',
    avatarId: 'avatar-1',
    type: 'chat',
    session: { email: 'user@test.com', userId: 'u1', isAdmin: false },
    request: {
      message: 'Lets configure telegram',
      history: [],
      avatar: { id: 'avatar-1', name: 'Test' },
      sender: undefined,
      systemPrompt: undefined,
      attachments: undefined,
      model: undefined,
      activeTask: undefined,
    },
  })),
  updateChatJobStatus: updateChatJobStatusSpy,
  createChatJob: mock(async () => {}),
  createJobId: mock(() => 'job-1'),
  getPendingChatJobs: mock(async () => []),
}));

mock.module('./chat.js', () => ({
  processChat: processChatSpy,
}));

mock.module('../services/runtime-config.js', () => ({
  ensureRuntimeConfig: mock(() => {}),
}));

mock.module('../services/billing/entitlements.js', () => ({
  incrementUsage: mock(async () => {}),
  checkLimit: mock(async () => ({ allowed: true })),
}));

mock.module('../services/auto-issues.js', () => ({
  recordError: mock(async () => {}),
}));

const { handler } = await import('./chat-worker.js');

function makeSqsEvent(body: Record<string, unknown>) {
  return {
    Records: [{
      messageId: 'm1',
      receiptHandle: 'r1',
      body: JSON.stringify(body),
      attributes: {} as Record<string, string>,
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn',
      awsRegion: 'us-east-1',
    }],
  } as Parameters<typeof handler>[0];
}

describe('chat-worker (#1461 regression)', () => {
  beforeEach(() => {
    savePendingToolSpy.mockClear();
    saveChatHistorySpy.mockClear();
    updateChatJobStatusSpy.mockClear();
    processChatSpy.mockClear();
  });

  it('persists pendingToolCall when processChat surfaces one', async () => {
    await handler(makeSqsEvent({ jobId: 'job-1' }));

    expect(savePendingToolSpy).toHaveBeenCalledTimes(1);
    const call = savePendingToolSpy.mock.calls[0]![0];
    expect(call.email).toBe('user@test.com');
    expect(call.avatarId).toBe('avatar-1');
    expect(call.toolCallId).toBe('toolu_bdrk_01DY42fJTGYF5LSSQhx9wvHD');
    expect(call.toolName).toBe('configure_integration');
    expect(call.arguments).toEqual({ integration: 'telegram' });
  });
});
