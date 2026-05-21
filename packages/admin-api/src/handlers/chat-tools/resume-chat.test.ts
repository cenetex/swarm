import { beforeEach, describe, expect, it, mock } from 'bun:test';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

const saveChatHistorySpy = mock(async () => {});
const updateAvatarSpy = mock(async (_avatarId: string, updates: Record<string, unknown>) => ({
  id: 'avatar-1',
  name: 'Test',
  llmConfig: updates.llmConfig,
}));
const removePendingToolSpy = mock(async () => {});
const processChatSpy = mock(async () => ({
  response: 'should not be called',
  history: [],
}));

mock.module('../../services/chat-history.js', () => ({
  getChatHistory: mock(async () => [
    {
      role: 'assistant',
      content: 'Please select a model:',
      tool_calls: [{
        id: 'call-model',
        type: 'function',
        function: {
          name: 'request_model_selection',
          arguments: JSON.stringify({ type: 'model_selector', models: [] }),
        },
      }],
    },
  ]),
  saveChatHistory: saveChatHistorySpy,
}));

mock.module('../../services/pending-tools.js', () => ({
  getPendingTool: mock(async () => ({
    toolCallId: 'call-model',
    toolName: 'request_model_selection',
    arguments: { type: 'model_selector', models: [] },
  })),
  removePendingTool: removePendingToolSpy,
}));

mock.module('../../services/avatars.js', () => ({
  getAvatar: mock(async () => ({
    id: 'avatar-1',
    name: 'Test',
    llmConfig: {
      provider: 'openrouter',
      model: 'openai/gpt-4o',
      temperature: 0.8,
      maxTokens: 1024,
      useGlobalKey: true,
    },
    platforms: {},
    mcpConfig: { enabledToolsets: [] },
  })),
  updateAvatar: updateAvatarSpy,
}));

mock.module('../../services/integrations.js', () => ({
  configureIntegration: mock(async () => {}),
}));

mock.module('../../services/config-sync.js', () => ({
  syncAvatarConfig: mock(async () => {}),
}));

const { resumeChatAfterToolResult } = await import('./resume-chat.js');

describe('resumeChatAfterToolResult model selection', () => {
  beforeEach(() => {
    saveChatHistorySpy.mockClear();
    updateAvatarSpy.mockClear();
    removePendingToolSpy.mockClear();
    processChatSpy.mockClear();
  });

  it('persists selected LLM model and consumes the pending tool without re-entering the LLM loop', async () => {
    const result = await resumeChatAfterToolResult({
      avatarId: 'avatar-1',
      toolCallId: 'call-model',
      result: { selectedModel: 'deepseek/deepseek-r1' },
      session: { email: 'user@test.com', userId: 'u1', isAdmin: true, accessToken: '' },
    }, processChatSpy);

    expect(updateAvatarSpy).toHaveBeenCalledTimes(1);
    expect(updateAvatarSpy.mock.calls[0]![1]).toMatchObject({
      llmConfig: {
        provider: 'openrouter',
        model: 'deepseek/deepseek-r1',
      },
    });
    expect(removePendingToolSpy).toHaveBeenCalledWith('user@test.com', 'avatar-1');
    expect(saveChatHistorySpy).toHaveBeenCalledTimes(1);
    expect(processChatSpy).not.toHaveBeenCalled();
    expect(result.response).toBe('Model updated to deepseek/deepseek-r1.');
  });
});
