import { describe, expect, it } from 'bun:test';
import {
  sanitizeDiscordVoiceReply,
  sanitizeDiscordVoiceTranscript,
  shouldHandleVoiceSpeaker,
} from './discord-voice-session-worker.js';

describe('Discord voice session duplex helpers', () => {
  it('normalizes transcripts before they are sent to the LLM', () => {
    expect(sanitizeDiscordVoiceTranscript('  hello\n\nthere   voice  ')).toBe('hello there voice');
  });

  it('cleans generated voice replies for spoken playback', () => {
    expect(sanitizeDiscordVoiceReply('Test Avatar:   sure,\nI can hear you.  ', 'Test Avatar'))
      .toBe('sure, I can hear you.');
  });

  it('ignores the bot user and accepts human speakers', () => {
    expect(shouldHandleVoiceSpeaker('bot-1', 'bot-1')).toBe(false);
    expect(shouldHandleVoiceSpeaker('user-1', 'bot-1')).toBe(true);
  });
});
