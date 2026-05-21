import { describe, expect, it } from 'bun:test';
import { reserveResponseInChannelHistory } from './response-history.js';
import type { ContextMessage, SwarmEnvelope, SwarmResponse } from '@swarm/core';

describe('reserveResponseInChannelHistory', () => {
  it('can reserve bot replies in both avatar channel history and shared-room history', async () => {
    const channelWrites: ContextMessage[] = [];
    const sharedWrites: Array<{ roomId: string; message: Record<string, unknown> }> = [];
    const claims: Array<{ roomId: string; messageId: string }> = [];

    const envelope = {
      avatarId: 'phantom',
      platform: 'telegram',
      conversationId: '-1001',
      messageId: 'm1',
      timestamp: 1000,
      sender: { id: 'user-1', isBot: false },
      content: { text: '@phantom_bot hello' },
      metadata: {
        receivedAt: 1000,
        priority: 'high',
        idempotencyKey: 'idem-1',
        chatType: 'supergroup',
      },
    } as SwarmEnvelope;

    const response = {
      avatarId: 'phantom',
      platform: 'telegram',
      conversationId: '-1001',
      replyToMessageId: 'm1',
      actions: [{ type: 'send_message', text: 'Eliza, take a look.' }],
      generatedAt: 2000,
      llmModel: 'test-model',
      tokensUsed: 10,
    } as SwarmResponse;

    const messageId = await reserveResponseInChannelHistory({
      stateService: {
        addMessageToChannel: async (_avatarId, _channelId, _platform, message) => {
          channelWrites.push(message);
        },
      },
      envelope,
      response,
      avatarName: 'Continuum Phantom',
      sharedRoom: {
        roomId: '-1001',
        claimMessage: async (roomId, claimedMessageId) => {
          claims.push({ roomId, messageId: claimedMessageId });
          return true;
        },
        appendMessage: async (roomId, message) => {
          sharedWrites.push({ roomId, message });
        },
      },
    });

    expect(messageId).toBe(response.contextMessageId);
    expect(channelWrites[0]).toMatchObject({
      messageId,
      sender: 'Continuum Phantom',
      isBot: true,
      content: 'Eliza, take a look.',
      timestamp: 2000,
      replyToMessageId: 'm1',
    });
    expect(claims).toEqual([{ roomId: '-1001', messageId }]);
    expect(sharedWrites).toEqual([
      {
        roomId: '-1001',
        message: {
          messageId,
          senderId: 'phantom',
          senderType: 'avatar',
          platform: 'telegram',
          content: 'Eliza, take a look.',
          timestamp: 2000,
        },
      },
    ]);
  });

  it('does not append duplicate shared-room reservations when the claim is already held', async () => {
    const sharedWrites: Array<{ roomId: string; message: Record<string, unknown> }> = [];
    const response = {
      avatarId: 'phantom',
      platform: 'telegram',
      conversationId: '-1001',
      replyToMessageId: 'm1',
      actions: [{ type: 'send_message', text: 'already reserved' }],
      generatedAt: 2000,
      llmModel: 'test-model',
      tokensUsed: 10,
    } as SwarmResponse;

    const messageId = await reserveResponseInChannelHistory({
      stateService: {
        addMessageToChannel: async () => {},
      },
      envelope: {
        avatarId: 'phantom',
        platform: 'telegram',
        conversationId: '-1001',
        messageId: 'm1',
        timestamp: 1000,
        sender: { id: 'user-1', isBot: false },
        content: { text: 'hello' },
        metadata: { receivedAt: 1000, priority: 'normal', idempotencyKey: 'idem-1' },
      } as SwarmEnvelope,
      response,
      avatarName: 'Continuum Phantom',
      sharedRoom: {
        roomId: '-1001',
        claimMessage: async () => false,
        appendMessage: async (roomId, message) => {
          sharedWrites.push({ roomId, message });
        },
      },
    });

    expect(messageId).toBe(response.contextMessageId);
    expect(sharedWrites).toEqual([]);
  });
});
