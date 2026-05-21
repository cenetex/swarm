import { describe, it, expect, vi } from 'vitest';
import {
  detectEnabledCategories,
  resolveAllowedToolsets,
  filterByPlatform,
  filterByToolsets,
  filterByVisibility,
  filterTools,
  createToolContext,
  DEFAULT_CATEGORIES,
  BASE_TOOLSETS,
  CATEGORY_TOOLSETS,
  type FilterableToolDefinition,
} from './tool-builder.js';
import type { ProcessorConfig } from './types.js';

describe('detectEnabledCategories', () => {
  it('should always include default categories', () => {
    const categories = detectEnabledCategories({});

    expect(categories).toContain('secrets');
    expect(categories).toContain('profile');
    expect(categories).toContain('media');
    expect(categories).toContain('gallery');
    expect(categories).toContain('wallets');
    expect(categories).toContain('diagnostics');
  });

  it('should include voice when voice service is available', () => {
    const categories = detectEnabledCategories({ voice: true });

    expect(categories).toContain('voice');
  });

  it('should not include voice when voice service is unavailable', () => {
    const categories = detectEnabledCategories({ voice: false });

    expect(categories).not.toContain('voice');
  });

  it('should include memory when memory service is available', () => {
    const categories = detectEnabledCategories({ memory: true });

    expect(categories).toContain('memory');
  });

  it('should include platform categories when platforms are enabled', () => {
    const categories = detectEnabledCategories({
      telegram: true,
      twitter: true,
      discord: true,
    });

    expect(categories).toContain('telegram');
    expect(categories).toContain('twitter');
    expect(categories).toContain('discord');
  });

  it('should include nft and property when available', () => {
    const categories = detectEnabledCategories({
      nft: true,
      property: true,
    });

    expect(categories).toContain('nft');
    expect(categories).toContain('property');
  });

  it('should include signal-station when signalStation is true', () => {
    const categories = detectEnabledCategories({ signalStation: true });
    expect(categories).toContain('signal-station');
  });

  it('should not include signal-station when signalStation is omitted', () => {
    const categories = detectEnabledCategories({});
    expect(categories).not.toContain('signal-station');
  });
});

describe('resolveAllowedToolsets', () => {
  it('should return undefined when no categories provided', () => {
    const toolsets = resolveAllowedToolsets(undefined);
    expect(toolsets).toBeUndefined();
  });

  it('should return undefined when empty categories array provided', () => {
    const toolsets = resolveAllowedToolsets([]);
    expect(toolsets).toBeUndefined();
  });

  it('should always include base toolsets', () => {
    const toolsets = resolveAllowedToolsets(['profile']);

    expect(toolsets).toContain('core');
    expect(toolsets).toContain('admin');
    expect(toolsets).toContain('config');
    expect(toolsets).toContain('jobs');
    expect(toolsets).not.toContain('models');
  });

  it('should include model tools only when the models category is enabled', () => {
    const toolsets = resolveAllowedToolsets(['models']);

    expect(toolsets).toContain('models');
  });

  it('should map categories to their toolsets', () => {
    const toolsets = resolveAllowedToolsets(['secrets', 'wallets', 'media']);

    expect(toolsets).toContain('secrets');
    expect(toolsets).toContain('wallet');
    expect(toolsets).toContain('media');
  });

  it('should include all platform toolsets when platform categories are enabled', () => {
    const toolsets = resolveAllowedToolsets(['telegram', 'twitter', 'discord']);

    expect(toolsets).toContain('telegram');
    expect(toolsets).toContain('twitter');
    expect(toolsets).toContain('discord');
  });

  it('should deduplicate toolsets', () => {
    const toolsets = resolveAllowedToolsets(['secrets', 'secrets', 'profile']);

    const uniqueToolsets = new Set(toolsets);
    expect(toolsets?.length).toBe(uniqueToolsets.size);
  });
});

describe('filterByPlatform', () => {
  it('should include tools with no platform restriction', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'tool1' },
      { name: 'tool2' },
    ];

    const filtered = filterByPlatform(tools, 'telegram');

    expect(filtered).toHaveLength(2);
  });

  it('should include tools that match the platform', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'telegram_tool', platforms: ['telegram'] },
      { name: 'admin_tool', platforms: ['admin-ui'] },
    ];

    const filtered = filterByPlatform(tools, 'telegram');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('telegram_tool');
  });

  it('should include tools available on multiple platforms', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'shared_tool', platforms: ['telegram', 'discord'] },
    ];

    const filtered = filterByPlatform(tools, 'discord');

    expect(filtered).toHaveLength(1);
  });
});

