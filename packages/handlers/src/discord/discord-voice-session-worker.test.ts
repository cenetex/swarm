import { describe, expect, it } from 'bun:test';
import {
  isDiscordVoiceBargeInEnabled,
  sanitizeDiscordVoiceReply,
  sanitizeDiscordVoiceTranscript,
  shouldHandleVoiceSpeaker,
  shouldStartVoiceTurn,
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

  it('parses barge-in as enabled by default and disabled only by explicit false values', () => {
    expect(isDiscordVoiceBargeInEnabled(undefined)).toBe(true);
    expect(isDiscordVoiceBargeInEnabled('')).toBe(true);
    expect(isDiscordVoiceBargeInEnabled('true')).toBe(true);
    expect(isDiscordVoiceBargeInEnabled('off')).toBe(false);
    expect(isDiscordVoiceBargeInEnabled('false')).toBe(false);
    expect(isDiscordVoiceBargeInEnabled('0')).toBe(false);
  });

  it('allows human speech to start during playback only when barge-in is enabled', () => {
    expect(shouldStartVoiceTurn({
      userId: 'user-1',
      botUserId: 'bot-1',
      stopped: false,
      isPlaying: true,
      bargeInEnabled: true,
      isActiveSpeaker: false,
    })).toBe(true);

    expect(shouldStartVoiceTurn({
      userId: 'user-1',
      botUserId: 'bot-1',
      stopped: false,
      isPlaying: true,
      bargeInEnabled: false,
      isActiveSpeaker: false,
    })).toBe(false);
  });

  it('does not start stopped, duplicate, or self voice turns', () => {
    expect(shouldStartVoiceTurn({
      userId: 'user-1',
      botUserId: 'bot-1',
      stopped: true,
      isPlaying: false,
      bargeInEnabled: true,
      isActiveSpeaker: false,
    })).toBe(false);

    expect(shouldStartVoiceTurn({
      userId: 'user-1',
      botUserId: 'bot-1',
      stopped: false,
      isPlaying: false,
      bargeInEnabled: true,
      isActiveSpeaker: true,
    })).toBe(false);

    expect(shouldStartVoiceTurn({
      userId: 'bot-1',
      botUserId: 'bot-1',
      stopped: false,
      isPlaying: false,
      bargeInEnabled: true,
      isActiveSpeaker: false,
    })).toBe(false);
  });
});
