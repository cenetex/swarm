import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from '@swarm/core';
import type { AdminChatMessage, UserSession } from '../types.js';

export interface ChatHistoryRecord {
  pk: string;
  sk: string;
  messages: AdminChatMessage[];
  updatedAt: number;
  ttl?: number;
}

export interface ChatHistoryStoreDeps {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  now?: () => number;
  maxMessages?: number;
  ttlSeconds?: number;
}

function buildChatKey(email: string): string {
  return `CHAT#${email}`;
}

function buildAvatarKey(avatarId?: string): string {
  return avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
}

export function createChatHistoryStore(deps: ChatHistoryStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const maxMessages = deps.maxMessages ?? 100;
  const ttlSeconds = deps.ttlSeconds ?? 0;

  const getChatHistory = async (session: UserSession, avatarId?: string): Promise<AdminChatMessage[]> => {
    const result = await deps.dynamoClient.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: {
          pk: buildChatKey(session.email),
          sk: buildAvatarKey(avatarId),
        },
      })
    ) as { Item?: ChatHistoryRecord };

    if (!result.Item) return [];

    const record = result.Item as ChatHistoryRecord;
    if (record.ttl && record.ttl <= Math.floor(now() / 1000)) {
      return [];
    }

    if (ttlSeconds > 0) {
      const nextTtl = Math.floor(now() / 1000) + ttlSeconds;
      await deps.dynamoClient.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: {
            pk: record.pk,
            sk: record.sk,
          },
          UpdateExpression: 'SET #ttl = :ttl, updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': nextTtl, ':updatedAt': now() },
        })
      );
    }

    return record.messages || [];
  };

  const saveChatHistory = async (session: UserSession, messages: AdminChatMessage[], avatarId?: string): Promise<void> => {
    const trimmedMessages = messages.slice(-maxMessages);
    const record: ChatHistoryRecord = {
      pk: buildChatKey(session.email),
      sk: buildAvatarKey(avatarId),
      messages: trimmedMessages,
      updatedAt: now(),
      ...(ttlSeconds > 0 ? { ttl: Math.floor(now() / 1000) + ttlSeconds } : {}),
    };

    await deps.dynamoClient.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: record,
      })
    );
  };

  const clearChatHistory = async (session: UserSession, avatarId?: string): Promise<void> => {
    await deps.dynamoClient.send(
      new DeleteCommand({
        TableName: deps.tableName,
        Key: {
          pk: buildChatKey(session.email),
          sk: buildAvatarKey(avatarId),
        },
      })
    );
  };

  return { getChatHistory, saveChatHistory, clearChatHistory };
}
