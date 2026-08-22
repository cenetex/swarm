/**
 * Pause tools tests.
 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { injectTestClients } from '../__test-helpers__/inject-clients.js';


let handlePauseToolCalls: typeof import('./pause-tools.js').handlePauseToolCalls;

beforeAll(async () => {
  await injectTestClients();

  const mod = await import('./pause-tools.js');
  handlePauseToolCalls = mod.handlePauseToolCalls;
});

function makeSdkToolCall(name: string, id = 'tc-1', args: Record<string, unknown> = {}) {
  return { id, name, arguments: args, type: 'function' as const };
}

describe('handlePauseToolCalls', () => {
  const mcpServices = { models: { listModels: async () => [], getConfig: async () => ({ model: 'gpt-4', temperature: 0.7, maxTokens: 1024 }) } };
  const avatarId = 'av-1';

  it('returns null when no pause tool in toolCalls', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('search_web', 'tc-1')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when mcpServices is null', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-1')],
      adminToolCalls: [],
      mcpServices: null,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when avatarId is undefined', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-1')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId: undefined,
      messages: [],
      tools: [],
    });
    expect(result).toBeNull();
  });

  it('returns pause result for configure_integration', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-1', { integration: 'telegram' })],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('configure_integration');
    expect(result!.response).toBe('');
    expect(result!.history).toHaveLength(1);
    expect(result!.history[0].role).toBe('assistant');
    expect(result!.history[0].tool_calls).toBeDefined();
  });

  it('returns pause result for request_model_selection', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('request_model_selection', 'tc-2', { family: 'claude' })],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('request_model_selection');
  });

  it('returns pause result for request_secret', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('request_secret', 'tc-3')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('request_secret');
  });

  it('returns pause result for upload tool', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('get_profile_upload_url', 'tc-4')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('get_profile_upload_url');
  });

  it('picks the first pause tool when multiple tool calls exist', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [
        makeSdkToolCall('search_web', 'tc-1'),
        makeSdkToolCall('configure_integration', 'tc-2', { integration: 'discord' }),
        makeSdkToolCall('request_secret', 'tc-3'),
      ],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.id).toBe('tc-2');
  });

  it('detects consecutive repeat of same pause tool in message history', async () => {
    const prev = {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{
        id: 'tc-prev',
        type: 'function' as const,
        function: { name: 'configure_integration', arguments: JSON.stringify({ integration: 'telegram' }) },
      }],
    };
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-now', { integration: 'telegram' })],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [prev],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.id).toBe('tc-now');
  });

  it('uses adminToolCalls in history when provided', async () => {
    const adminTc = {
      id: 'atc-1',
      type: 'function' as const,
      function: { name: 'configure_integration', arguments: JSON.stringify({ integration: 'discord' }) },
    };
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-1', { integration: 'discord' })],
      adminToolCalls: [adminTc],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.history[0].tool_calls).toEqual([adminTc]);
  });

  it('appends to existing messages', async () => {
    const existing = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-1')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: existing,
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.history).toHaveLength(3);
    expect(result!.history[0]).toEqual(existing[0]);
    expect(result!.history[1]).toEqual(existing[1]);
    expect(result!.history[2].role).toBe('assistant');
  });

  it('returns null with mixed non-pause tool calls', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('search_web'), makeSdkToolCall('send_message')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).toBeNull();
  });

  it('handles request_feature_toggle', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('request_feature_toggle', 'tc-ft')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('request_feature_toggle');
  });

  it('handles request_property_research', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('request_property_research', 'tc-rp')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('request_property_research');
  });

  it('handles manage_api_keys', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('manage_api_keys', 'tc-mak')],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('manage_api_keys');
  });
  it('handles request_twitter_connection (name override path)', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('request_twitter_connection', 'tc-tw', { message: 'connect' })],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('configure_integration');
    expect(result!.history[0].tool_calls![0].function.name).toBe('configure_integration');
  });

  it('uses adminToolCalls when provided and names match', async () => {
    const adminTc = {
      id: 'admin-tc-1',
      type: 'function' as const,
      function: { name: 'configure_integration', arguments: JSON.stringify({ integration: 'discord' }) },
    };
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-ci', { integration: 'discord' })],
      adminToolCalls: [adminTc],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.history[0].tool_calls).toEqual([adminTc]);
  });

  it('falls back to toAdminToolCall when no adminToolCalls and names match', async () => {
    const result = await handlePauseToolCalls!({
      toolCalls: [makeSdkToolCall('configure_integration', 'tc-ci', { integration: 'telegram' })],
      adminToolCalls: [],
      mcpServices: mcpServices as any,
      avatarId,
      messages: [],
      tools: [],
    });
    expect(result).not.toBeNull();
    expect(result!.pendingToolCall.name).toBe('configure_integration');
    expect(result!.history[0].tool_calls).toBeDefined();
    expect(result!.history[0].tool_calls![0].id).toBe('tc-ci');
  });

});
