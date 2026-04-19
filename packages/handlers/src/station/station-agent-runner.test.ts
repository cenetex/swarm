/**
 * Station Agent Runner - hail voice integration tests
 *
 * Covers the pure helpers `extractHailText` and `maybeGenerateHailAudio`.
 * The orchestration is kept dep-injectable so these tests don't need Dynamo/Replicate.
 */
import { describe, it, expect } from 'bun:test';
import type { AvatarConfig } from '@swarm/core';
import {
  extractHailText,
  maybeGenerateHailAudio,
  fetchChannelChatContext,
  type HailAudioDeps,
  type ChannelChatDeps,
} from './station-agent-runner.js';

const VOICE_CONFIG = {
  enabled: true,
  ttsProvider: 'voice-clone' as const,
  referenceUrl: 'https://cdn.example.com/ref.wav',
};

function baseAvatar(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    id: 'signal-helios',
    name: 'Helios Works',
    voice: VOICE_CONFIG,
    ...overrides,
  } as AvatarConfig;
}

describe('extractHailText', () => {
  it('returns the hail message from a successful signal_set_hail result', () => {
    const text = extractHailText([
      { name: 'signal_station_state', result: { success: true, data: { station: { index: 2 } } } },
      { name: 'signal_set_hail', result: { success: true, data: { hail: 'All systems nominal.' } } },
    ]);
    expect(text).toBe('All systems nominal.');
  });

  it('ignores failed signal_set_hail calls', () => {
    const text = extractHailText([
      { name: 'signal_set_hail', result: { success: false } },
    ]);
    expect(text).toBeUndefined();
  });

  it('ignores whitespace-only hail text', () => {
    const text = extractHailText([
      { name: 'signal_set_hail', result: { success: true, data: { hail: '   ' } } },
    ]);
    expect(text).toBeUndefined();
  });

  it('returns undefined when no signal_set_hail call happened', () => {
    const text = extractHailText([
      { name: 'signal_station_state', result: { success: true } },
      { name: 'signal_set_price', result: { success: true, data: { price: 10 } } },
    ]);
    expect(text).toBeUndefined();
  });
});

function makeDeps(partial: Partial<HailAudioDeps> = {}): HailAudioDeps & { calls: { gen: number; put: number; lastRead?: string } } {
  const state = { calls: { gen: 0, put: 0, lastRead: undefined as string | undefined } };
  const deps: HailAudioDeps = {
    getLastHailText: async () => state.calls.lastRead,
    setLastHailText: async () => { state.calls.put += 1; },
    generateVoiceMessage: async () => { state.calls.gen += 1; return { url: 'https://cdn.example.com/out.mp3' }; },
    mediaBucket: 'test-bucket',
    ...partial,
  };
  return Object.assign(deps, { calls: state.calls });
}

