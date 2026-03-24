/**
 * Pending Tool Store
 *
 * Persists pending tool calls (pause-for-input) in DynamoDB so that
 * resumeChatAfterToolResult can validate that a real tool call was issued,
 * independent of chat history TTL or message sanitization.
 *
 * Key schema (in ADMIN_TABLE):
 *   pk: PENDING_TOOL#{email}
 *   sk: AVATAR#{avatarId}
 *
 * Only one pending tool per user/avatar at a time (latest wins).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

export interface PendingToolRecord {
  pk: string;
  sk: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  ttl: number;
}

export interface PendingToolStoreDeps {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  ttlSeconds?: number;
}

function buildKey(email: string, avatarId: string) {
  // Normalize inputs to prevent whitespace-related mismatches
  const normalizedEmail = (email || '').trim();
  const normalizedAvatarId = (avatarId || '').trim();
  return {
    pk: `PENDING_TOOL#${normalizedEmail}`,
    sk: `AVATAR#${normalizedAvatarId}`,
  };
}

/** Default TTL: 7 days (generous — tool submissions happen within minutes). */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createPendingToolStore(deps: PendingToolStoreDeps) {
  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const save = async (params: {
    email: string;
    avatarId: string;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<void> => {
    const now = Date.now();
    const key = buildKey(params.email, params.avatarId);
    await deps.dynamoClient.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...key,
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          arguments: params.arguments,
          createdAt: now,
          ttl: Math.floor(now / 1000) + ttlSeconds,
        },
      })
    );
  };

  const get = async (email: string, avatarId: string): Promise<PendingToolRecord | null> => {
    const key = buildKey(email, avatarId);
    const result = await deps.dynamoClient.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: key,
      })
    );
    if (!result.Item) return null;
    const record = result.Item as PendingToolRecord;
    // Check client-side TTL (DynamoDB TTL can lag)
    if (record.ttl && record.ttl <= Math.floor(Date.now() / 1000)) return null;
    return record;
  };

  const remove = async (email: string, avatarId: string): Promise<void> => {
    const key = buildKey(email, avatarId);
    await deps.dynamoClient.send(
      new DeleteCommand({
        TableName: deps.tableName,
        Key: key,
      })
    );
  };

  return { save, get, remove };
}
