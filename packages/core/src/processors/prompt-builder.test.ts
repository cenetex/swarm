import { describe, it, expect } from 'bun:test';
import {
  buildDynamicSystemPrompt,
  buildChatSystemPrompt,
  toolsToCategories,
} from './prompt-builder.js';
import type { ProcessorAvatarConfig } from './types.js';

describe('prompt-builder refactoring', () => {
  describe('operating principles deduplication', () => {
    it('buildDynamicSystemPrompt includes operating principles once', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['profile'],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      const operatingPrinciplesMatches = (prompt.match(/Operating Principles/g) || []).length;
      expect(operatingPrinciplesMatches).toBe(1);
    });

    it('buildChatSystemPrompt includes operating principles once', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['profile'],
      };

      const prompt = buildChatSystemPrompt(avatar, 'telegram');
      const operatingPrinciplesMatches = (prompt.match(/Operating Principles/g) || []).length;
      expect(operatingPrinciplesMatches).toBe(1);
    });

    it('both paths use identical operating principles', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['profile'],
      };

      const dynamic = buildDynamicSystemPrompt(avatar, 'admin-ui');
      const chat = buildChatSystemPrompt(avatar, 'telegram');

      // Extract operating principles from both
      const dynamicPrinciples = dynamic.match(/## Operating Principles[\s\S]*?(?=\n##|$)/);
      const chatPrinciples = chat.match(/## Operating Principles[\s\S]*?(?=\n##|$)/);

      expect(dynamicPrinciples).toBeDefined();
      expect(chatPrinciples).toBeDefined();
      expect(dynamicPrinciples?.[0]).toBe(chatPrinciples?.[0]);
    });
  });

  describe('REMEMBER vs responseStyle conflict resolution', () => {
    it('removes hard-coded REMEMBER block on chat platforms', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['profile'],
      };

      const prompt = buildChatSystemPrompt(avatar, 'telegram');
      expect(prompt).not.toContain('**REMEMBER: Keep responses to 1-2 sentences MAX**');
      expect(prompt).not.toContain('REMEMBER');
    });

    it('defaults chat platforms to short responseStyle', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['profile'],
      };

      const prompt = buildChatSystemPrompt(avatar, 'telegram');
      // Response style section should be present and indicate brief/short responses
      expect(prompt).toContain('Keep responses to 1-2 sentences');
    });

    it('respects explicit responseStyle when provided', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        responseStyle: { maxLength: 'long' },
        enabledCategories: ['profile'],
      };

      const prompt = buildChatSystemPrompt(avatar, 'telegram');
      // Should use the provided long responseStyle, not default to short
      expect(prompt).toContain('longer responses');
    });
  });

  describe('directive density trimming', () => {
    it('twitter section is shortened', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['twitter'],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      const twitterSection = prompt.match(/## Twitter[\s\S]*?(?=\n## |$)/)?.[0];
      expect(twitterSection).toBeDefined();
      // Should not have subsections like "### Posting Images", should be more compact
      expect(twitterSection).not.toContain('### Posting Images');
      // But should still contain core guidance
      expect(twitterSection).toContain('twitter_post');
    });

    it('property section is shortened', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'test-avatar',
        name: 'Test Avatar',
        persona: 'You are a helpful assistant.',
        enabledCategories: ['property'],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      const propertySection = prompt.match(/## Property[\s\S]*?(?=\n## |$)/)?.[0];
      expect(propertySection).toBeDefined();
      // Should not have the "CRITICAL" subsections
      expect(propertySection).not.toContain('### CRITICAL');
      // But should still have the key tool name
      expect(propertySection).toContain('research_property');
    });
  });

  describe('tool-presence gating', () => {
    it('toolsToCategories only includes categories for present tools', () => {
      const tools = ['generate_image', 'update_profile'];
      const categories = toolsToCategories(tools);

      expect(categories).toContain('media');
      expect(categories).toContain('profile');
      expect(categories).not.toContain('voice');
    });

    it('toolsToCategories includes base categories regardless of tools', () => {
      const tools: string[] = [];
      const categories = toolsToCategories(tools);

      // secrets, profile, diagnostics are always included
      expect(categories).toContain('secrets');
      expect(categories).toContain('profile');
      expect(categories).toContain('diagnostics');
    });
  });

  describe('regression guard snapshot tests', () => {
    it('minimal avatar config produces reasonable prompt length', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'minimal',
        name: 'Minimal Avatar',
        persona: 'You are helpful.',
        enabledCategories: ['profile', 'diagnostics', 'secrets'],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      expect(prompt.length).toBeGreaterThan(500);
      expect(prompt.length).toBeLessThan(5000);
    });

    it('media-enabled avatar includes media section', () => {
      const toolsWithMedia = ['generate_image', 'generate_video'];
      const categories = toolsToCategories(toolsWithMedia);

      const avatar: ProcessorAvatarConfig = {
        avatarId: 'media-avatar',
        name: 'Media Avatar',
        persona: 'You generate cool images.',
        enabledCategories: categories,
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      expect(prompt).toContain('## Media Generation');
      expect(prompt).toContain('generate_image');
    });

    it('property-enabled avatar includes property section', () => {
      const toolsWithProperty = ['research_property'];
      const categories = toolsToCategories(toolsWithProperty);

      const avatar: ProcessorAvatarConfig = {
        avatarId: 'property-avatar',
        name: 'Property Avatar',
        persona: 'You research properties.',
        enabledCategories: categories,
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      expect(prompt).toContain('## Property Research');
      expect(prompt).toContain('research_property');
    });

    it('full avatar config does not excessively bloat', () => {
      const allTools = [
        'generate_image',
        'generate_video',
        'twitter_post',
        'research_property',
        'remember',
        'recall',
      ];
      const categories = toolsToCategories(allTools);

      const avatar: ProcessorAvatarConfig = {
        avatarId: 'full-avatar',
        name: 'Full Avatar',
        persona: 'I do everything.',
        enabledCategories: categories,
        wallets: [{ name: 'main', publicKey: 'pubkey123' }],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      // Should be reasonable length even with all tools
      expect(prompt.length).toBeLessThan(15000);
      // Should not have duplicated sections
      const sections = (prompt.match(/^## /gm) || []).length;
      expect(sections).toBeGreaterThan(8);
      expect(sections).toBeLessThan(30);
    });

    it('telegram chat prompt is more concise than admin-ui prompt', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'compare-avatar',
        name: 'Compare Avatar',
        persona: 'You are helpful.',
        enabledCategories: ['media', 'profile', 'diagnostics', 'secrets'],
      };

      const chatPrompt = buildChatSystemPrompt(avatar, 'telegram');
      const adminPrompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

      // Chat prompt should be leaner (no cross-platform context, presence, etc.)
      expect(chatPrompt.length).toBeLessThan(adminPrompt.length);
    });

    it('no orphaned instruction blocks for disabled categories', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'no-orphans',
        name: 'Clean Avatar',
        persona: 'Minimal setup.',
        enabledCategories: ['profile', 'diagnostics', 'secrets'], // No voice, twitter, etc.
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

      // Should not mention tools that aren't enabled
      expect(prompt).not.toContain('twitter_post');
      expect(prompt).not.toContain('send_voice_message');
      expect(prompt).not.toContain('research_property');
    });
  });

  describe('proactive memory injection integration', () => {
    it('chat system prompt does not include memory recall instructions', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'no-memory',
        name: 'Test Avatar',
        persona: 'You are helpful.',
        enabledCategories: ['profile'],
      };

      // Memory is not in enabledCategories, so no memory section should appear
      const prompt = buildChatSystemPrompt(avatar, 'telegram');
      expect(prompt).not.toContain('remember');
      expect(prompt).not.toContain('recall');
    });

    it('memory category is included when enabled', () => {
      const avatar: ProcessorAvatarConfig = {
        avatarId: 'with-memory',
        name: 'Memory Avatar',
        persona: 'You remember things.',
        enabledCategories: ['profile', 'memory'],
      };

      const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');
      expect(prompt).toContain('## Memory');
      expect(prompt).toContain('remember');
      expect(prompt).toContain('recall');
    });
  });
});
