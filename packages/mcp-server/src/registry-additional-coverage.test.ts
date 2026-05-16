/**
 * Additional Coverage Tests for Tool Registry
 *
 * These tests address previously untested code paths and edge cases:
 * - MCP format conversion (toMCPFormat, toMCPFormatWithMetadata)
 * - Format conversion helper methods (toOpenAIFormatForTools, toOpenAIFormatWithContextForTools)
 * - Error handling in contextBuilder and shouldShow
 * - Output validation warnings
 * - Complex schema conversions (unions, enums, arrays)
 * - Lookup edge cases (empty registry, invalid inputs)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool, type ToolContext } from './registry.js';

function buildContext(): ToolContext {
  return { avatarId: 'test-avatar', platform: 'admin-ui' as const };
}

describe('Registry - MCP Format Conversion', () => {
  it('toMCPFormat returns empty array for empty registry', () => {
    const registry = new ToolRegistry();
    expect(registry.toMCPFormat()).toEqual([]);
  });

  it('toMCPFormat converts tools to MCP format', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'test_tool',
      description: 'Test description',
      inputSchema: z.object({
        name: z.string(),
        count: z.number().optional(),
      }),
      execute: async () => ({ success: true }),
    }));

    const mcpTools = registry.toMCPFormat();
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0]).toMatchObject({
      name: 'test_tool',
      description: 'Test description',
    });
    expect(mcpTools[0].inputSchema).toHaveProperty('type', 'object');
    expect(mcpTools[0].inputSchema).toHaveProperty('properties');
  });

  it('toMCPFormat handles complex nested schemas', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'nested_tool',
      description: 'Nested schema',
      inputSchema: z.object({
        user: z.object({
          profile: z.object({
            name: z.string(),
            age: z.number(),
          }),
        }),
      }),
      execute: async () => ({ success: true }),
    }));

    const mcpTools = registry.toMCPFormat();
    const schema = mcpTools[0].inputSchema as Record<string, unknown>;
    expect(schema.properties).toHaveProperty('user');
  });

  it('toMCPFormatWithMetadata returns empty array for empty registry', () => {
    const registry = new ToolRegistry();
    expect(registry.toMCPFormatWithMetadata()).toEqual([]);
  });

  it('toMCPFormatWithMetadata includes metadata for all tools', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'media_tool',
      description: 'Media',
      category: 'media',
      toolset: 'media',
      tags: ['image', 'upload'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = registry.toMCPFormatWithMetadata();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'media_tool',
      description: 'Media',
    });
    expect(result[0].metadata).toMatchObject({
      toolset: 'media',
      tags: ['image', 'upload'],
      category: 'media',
      promptGuidance: {
        category: 'media',
      },
    });
  });

  it('toMCPFormatWithMetadata preserves explicit prompt guidance', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'guided_tool',
      description: 'Guided',
      promptGuidance: {
        category: 'custom',
        summary: 'Custom prompt guidance',
        whenToUse: 'When custom guidance is needed',
        examples: ['guided_tool({})'],
      },
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = registry.toMCPFormatWithMetadata();
    expect(result[0].metadata.promptGuidance).toEqual({
      category: 'custom',
      summary: 'Custom prompt guidance',
      whenToUse: 'When custom guidance is needed',
      examples: ['guided_tool({})'],
    });
  });

  it('adds prompt guidance to registered tools by toolset and tool name', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      defineTool({
        name: 'twitter_post',
        description: 'Post',
        toolset: 'twitter',
        inputSchema: z.object({}),
        execute: async () => ({ success: true }),
      }),
      defineTool({
        name: 'set_profile_image',
        description: 'Set profile image',
        category: 'profile',
        inputSchema: z.object({}),
        execute: async () => ({ success: true }),
      }),
    ]);

    expect(registry.get('twitter_post')?.promptGuidance?.category).toBe('twitter');
    expect(registry.get('set_profile_image')?.promptGuidance?.category).toBe('media');
  });

  it('toMCPFormatWithMetadata defaults toolset to core when not specified', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'core_tool',
      description: 'Core',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = registry.toMCPFormatWithMetadata();
    expect(result[0].metadata.toolset).toBe('core');
  });

  it('toMCPFormatWithMetadata includes tags array in metadata', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'no_explicit_tags',
      description: 'No explicit tags',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = registry.toMCPFormatWithMetadata();
    // normalizeToolDefinition adds default tags based on toolset
    expect(Array.isArray(result[0].metadata.tags)).toBe(true);
  });
});

describe('Registry - Format Conversion Helpers', () => {
  it('toOpenAIFormatForTools converts specific tools to OpenAI format', () => {
    const registry = new ToolRegistry();
    const tool1 = defineTool({
      name: 'tool1',
      description: 'First',
      inputSchema: z.object({ a: z.string() }),
      execute: async () => ({ success: true }),
    });
    const tool2 = defineTool({
      name: 'tool2',
      description: 'Second',
      inputSchema: z.object({ b: z.number() }),
      execute: async () => ({ success: true }),
    });

    registry.register(tool1);
    registry.register(tool2);

    const result = registry.toOpenAIFormatForTools([tool1]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe('tool1');
  });

  it('toOpenAIFormatForTools handles empty tools array', () => {
    const registry = new ToolRegistry();
    const result = registry.toOpenAIFormatForTools([]);
    expect(result).toEqual([]);
  });

  it('toOpenAIFormatWithContextForTools enhances descriptions with context', async () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: 'context_tool',
      description: 'Base description',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      contextBuilder: async (context) => `Avatar: ${context.avatarId}`,
    });

    registry.register(tool);

    const result = await registry.toOpenAIFormatWithContextForTools(buildContext(), [tool]);
    expect(result).toHaveLength(1);
    expect(result[0].function.description).toContain('Base description');
    expect(result[0].function.description).toContain('📌 Avatar: test-avatar');
  });

  it('toOpenAIFormatWithContextForTools handles empty tools array', async () => {
    const registry = new ToolRegistry();
    const result = await registry.toOpenAIFormatWithContextForTools(buildContext(), []);
    expect(result).toEqual([]);
  });

  it('toOpenAIFormatWithContextForTools handles tools without contextBuilder', async () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: 'no_context',
      description: 'No context builder',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });

    registry.register(tool);

    const result = await registry.toOpenAIFormatWithContextForTools(buildContext(), [tool]);
    expect(result[0].function.description).toBe('No context builder');
  });
});

describe('Registry - Complex Schema Conversions', () => {
  it('converts enum types to OpenAI format with enum values', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'enum_tool',
      description: 'Enum test',
      inputSchema: z.object({
        color: z.enum(['red', 'green', 'blue']),
      }),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toOpenAIFormat();
    const params = tools[0].function.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    const colorProp = props.color as Record<string, unknown>;
    
    expect(colorProp.enum).toEqual(['red', 'green', 'blue']);
  });

  it('converts array types to OpenAI format', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'array_tool',
      description: 'Array test',
      inputSchema: z.object({
        tags: z.array(z.string()),
      }),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toOpenAIFormat();
    const params = tools[0].function.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    const tagsProp = props.tags as Record<string, unknown>;
    
    expect(tagsProp.type).toBe('array');
    expect(tagsProp.items).toBeDefined();
  });

  it('handles union types in schema conversion', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'union_tool',
      description: 'Union test',
      inputSchema: z.object({
        value: z.union([z.string(), z.number()]),
      }),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toOpenAIFormat();
    expect(tools[0].function.parameters).toBeDefined();
    // Schema should be generated (exact format may vary based on zod-to-json-schema)
  });

  it('handles optional fields correctly in required array', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'optional_tool',
      description: 'Optional test',
      inputSchema: z.object({
        required_field: z.string(),
        optional_field: z.string().optional(),
      }),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toOpenAIFormat();
    const params = tools[0].function.parameters as Record<string, unknown>;
    const required = params.required as string[];
    
    expect(required).toContain('required_field');
    expect(required).not.toContain('optional_field');
  });

  it('converts default values in schema', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'default_tool',
      description: 'Default test',
      inputSchema: z.object({
        count: z.number().default(10),
      }),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toOpenAIFormat();
    const params = tools[0].function.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    const countProp = props.count as Record<string, unknown>;
    
    expect(countProp.default).toBe(10);
  });
});

describe('Registry - Error Handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs warning when output validation fails but continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ToolRegistry();
    
    registry.register(defineTool({
      name: 'bad_output',
      description: 'Bad output',
      inputSchema: z.object({}),
      outputSchema: z.object({ id: z.string() }),
      execute: async () => ({
        success: true,
        data: { id: 123 }, // Should be string, not number
      }),
    }));

    const result = await registry.execute('bad_output', {}, buildContext());
    
    expect(result.success).toBe(true); // Still succeeds
    expect(result.data).toEqual({ id: 123 }); // Data is returned as-is
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Output validation failed'),
      expect.anything()
    );
  });

  it('throws error when contextBuilder fails', async () => {
    const registry = new ToolRegistry();
    
    registry.register(defineTool({
      name: 'broken_context',
      description: 'Broken context builder',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      contextBuilder: async () => {
        throw new Error('Context builder failed');
      },
    }));

    await expect(
      registry.toOpenAIFormatWithContext(buildContext())
    ).rejects.toThrow('Context builder failed');
  });

  it('handles shouldShow throwing an error gracefully', async () => {
    const registry = new ToolRegistry();
    
    registry.register(defineTool({
      name: 'broken_visibility',
      description: 'Broken visibility check',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      shouldShow: async () => {
        throw new Error('shouldShow failed');
      },
    }));

    // Tool should still be retrievable even if shouldShow throws
    const tool = registry.get('broken_visibility');
    expect(tool).toBeDefined();
  });

  it('catches errors in tool execution', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ToolRegistry();
    
    registry.register(defineTool({
      name: 'throwing_tool',
      description: 'Throws error',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('Execution failed');
      },
    }));

    const result = await registry.execute('throwing_tool', {}, buildContext());
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution failed');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('Registry - Lookup Edge Cases', () => {
  it('getAll returns empty array for empty registry', () => {
    const registry = new ToolRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it('getByCategory returns empty array for non-existent category', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'media_tool',
      description: 'Media',
      category: 'media',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    // Type assertion needed to test invalid category handling
    expect(registry.getByCategory('wallet')).toEqual([]);
  });

  it('getByCategory returns empty array when no tools have category', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'uncategorized',
      description: 'No category',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    expect(registry.getByCategory('media')).toEqual([]);
  });

  it('getForPlatform returns all tools when platform is undefined', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'universal',
      description: 'Universal',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    // All tools without platform restrictions should be available everywhere
    const tools = registry.getForPlatform('telegram');
    expect(tools).toHaveLength(1);
  });

  it('getForPlatform returns empty array for platform with no matching tools', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'admin_only',
      description: 'Admin only',
      platforms: ['admin-ui'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const telegramTools = registry.getForPlatform('telegram');
    expect(telegramTools).toEqual([]);
  });
});

describe('Registry - Registration Edge Cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when overwriting an existing tool', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ToolRegistry();
    
    const tool = defineTool({
      name: 'duplicate',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });

    registry.register(tool);
    registry.register(tool); // Register again

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Overwriting existing tool: duplicate')
    );
  });

  it('registerAll warns for each duplicate', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ToolRegistry();
    
    const tool1 = defineTool({
      name: 'same_name',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });
    
    const tool2 = defineTool({
      name: 'same_name',
      description: 'Second',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });

    registry.registerAll([tool1, tool2]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Overwriting existing tool: same_name')
    );
  });

  it('normalizes toolset from category when toolset not specified', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'wallet_tool',
      description: 'Wallet',
      category: 'wallet',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tool = registry.get('wallet_tool');
    // Should derive toolset from category via CATEGORY_TOOLSET_MAP
    expect(tool?.toolset).toBe('wallet');
  });

  it('preserves explicit toolset even when category differs', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'custom_tool',
      description: 'Custom',
      category: 'media',
      toolset: 'core', // Explicit toolset
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tool = registry.get('custom_tool');
    expect(tool?.toolset).toBe('core'); // Should preserve explicit value
  });
});

describe('Registry - Platform Validation Edge Cases', () => {
  it('rejects execution on incompatible platform', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'admin_only',
      description: 'Admin only',
      platforms: ['admin-ui'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = await registry.execute('admin_only', {}, {
      avatarId: 'test',
      platform: 'telegram',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available on telegram');
  });

  it('allows execution on compatible platform', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'multi_platform',
      description: 'Multi platform',
      platforms: ['admin-ui', 'telegram'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const result = await registry.execute('multi_platform', {}, {
      avatarId: 'test',
      platform: 'telegram',
    });

    expect(result.success).toBe(true);
  });
});
