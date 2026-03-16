import { describe, it, expect } from 'vitest';
import {
  buildAutonomousPrompt,
} from './autonomous-content.js';
import type { BrainMemoryFact } from '@swarm/core';

describe('buildAutonomousPrompt', () => {
  const baseParams = {
    persona: 'I am a catboy who lives on the internet.',
    memories: [] as BrainMemoryFact[],
    recentPosts: [] as BrainMemoryFact[],
    targetType: 'tweet' as const,
    charLimit: 280,
  };

  it('includes persona in the prompt', () => {
    const prompt = buildAutonomousPrompt(baseParams);
    expect(prompt).toContain('I am a catboy who lives on the internet.');
  });

  it('includes memories when provided', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      memories: [
        { fact: 'Users love memes', timestamp: 1000 },
        { fact: 'The community is growing', timestamp: 900 },
      ],
    });
    expect(prompt).toContain('## Recent Thoughts & Memories');
    expect(prompt).toContain('Users love memes');
    expect(prompt).toContain('The community is growing');
  });

  it('includes recent posts for repetition avoidance', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      recentPosts: [
        { fact: 'Posted tweet: "gm frens"', timestamp: 1000 },
      ],
    });
    expect(prompt).toContain('## Your Recent Posts');
    expect(prompt).toContain('gm frens');
  });

  it('includes dream context when provided', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      crossPlatformContext: {
        dreamContext: {
          dream: 'Wandering through a library of infinite code',
          previousDream: 'Swimming in a sea of data streams',
          iteration: 3,
        },
      },
    });
    expect(prompt).toContain('## Current Dream / Narrative State');
    expect(prompt).toContain('Wandering through a library of infinite code');
    expect(prompt).toContain('Swimming in a sea of data');
    expect(prompt).toContain('subtly influence your tone');
  });

  it('includes gallery metadata when provided', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      crossPlatformContext: {
        galleryMetadata: [
          { prompt: 'Neon cityscape at night', caption: 'City vibes', createdAt: 1000 },
          { prompt: 'Mystical forest', createdAt: 900 },
        ],
      },
    });
    expect(prompt).toContain('## Recent Visual Creations');
    expect(prompt).toContain('City vibes'); // caption preferred over prompt
    expect(prompt).toContain('Mystical forest');
  });

  it('uses prompt as fallback when caption is not available', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      crossPlatformContext: {
        galleryMetadata: [
          { prompt: 'A raw prompt value', createdAt: 1000 },
        ],
      },
    });
    expect(prompt).toContain('A raw prompt value');
  });

  it('does not include dream section when dreamContext is absent', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      crossPlatformContext: {},
    });
    expect(prompt).not.toContain('## Current Dream');
  });

  it('does not include gallery section when galleryMetadata is empty', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      crossPlatformContext: { galleryMetadata: [] },
    });
    expect(prompt).not.toContain('## Recent Visual Creations');
  });

  it('includes community post instructions', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      targetType: 'community_post',
      communityContext: { id: 'comm-1', name: 'AI Builders' },
    });
    expect(prompt).toContain('Post to "AI Builders" Community');
  });

  it('includes community reply instructions', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      targetType: 'community_reply',
      communityContext: {
        id: 'comm-1',
        name: 'AI Builders',
        replyToTweet: {
          id: 'tweet-1',
          text: 'What are you building?',
          author: 'alice',
        },
      },
    });
    expect(prompt).toContain('Reply in "AI Builders" Community');
    expect(prompt).toContain('@alice');
    expect(prompt).toContain('What are you building?');
  });

  it('includes all cross-platform context sources together', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      memories: [{ fact: 'A memory', timestamp: 1000 }],
      recentPosts: [{ fact: 'A recent post', timestamp: 900 }],
      crossPlatformContext: {
        dreamContext: {
          dream: 'Dream state active',
          iteration: 2,
        },
        galleryMetadata: [
          { prompt: 'Gallery image prompt', createdAt: 800 },
        ],
      },
    });

    // All sections should be present
    expect(prompt).toContain('## Current Dream / Narrative State');
    expect(prompt).toContain('## Recent Thoughts & Memories');
    expect(prompt).toContain('## Recent Visual Creations');
    expect(prompt).toContain('## Your Recent Posts');
    expect(prompt).toContain('## Task: Generate Tweet');
    expect(prompt).toContain('## Constraints');
  });

  it('respects charLimit in constraints', () => {
    const prompt = buildAutonomousPrompt({
      ...baseParams,
      charLimit: 500,
    });
    expect(prompt).toContain('Maximum 500 characters');
  });
});
