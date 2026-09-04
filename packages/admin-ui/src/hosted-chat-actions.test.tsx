import { describe, expect, it } from 'vitest';
import { cleanHostedReply, hostedActionForMessage } from './hosted-chat-actions';

describe('hosted chat actions', () => {
  it.each([
    ['/new', 'create'],
    [' Connect Telegram! ', 'telegram'],
    ['/profile', 'profile'],
    ['connect x', 'x'],
    ['connect openrouter', 'model'],
    ['/share', 'share'],
    ['my account', 'account'],
    ['/help', 'help'],
  ])('routes %s to its chat card', (message, action) => {
    expect(hostedActionForMessage(message)).toBe(action);
  });

  it('keeps ordinary conversation with the model', () => {
    expect(hostedActionForMessage('Can you explain how to connect Telegram to my website?')).toBeNull();
    expect(hostedActionForMessage('Share your thoughts')).toBeNull();
  });

  it.each(['think', 'thinking', 'thought', 'analysis'])('keeps only the answer outside %s tags', (tag) => {
    expect(cleanHostedReply(`<${tag}>private reasoning</${tag}>Hello.`)).toBe('Hello.');
    expect(cleanHostedReply(`<${tag}>unfinished reasoning`)).toBe('');
  });

  it('preserves normal answer text', () => {
    expect(cleanHostedReply('Here is a thoughtful answer.')).toBe('Here is a thoughtful answer.');
  });

  it('handles partial provider tags', () => {
    expect(cleanHostedReply('<thinking unfinished reasoning')).toBe('');
    expect(cleanHostedReply('<analysis mode="private">reasoning</analysis>Answer.')).toBe('Answer.');
  });
});
