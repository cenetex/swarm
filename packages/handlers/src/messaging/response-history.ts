import { createHash } from 'crypto';
import type {
  ContextMessage,
  Platform,
  SwarmEnvelope,
  SwarmResponse,
} from '@swarm/core';
import {
  appendMessage as appendSharedRoomMessage,
  claimRoomMessage as claimSharedRoomMessage,
  type SharedRoomMessage,
} from '@swarm/core';

type ChannelHistoryWriter = {
  addMessageToChannel(
    avatarId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages?: number,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string,
  ): Promise<unknown>;
};

export function buildReservedResponseMessageId(
  envelope: Pick<SwarmEnvelope, 'avatarId' | 'platform' | 'conversationId' | 'messageId'>,
): string {
  const hash = createHash('sha256')
    .update([envelope.avatarId, envelope.platform, envelope.conversationId, envelope.messageId].join('\0'))
    .digest('hex')
    .slice(0, 24);
  return `bot_pending_${hash}`;
}

export function extractResponseTextForContext(
  response: Pick<SwarmResponse, 'actions'>,
): string | undefined {
  const chunks: string[] = [];

  for (const action of response.actions) {
    if (action.type !== 'send_message') continue;
    const text = action.text.trim();
    if (text) chunks.push(text);
  }

  return chunks.length > 0 ? chunks.join('\n\n') : undefined;
}

export function shouldRecordSentTextInChannelHistory(
  response: Pick<SwarmResponse, 'contextMessageId'>,
): boolean {
  return !response.contextMessageId;
}

export async function reserveResponseInChannelHistory(params: {
  stateService: ChannelHistoryWriter;
  envelope: SwarmEnvelope;
  response: SwarmResponse;
  avatarName: string;
  sharedRoom?: {
    roomId: string;
    claimMessage?: (roomId: string, messageId: string) => Promise<boolean>;
    appendMessage?: (
      roomId: string,
      message: Omit<SharedRoomMessage, 'roomId'>,
    ) => Promise<void>;
  };
}): Promise<string | undefined> {
  const content = extractResponseTextForContext(params.response);
  if (!content) return undefined;

  const messageId = params.response.contextMessageId
    ?? buildReservedResponseMessageId(params.envelope);
  const timestamp = params.response.generatedAt || Date.now();

  await params.stateService.addMessageToChannel(
    params.response.avatarId,
    params.response.conversationId,
    params.response.platform,
    {
      messageId,
      sender: params.avatarName,
      isBot: true,
      content,
      timestamp,
      replyToMessageId: params.response.replyToMessageId,
    },
    undefined,
    params.envelope.metadata.chatType,
    params.envelope.metadata.chatTitle,
  );

  if (params.sharedRoom) {
    const claimMessage = params.sharedRoom.claimMessage
      ?? (params.sharedRoom.appendMessage ? undefined : claimSharedRoomMessage);
    if (claimMessage) {
      const claimed = await claimMessage(params.sharedRoom.roomId, messageId);
      if (!claimed) {
        params.response.contextMessageId = messageId;
        return messageId;
      }
    }

    const appendMessage = params.sharedRoom.appendMessage ?? appendSharedRoomMessage;
    await appendMessage(params.sharedRoom.roomId, {
      messageId,
      senderId: params.response.avatarId,
      senderType: 'avatar',
      platform: params.response.platform,
      content,
      timestamp,
    });
  }

  params.response.contextMessageId = messageId;
  return messageId;
}
