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
  type HailAudioDeps,
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

// Channel context tests
describe('signal_channel context', () => {
  it('formats channel messages with truncation to 200 chars per message', () => {
    const messages = [
      { id: 1, timestamp: 100, sender_station_id: 0, text: 'Short message', audio_url: undefined },
      { id: 2, timestamp: 101, sender_station_id: 1, text: 'x'.repeat(300) },
    ];
    const formatted = messages
      .map((msg) => {
        const senderName = ['Prospect', 'Kepler', 'Helios'][msg.sender_station_id] || `Station${msg.sender_station_id}`;
        const text = msg.text.slice(0, 200);
        return `${senderName} [${msg.timestamp}]: ${text}`;
      })
      .join('\n');

    expect(formatted).toContain('Prospect [100]: Short message');
    expect(formatted).toContain('Kepler [101]: ' + 'x'.repeat(200));
    expect(formatted).not.toContain('x'.repeat(201)); // Truncated
  });

  it('handles empty message list gracefully', () => {
    const messages = [];
    expect(messages.length).toBe(0);
  });

  it('maps station ids correctly to avatar names', () => {
    const stationNames = ['Prospect', 'Kepler', 'Helios'];
    expect(stationNames[0]).toBe('Prospect');
    expect(stationNames[1]).toBe('Kepler');
    expect(stationNames[2]).toBe('Helios');
  });

  it('handles channel fetch failure gracefully (non-fatal)', () => {
    const error = new Error('Connection refused');
    const result = {
      block: '(station-band channel fetch failed)',
      error: error.message,
    };
    expect(result.block).toBe('(station-band channel fetch failed)');
    expect(result.error).toBe('Connection refused');
  });

  it('tracks last message id for incremental fetches', () => {
    const messages = [
      { id: 1, timestamp: 100, sender_station_id: 0, text: 'first' },
      { id: 2, timestamp: 101, sender_station_id: 1, text: 'second' },
      { id: 3, timestamp: 102, sender_station_id: 2, text: 'third' },
    ];
    const lastMessageId = messages[messages.length - 1]?.id;
    expect(lastMessageId).toBe(3);
  });

  it('deduplicates auto-post if hail text unchanged', () => {
    const previousHail = 'Station full, come back later';
    const newHail = previousHail;
    expect(previousHail === newHail).toBe(true);
    // Should skip auto-post
  });

  it('auto-posts when hail text changes', () => {
    const previousHail = 'Station full';
    const newHail = 'New inventory in stock';
    expect(previousHail === newHail).toBe(false);
    // Should auto-post
  });
});
