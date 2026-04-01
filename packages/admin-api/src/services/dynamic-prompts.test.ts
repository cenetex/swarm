import { describe, it, expect } from 'vitest';
import { buildDynamicSystemPrompt, type ProcessorAvatarConfig } from '@swarm/core';

describe('dynamic prompts', () => {
  it('includes core operating principles in base prompt', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'ava_1',
      name: 'TestAvatar',
      description: 'Helps configure integrations.',
      persona: 'Be warm and concise.',
      enabledCategories: [],
    };
    const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

    expect(prompt).toContain('You are TestAvatar');
    expect(prompt).toContain('Be warm and concise');
    expect(prompt).toContain('Answer direct questions clearly before anything else');
    expect(prompt).toContain('Keep responses to 1-2 sentences');
    expect(prompt).toContain('Confirm before posting, spending, or irreversible actions');
    expect(prompt).toContain("Don't request secrets in chat");
    expect(prompt).toContain('You are not human');
  });

  it('includes runtime context when provided', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'ava_2',
      name: 'TestAvatar',
      enabledCategories: [],
    };
    const prompt = buildDynamicSystemPrompt(avatar, 'telegram', {
      channelId: 'test-channel',
      timestamp: new Date('2026-04-01T12:00:00Z'),
      sender: {
        id: 'user-123',
        username: 'testuser',
        displayName: 'Test User',
      },
    });

    expect(prompt).toContain('## Current Context');
    expect(prompt).toContain('Platform: telegram');
    expect(prompt).toContain('Channel: test-channel');
    expect(prompt).toContain('## User');
    expect(prompt).toContain('Username: testuser');
    expect(prompt).toContain('Display Name: Test User');
  });
});
