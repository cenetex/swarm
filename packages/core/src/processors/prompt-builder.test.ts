import { describe, it, expect } from 'bun:test';
import {
  buildDynamicSystemPrompt,
  buildChatSystemPrompt,
  buildResponseStyleSection,
  toolsToCategories,
  type ProcessorAvatarConfig,
} from './prompt-builder.js';

describe('buildDynamicSystemPrompt', () => {
  it('should not duplicate operating principles across prompts', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      persona: 'You are a helpful assistant.',
      enabledCategories: ['secrets', 'profile', 'diagnostics'],
    };

    const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

    // Should have exactly one instance of the operating principles
    const count = (prompt.match(/Operating Principles/g) || []).length;
    expect(count).toBe(1);

    // Should mention at least one key principle
    expect(prompt).toContain('answer it clearly and directly');
  });

  it('should not include REMEMBER directive for chat platforms when responseStyle is set', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      persona: 'You are a helpful assistant.',
      enabledCategories: ['secrets', 'profile', 'diagnostics'],
      responseStyle: { maxLength: 'short' },
    };

    const chatPrompt = buildChatSystemPrompt(avatar, 'telegram');

    // Should not have hard-coded "REMEMBER: Keep responses to 1-2 sentences MAX"
    expect(chatPrompt).not.toContain('REMEMBER: Keep responses');
    expect(chatPrompt).not.toContain('MAX');
  });

  it('should apply default short response style for telegram', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      persona: 'You are a helpful assistant.',
      enabledCategories: ['secrets', 'profile', 'diagnostics'],
    };

    const prompt = buildDynamicSystemPrompt(avatar, 'telegram');

    // Should include response style rules for short responses
    expect(prompt).toContain('1-2 sentences');
  });

  it('should gate sections by tool presence', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      enabledCategories: ['secrets', 'twitter', 'property', 'diagnostics'],
    };

    const withTools = buildDynamicSystemPrompt(avatar, 'admin-ui', undefined, [
      'request_secret',
      'twitter_post',
      'research_property',
      'report_issue',
    ]);

    const withoutTools = buildDynamicSystemPrompt(avatar, 'admin-ui', undefined, ['request_secret', 'report_issue']);

    // With twitter/property tools, should include those sections
    expect(withTools).toContain('Twitter/X Features');
    expect(withTools).toContain('Property Research');

    // Without those tools, sections should be skipped
    expect(withoutTools).not.toContain('Twitter/X Features');
    expect(withoutTools).not.toContain('Property Research');
  });

  describe('regression guard - representative avatar configs', () => {
    it('minimal avatar should have reasonable prompt length', () => {
      const minimal: ProcessorAvatarConfig = {
        avatarId: 'minimal',
        name: 'Minimal Avatar',
        enabledCategories: ['secrets', 'profile', 'diagnostics'],
      };

      const prompt = buildDynamicSystemPrompt(minimal, 'admin-ui');
      const length = prompt.length;

      // Should be reasonably sized (not bloated, not empty)
      expect(length).toBeGreaterThan(500);
      expect(length).toBeLessThan(2500); // Reasonable upper bound for minimal config
    });

    it('media-enabled avatar should include media sections', () => {
      const withMedia: ProcessorAvatarConfig = {
        avatarId: 'media-avatar',
        name: 'Media Avatar',
        enabledCategories: ['secrets', 'profile', 'media', 'gallery', 'diagnostics'],
      };

      const prompt = buildDynamicSystemPrompt(withMedia, 'admin-ui');

      expect(prompt).toContain('Media Generation');
      expect(prompt).toContain('Media Gallery');
      expect(prompt).toContain('generate_image');
    });

    it('property-enabled avatar should be concise', () => {
      const withProperty: ProcessorAvatarConfig = {
        avatarId: 'property-avatar',
        name: 'Property Avatar',
        enabledCategories: ['secrets', 'profile', 'property', 'diagnostics'],
      };

      const prompt = buildDynamicSystemPrompt(withProperty, 'admin-ui', undefined, [
        'request_secret',
        'update_profile',
        'research_property',
        'report_issue',
      ]);

      // Should have trimmed-down property section
      expect(prompt).toContain('Property Research');
      // Should NOT have redundant subsection headers
      const subheaderCount = (prompt.match(/^###/gm) || []).length;
      expect(subheaderCount).toBeLessThan(3); // Minimal subsections
    });

    it('full-featured avatar should not be bloated', () => {
      const full: ProcessorAvatarConfig = {
        avatarId: 'full-avatar',
        name: 'Full Avatar',
        enabledCategories: [
          'secrets',
          'wallets',
          'profile',
          'media',
          'gallery',
          'voice',
          'telegram',
          'twitter',
          'discord',
          'memory',
          'nft',
          'property',
          'diagnostics',
        ],
      };

      const prompt = buildDynamicSystemPrompt(full, 'admin-ui');
      const length = prompt.length;

      // Full-featured but not excessive (should still be under 10k tokens worth of text)
      expect(length).toBeGreaterThan(2000);
      expect(length).toBeLessThan(8000); // Reasonable upper bound even for full config
    });

    it('should not duplicate operating principles in chat vs. dynamic prompts', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        enabledCategories: ['secrets', 'profile', 'diagnostics'],
      };

      const chatPrompt = buildChatSystemPrompt(avatar, 'telegram');
      const dynamicPrompt = buildDynamicSystemPrompt(avatar, 'telegram');

      // Both should have operating principles but not repeated within themselves
      expect((chatPrompt.match(/Operating Principles/g) || []).length).toBe(1);
      expect(
        (dynamicPrompt.match(/Operating Principles/g) || []).length
      ).toBe(1);

      // Key principle should appear in both
      expect(chatPrompt).toContain('answer it clearly and directly');
      expect(dynamicPrompt).toContain('answer it clearly and directly');
    });
  });

  describe('response style section', () => {
    it('should return null when no response style provided', () => {
      const section = buildResponseStyleSection(undefined);
      expect(section).toBeNull();
    });

    it('should include maxLength rules', () => {
      const short = buildResponseStyleSection({ maxLength: 'short' });
      expect(short).toContain('1-2 sentences');

      const medium = buildResponseStyleSection({ maxLength: 'medium' });
      expect(medium).toContain('1-2 paragraphs');

      const long = buildResponseStyleSection({ maxLength: 'long' });
      expect(long).toContain('longer responses');
    });

    it('should include emoji density rules', () => {
      const none = buildResponseStyleSection({ emojiDensity: 'none' });
      expect(none).toContain('not use emoji');

      const heavy = buildResponseStyleSection({ emojiDensity: 'heavy' });
      expect(heavy).toContain('liberally');
    });
  });

  describe('toolsToCategories', () => {
    it('should detect categories from tool names', () => {
      const tools = ['generate_image', 'twitter_post', 'remember'];
      const categories = toolsToCategories(tools);

      expect(categories).toContain('media');
      expect(categories).toContain('twitter');
      expect(categories).toContain('memory');
      expect(categories).toContain('secrets'); // Base category
      expect(categories).toContain('profile'); // Base category
    });

    it('should not duplicate categories', () => {
      const tools = ['generate_image', 'generate_video', 'generate_sticker'];
      const categories = toolsToCategories(tools);

      const mediaCount = categories.filter((c) => c === 'media').length;
      expect(mediaCount).toBe(1);
    });

    it('should always include base categories', () => {
      const categories = toolsToCategories([]);
      expect(categories).toContain('secrets');
      expect(categories).toContain('profile');
      expect(categories).toContain('diagnostics');
    });
  });
});
