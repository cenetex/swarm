/**
 * ToolRegistry Tests
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool, defineManualTool } from './registry.js';

function buildContext() {
  return { agentId: 'agent-1', platform: 'admin-ui' as const };
}

describe('ToolRegistry - platform filtering', () => {
  it('returns tools available for the platform', () => {
    const registry = new ToolRegistry();

    registry.register(defineTool({
      name: 'public_tool',
      description: 'Public',
      inputSchema: z.object({}),
      execute: async () => ({ success: true, data: { ok: true } }),
    }));

    registry.register(defineTool({
      name: 'admin_tool',
      description: 'Admin only',
      platforms: ['admin-ui'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true, data: { ok: true } }),
    }));

    registry.register(defineTool({
      name: 'discord_tool',
      description: 'Discord only',
      platforms: ['discord'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true, data: { ok: true } }),
    }));

    const tools = registry.getForPlatform('admin-ui');
    const names = tools.map(tool => tool.name);

    expect(names).toContain('public_tool');
    expect(names).toContain('admin_tool');
    expect(names).not.toContain('discord_tool');
  });
});

describe('ToolRegistry - execute', () => {
  it('returns an error for unknown tools', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('missing_tool', {}, buildContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown tool: missing_tool');
  });

  it('validates input schema and returns validation errors', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'echo',
      description: 'Echo tool',
      inputSchema: z.object({ name: z.string() }),
      execute: async (input) => ({ success: true, data: { name: input.name } }),
    }));

    const result = await registry.execute('echo', { name: 123 }, buildContext());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Validation error/);
  });

  it('returns uiAction mapping for manual tools', async () => {
    const registry = new ToolRegistry();
    registry.register(defineManualTool({
      name: 'request_twitter_connection',
      description: 'Request Twitter',
      platforms: ['admin-ui'],
      inputSchema: z.object({ message: z.string().optional() }),
    }));

    const result = await registry.execute('request_twitter_connection', { message: 'hello' }, buildContext());

    expect(result.success).toBe(true);
    expect(result.uiAction).toEqual({
      type: 'twitter_connect',
      payload: { message: 'hello', type: 'twitter_connect' },
    });
  });
});

describe('ToolRegistry - OpenAI format', () => {
  it('includes contextBuilder in descriptions', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'context_tool',
      description: 'Base description',
      inputSchema: z.object({}),
      contextBuilder: async () => 'Extra context',
      execute: async () => ({ success: true, data: { ok: true } }),
    }));

    const tools = await registry.toOpenAIFormatWithContext(buildContext());
    const entry = tools.find(tool => tool.function.name === 'context_tool');

    expect(entry).toBeTruthy();
    expect(entry?.function.description).toContain('Base description');
    expect(entry?.function.description).toContain('📌 Extra context');
  });

  it('produces a JSON schema object for parameters', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'schema_tool',
      description: 'Schema tool',
      inputSchema: z.object({ value: z.string() }),
      execute: async () => ({ success: true, data: { ok: true } }),
    }));

    const tools = registry.toOpenAIFormat('admin-ui');
    const entry = tools.find(tool => tool.function.name === 'schema_tool');

    expect(entry).toBeTruthy();
    expect(entry?.function.parameters).toMatchObject({
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
    });
    expect(entry?.function.parameters).not.toHaveProperty('$schema');
  });

  it('rejects platform-incompatible tools', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'discord_only',
      description: 'Discord only',
      platforms: ['discord'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const context = { agentId: 'a1', platform: 'telegram' as const };
    const result = await registry.execute('discord_only', {}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available on telegram');
  });

  it('OpenAI format schema generation is stable', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'echo',
      description: 'Echo',
      inputSchema: z.object({
        name: z.string().describe('Name to echo'),
        count: z.number().optional().describe('How many times')
      }),
      execute: async () => ({ success: true }),
    }));

    const result = registry.toOpenAIFormat();
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to echo' },
        count: { type: 'number', description: 'How many times' }
      },
      required: ['name'],
      additionalProperties: false
    });
  });

  it('handles all manual tool uiAction mappings', async () => {
    const registry = new ToolRegistry();
    const manualTools = [
      { name: 'request_secret', type: 'secret_request' },
      { name: 'request_model_selection', type: 'model_selector' },
      { name: 'request_feature_toggle', type: 'feature_toggle' },
      { name: 'request_twitter_connection', type: 'twitter_connect' },
      { name: 'request_property_research', type: 'property_research' },
    ];

    for (const tool of manualTools) {
      registry.register(defineManualTool({
        name: tool.name,
        description: 'Desc',
        inputSchema: z.object({}),
      }));

      const result = await registry.execute(tool.name, {}, buildContext());
      expect(result.uiAction?.type).toBe(tool.type);
      expect(result.uiAction?.payload).toEqual({ type: tool.type });
    }
  });
});