describe('maybeGenerateHailAudio', () => {
  it('generates audio and records the URL when the hail text is new', async () => {
    const deps = makeDeps();
    const result = await maybeGenerateHailAudio('signal-helios', 'Fresh hail.', baseAvatar(), deps);
    expect(result).toEqual({ url: 'https://cdn.example.com/out.mp3' });
    expect(deps.calls.gen).toBe(1);
    expect(deps.calls.put).toBe(1);
  });

  it('skips generation when the new hail matches the last-generated text', async () => {
    const deps = makeDeps({ getLastHailText: async () => 'Same hail.' });
    const result = await maybeGenerateHailAudio('signal-helios', 'Same hail.', baseAvatar(), deps);
    expect(result).toEqual({ skipped: 'unchanged' });
    expect(deps.calls.gen).toBe(0);
    expect(deps.calls.put).toBe(0);
  });

  it('skips when voice is disabled on the avatar config', async () => {
    const deps = makeDeps();
    const avatar = baseAvatar({ voice: { ...VOICE_CONFIG, enabled: false } });
    const result = await maybeGenerateHailAudio('signal-helios', 'Hello.', avatar, deps);
    expect(result).toEqual({ skipped: 'voice-disabled' });
    expect(deps.calls.gen).toBe(0);
  });

  it('skips when the avatar has no reference URL', async () => {
    const deps = makeDeps();
    const avatar = baseAvatar({ voice: { ...VOICE_CONFIG, referenceUrl: undefined } });
    const result = await maybeGenerateHailAudio('signal-helios', 'Hello.', avatar, deps);
    expect(result).toEqual({ skipped: 'no-reference' });
    expect(deps.calls.gen).toBe(0);
  });

  it('skips when MEDIA_BUCKET is not configured', async () => {
    const deps = makeDeps({ mediaBucket: undefined });
    const result = await maybeGenerateHailAudio('signal-helios', 'Hello.', baseAvatar(), deps);
    expect(result).toEqual({ skipped: 'no-media-bucket' });
    expect(deps.calls.gen).toBe(0);
  });

  it('returns a non-fatal error outcome when voice generation throws', async () => {
    const deps = makeDeps({
      generateVoiceMessage: async () => { throw new Error('replicate: 502 upstream'); },
    });
    const result = await maybeGenerateHailAudio('signal-helios', 'Hello.', baseAvatar(), deps);
    expect(result.error).toContain('replicate: 502 upstream');
    expect(result.url).toBeUndefined();
    expect(deps.calls.put).toBe(0);
  });
});

function makeChannelDeps(partial: Partial<ChannelChatDeps> = {}): ChannelChatDeps {
  return {
    readChannelMessages: async (limit, since) => ({
      messages: [
        { id: 1, text: 'Prospect online.' },
        { id: 2, text: 'All stations nominal.' },
      ],
    }),
    getLastChannelMessageId: async () => undefined,
    ...partial,
  };
}

describe('fetchChannelChatContext', () => {
  it('formats recent channel messages for the system prompt', async () => {
    const deps = makeChannelDeps();
    const context = await fetchChannelChatContext('signal-helios', deps);
    expect(context.count).toBe(2);
    expect(context.maxId).toBe(2);
    expect(context.text).toContain('Recent station-band chatter:');
    expect(context.text).toContain('Prospect online.');
    expect(context.text).toContain('All stations nominal.');
    expect(context.error).toBeUndefined();
  });

  it('returns a graceful fallback when channel read fails', async () => {
    const deps = makeChannelDeps({
      readChannelMessages: async () => {
        throw new Error('Network timeout');
      },
    });
    const context = await fetchChannelChatContext('signal-helios', deps);
    expect(context.count).toBe(0);
    expect(context.maxId).toBeUndefined();
    expect(context.text).toContain('fetch failed');
    expect(context.error).toContain('Network timeout');
  });

  it('handles empty channel messages gracefully', async () => {
    const deps = makeChannelDeps({
      readChannelMessages: async () => ({ messages: [] }),
    });
    const context = await fetchChannelChatContext('signal-helios', deps);
    expect(context.count).toBe(0);
    expect(context.maxId).toBeUndefined();
    expect(context.text).toContain('(none)');
    expect(context.error).toBeUndefined();
  });

  it('caps message text at 200 characters', async () => {
    const longText = 'a'.repeat(300);
    const deps = makeChannelDeps({
      readChannelMessages: async () => ({
        messages: [{ id: 1, text: longText }],
      }),
    });
    const context = await fetchChannelChatContext('signal-helios', deps);
    expect(context.count).toBe(1);
    expect(context.text).not.toContain(longText);
    expect(context.text).toContain('a'.repeat(200));
  });

  it('requests only new messages using since parameter', async () => {
    let capturedSince: number | undefined;
    const deps = makeChannelDeps({
      readChannelMessages: async (limit, since) => {
        capturedSince = since;
        return { messages: [{ id: 5, text: 'New message' }] };
      },
      getLastChannelMessageId: async () => 4,
    });
    const context = await fetchChannelChatContext('signal-helios', deps);
    expect(capturedSince).toBe(4);
    expect(context.maxId).toBe(5);
  });
});
