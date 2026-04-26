/**
 * Tests for buildVoiceCloneInput — model-aware Replicate input adapter.
 */
import { describe, it, expect } from 'bun:test';
import { buildVoiceCloneInput } from './voice-input.js';

describe('buildVoiceCloneInput', () => {
  const base = {
    text: 'hello there',
    referenceUrl: 'https://example.com/ref.wav',
  };

  it('maps F5-TTS input to gen_text / ref_audio (x-lance fork)', () => {
    const input = buildVoiceCloneInput('x-lance/f5-tts', base);
    expect(input).toEqual({
      gen_text: 'hello there',
      ref_audio: 'https://example.com/ref.wav',
    });
    expect(input).not.toHaveProperty('text');
    expect(input).not.toHaveProperty('speaker');
    expect(input).not.toHaveProperty('language');
  });

  it('maps F5-TTS input across the family (jaaari/f5-tts)', () => {
    const input = buildVoiceCloneInput('jaaari/f5-tts', base);
    expect(input.gen_text).toBe('hello there');
    expect(input.ref_audio).toBe('https://example.com/ref.wav');
  });

  it('includes ref_text on F5-TTS when referenceText is provided', () => {
    const input = buildVoiceCloneInput('x-lance/f5-tts', {
      ...base,
      referenceText: 'this is the reference transcript',
    });
    expect(input.ref_text).toBe('this is the reference transcript');
  });

  it('omits ref_text on F5-TTS when referenceText is absent', () => {
    const input = buildVoiceCloneInput('x-lance/f5-tts', base);
    expect(input).not.toHaveProperty('ref_text');
  });

  it('maps XTTS-v2 legacy input to text / speaker / language', () => {
    const input = buildVoiceCloneInput('lucataco/xtts-v2', base);
    expect(input).toEqual({
      text: 'hello there',
      speaker: 'https://example.com/ref.wav',
      language: 'en',
    });
  });

  it('respects explicit language on the legacy path', () => {
    const input = buildVoiceCloneInput('lucataco/xtts-v2', { ...base, language: 'fr' });
    expect(input.language).toBe('fr');
  });

  it('passes cleanup_voice through on the legacy path only', () => {
    const xtts = buildVoiceCloneInput('lucataco/xtts-v2', { ...base, cleanupVoice: true });
    expect(xtts.cleanup_voice).toBe(true);
    // F5 path ignores it (not in the F5 schema)
    const f5 = buildVoiceCloneInput('x-lance/f5-tts', { ...base, cleanupVoice: true });
    expect(f5).not.toHaveProperty('cleanup_voice');
  });

  it('falls back to XTTS shape for unknown models (back-compat)', () => {
    const input = buildVoiceCloneInput('some/unknown-model', base);
    expect(input).toEqual({
      text: 'hello there',
      speaker: 'https://example.com/ref.wav',
      language: 'en',
    });
  });

  it('is case-insensitive on model name matching', () => {
    const input = buildVoiceCloneInput('X-Lance/F5-TTS', base);
    expect(input).toHaveProperty('gen_text');
    expect(input).toHaveProperty('ref_audio');
  });
});
