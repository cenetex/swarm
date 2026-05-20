import { describe, expect, it } from 'bun:test';
import type { SwarmEnvelope } from '@swarm/core';
import {
  buildResponseFromToolLoop,
  executeToolLoop,
  type ToolLoopParams,
} from './tool-loop.js';

describe('tool loop response construction', () => {
  const envelope = {
    avatarId: 'avatar-1',
    platform: 'telegram',
    conversationId: '-100123',
    messageId: '42',
    timestamp: 0,
    sender: { id: 'user-1', isBot: false },
    content: { text: 'make a sticker' },
    metadata: { receivedAt: 0, priority: 'normal', idempotencyKey: 'k' },
  } as SwarmEnvelope;

  it('carries pre-executed first-round tool results into response actions', async () => {
    const preExecutedToolResults: ToolLoopParams['preExecutedToolResults'] = [{
      name: 'generate_sticker',
      result: {
        success: true,
        data: {
          fileId: 'telegram-file-id',
          stickerId: 'sticker-1',
          emoji: '🔥',
        },
        media: { type: 'sticker', url: 'https://cdn.example.com/sticker.webp' },
      },
    }];

    const loopResult = await executeToolLoop({
      messages: [],
      enabledTools: [],
      toolClient: {} as ToolLoopParams['toolClient'],
      toolContext: { avatarId: 'avatar-1', platform: 'telegram' },
      avatarId: 'avatar-1',
      avatarName: 'Sticker Bot',
      llmConfig: {
        provider: 'openrouter',
        model: 'test-model',
        temperature: 0,
        maxTokens: 100,
      },
      secrets: {},
      envelope,
      brainService: {} as ToolLoopParams['brainService'],
      preExecutedToolResults,
      startIteration: 5,
    });

    expect(loopResult.allToolResults).toEqual(preExecutedToolResults);

    const { response } = buildResponseFromToolLoop(envelope, loopResult, 'test-model');
    expect(response.actions).toEqual([
      {
        type: 'send_sticker',
        emoji: '🔥',
        stickerId: 'telegram-file-id',
      },
    ]);
  });
});