describe('filterByToolsets', () => {
  it('should include all tools when no allowedToolsets provided', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'tool1', toolset: 'core' },
      { name: 'tool2', toolset: 'media' },
    ];

    const filtered = filterByToolsets(tools, undefined);

    expect(filtered).toHaveLength(2);
  });

  it('should filter tools by allowed toolsets', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'core_tool', toolset: 'core' },
      { name: 'media_tool', toolset: 'media' },
      { name: 'voice_tool', toolset: 'voice' },
    ];

    const filtered = filterByToolsets(tools, ['core', 'media']);

    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.name)).toContain('core_tool');
    expect(filtered.map(t => t.name)).toContain('media_tool');
    expect(filtered.map(t => t.name)).not.toContain('voice_tool');
  });

  it('should default to core toolset for tools without toolset', () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'no_toolset_tool' },
    ];

    const filtered = filterByToolsets(tools, ['core']);

    expect(filtered).toHaveLength(1);
  });
});

describe('filterByVisibility', () => {
  it('should include tools without shouldShow function', async () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'tool1' },
      { name: 'tool2' },
    ];

    const context = { avatarId: 'test', platform: 'telegram' as const };
    const filtered = await filterByVisibility(tools, context);

    expect(filtered).toHaveLength(2);
  });

  it('should filter out tools where shouldShow returns false', async () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'visible_tool', shouldShow: vi.fn(() => Promise.resolve(true)) },
      { name: 'hidden_tool', shouldShow: vi.fn(() => Promise.resolve(false)) },
    ];

    const context = { avatarId: 'test', platform: 'telegram' as const };
    const filtered = await filterByVisibility(tools, context);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('visible_tool');
  });

  it('should show tools when shouldShow throws an error', async () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'error_tool', shouldShow: vi.fn(() => Promise.reject(new Error('Check failed'))) },
    ];

    const context = { avatarId: 'test', platform: 'telegram' as const };
    const filtered = await filterByVisibility(tools, context);

    expect(filtered).toHaveLength(1);
  });
});

describe('filterTools', () => {
  it('should apply all filters in correct order', async () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'telegram_media', toolset: 'media', platforms: ['telegram'] },
      { name: 'admin_media', toolset: 'media', platforms: ['admin-ui'] },
      { name: 'telegram_voice', toolset: 'voice', platforms: ['telegram'] },
    ];

    const context = { avatarId: 'test', platform: 'telegram' as const };
    const filtered = await filterTools(tools, context, ['media']);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('telegram_media');
  });

  it('should work with no enabled categories', async () => {
    const tools: FilterableToolDefinition[] = [
      { name: 'tool1', toolset: 'core' },
    ];

    const context = { avatarId: 'test', platform: 'telegram' as const };
    const filtered = await filterTools(tools, context);

    expect(filtered).toHaveLength(1);
  });
});

describe('createToolContext', () => {
  it('should create context from processor config', () => {
    const config: ProcessorConfig = {
      avatarId: 'test-avatar',
      platform: 'telegram',
      conversationId: 'chat-123',
      userId: 'user-456',
      replyToMessageId: 'msg-789',
      session: { email: 'test@example.com', isAdmin: true },
    };

    const context = createToolContext(config);

    expect(context.avatarId).toBe('test-avatar');
    expect(context.platform).toBe('telegram');
    expect(context.userId).toBe('user-456');
    expect(context.conversationId).toBe('chat-123');
    expect(context.replyToMessageId).toBe('msg-789');
    expect(context.session?.email).toBe('test@example.com');
    expect(context.session?.isAdmin).toBe(true);
  });
});

describe('CATEGORY_TOOLSETS mapping', () => {
  it('should map all categories to toolsets', () => {
    const expectedMappings = {
      secrets: ['secrets'],
      wallets: ['wallet'],
      profile: ['profile'],
      media: ['media'],
      gallery: ['gallery'],
      voice: ['voice'],
      telegram: ['telegram'],
      twitter: ['twitter'],
      discord: ['discord'],
      memory: ['memory'],
      nft: ['nft'],
      property: ['property'],
      diagnostics: ['diagnostics'],
    };

    for (const [category, toolsets] of Object.entries(expectedMappings)) {
      expect(CATEGORY_TOOLSETS[category as keyof typeof CATEGORY_TOOLSETS]).toEqual(toolsets);
    }
  });
});

describe('DEFAULT_CATEGORIES', () => {
  it('should include the expected default categories', () => {
    expect(DEFAULT_CATEGORIES).toContain('secrets');
    expect(DEFAULT_CATEGORIES).toContain('profile');
    expect(DEFAULT_CATEGORIES).toContain('media');
    expect(DEFAULT_CATEGORIES).toContain('gallery');
    expect(DEFAULT_CATEGORIES).toContain('wallets');
    expect(DEFAULT_CATEGORIES).toContain('diagnostics');
  });
});

describe('BASE_TOOLSETS', () => {
  it('should include the expected base toolsets', () => {
    expect(BASE_TOOLSETS).toContain('core');
    expect(BASE_TOOLSETS).toContain('admin');
    expect(BASE_TOOLSETS).toContain('config');
    expect(BASE_TOOLSETS).toContain('jobs');
    expect(BASE_TOOLSETS).not.toContain('models');
  });
});
