import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from '@swarm/core';
import type {
  SharedRoomState,
  SharedRoomMessage,
  AvatarRoomOverlay,
} from '../types/shared-room.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const SECONDS_PER_DAY = 86400;
/** Messages expire after 7 days. */
export const MESSAGE_TTL_DAYS = 7;
/** Overlays expire after 30 days. */
export const OVERLAY_TTL_DAYS = 30;
/** Default number of recent messages to return. */
const DEFAULT_MESSAGE_LIMIT = 50;

// =============================================================================
// DI — module-level DynamoDB client (test-injectable)
// =============================================================================

let _client: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

/** Test hook: inject a mock DynamoDB document client. */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _client = client;
}

function getTableName(): string {
  return process.env.SHARED_ROOM_TABLE || process.env.ADMIN_TABLE || '';
}

// =============================================================================
// TTL HELPERS
// =============================================================================

function computeTtl(retentionDays: number): number {
  return Math.floor(Date.now() / 1000) + retentionDays * SECONDS_PER_DAY;
}

// =============================================================================
// KEY HELPERS
// =============================================================================

function roomPk(roomId: string): string {
  return `ROOM#${roomId}`;
}

function messageSk(timestamp: number, messageId: string): string {
  // Zero-pad timestamp to 15 digits for correct lexicographic sort
  return `MSG#${String(timestamp).padStart(15, '0')}#${messageId}`;
}

function dedupSk(messageId: string): string {
  return `DEDUP#${messageId}`;
}

function overlaySk(avatarId: string): string {
  return `OVERLAY#${avatarId}`;
}

const META_SK = 'META';

// =============================================================================
// SERVICE FUNCTIONS
// =============================================================================

/**
 * Atomically claim a room message before appending/enqueueing it.
 *
 * Discord can deliver the same guild message to every bot connection in a
 * shared room. A read-before-write recent-message check races under that
 * fanout, so this conditional put is the cross-connection idempotency gate.
 */
export async function claimRoomMessage(
  roomId: string,
  messageId: string,
  tableName?: string,
): Promise<boolean> {
  const client = getDynamoClient();
  const table = tableName || getTableName();

  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: roomPk(roomId),
          sk: dedupSk(messageId),
          roomId,
          messageId,
          createdAt: Date.now(),
          ttl: computeTtl(MESSAGE_TTL_DAYS),
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

/**
 * Append a message to the shared room ledger.
 * Also initialises the room META record if it does not yet exist.
 */
export async function appendMessage(
  roomId: string,
  message: Omit<SharedRoomMessage, 'roomId'>,
  tableName?: string,
): Promise<void> {
  const client = getDynamoClient();
  const table = tableName || getTableName();
  const pk = roomPk(roomId);

  // Write message item
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk,
        sk: messageSk(message.timestamp, message.messageId),
        roomId,
        ...message,
        ttl: computeTtl(MESSAGE_TTL_DAYS),
      },
    }),
  );

  // Upsert META — increment messageCount, set createdAt on first write
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk, sk: META_SK },
      UpdateExpression:
        'SET roomId = :roomId, platform = :platform, createdAt = if_not_exists(createdAt, :now) ADD messageCount :one',
      ExpressionAttributeValues: {
        ':roomId': roomId,
        ':platform': message.platform,
        ':now': message.timestamp,
        ':one': 1,
      },
    }),
  );
}

/**
 * Query the last N messages from a room, returned in chronological order
 * (oldest first).
 */
export async function getRecentMessages(
  roomId: string,
  limit: number = DEFAULT_MESSAGE_LIMIT,
  tableName?: string,
): Promise<SharedRoomMessage[]> {
  const client = getDynamoClient();
  const table = tableName || getTableName();
  const pk = roomPk(roomId);

  const result = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':prefix': 'MSG#',
      },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );

  const messages = (result.Items ?? []).map((item) => ({
    roomId: item.roomId as string,
    timestamp: item.timestamp as number,
    senderId: item.senderId as string,
    senderType: item.senderType as SharedRoomMessage['senderType'],
    platform: item.platform as SharedRoomMessage['platform'],
    content: item.content as string,
    messageId: item.messageId as string,
  }));

  // Return in chronological order (oldest first)
  return messages.reverse();
}

/**
 * Update (or create) the per-avatar overlay for a room.
 */
export async function updateOverlay(
  roomId: string,
  avatarId: string,
  overlay: Partial<Omit<AvatarRoomOverlay, 'avatarId' | 'roomId'>>,
  tableName?: string,
): Promise<void> {
  const client = getDynamoClient();
  const table = tableName || getTableName();
  const pk = roomPk(roomId);

  // Build update expression dynamically from provided fields
  const expressionParts: string[] = [];
  const attrValues: Record<string, unknown> = {};

  // Always set identity fields and TTL
  expressionParts.push('avatarId = :avatarId');
  attrValues[':avatarId'] = avatarId;
  expressionParts.push('roomId = :roomId');
  attrValues[':roomId'] = roomId;
  expressionParts.push('ttl = :ttl');
  attrValues[':ttl'] = computeTtl(OVERLAY_TTL_DAYS);

  const fieldMap: Record<string, unknown> = { ...overlay };
  for (const [key, value] of Object.entries(fieldMap)) {
    if (value !== undefined) {
      expressionParts.push(`${key} = :${key}`);
      attrValues[`:${key}`] = value;
    }
  }

  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk, sk: overlaySk(avatarId) },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeValues: attrValues,
    }),
  );
}

/**
 * Read the per-avatar overlay for a room. Returns null if not found.
 */
export async function getOverlay(
  roomId: string,
  avatarId: string,
  tableName?: string,
): Promise<AvatarRoomOverlay | null> {
  const client = getDynamoClient();
  const table = tableName || getTableName();
  const pk = roomPk(roomId);

  const result = await client.send(
    new GetCommand({
      TableName: table,
      Key: { pk, sk: overlaySk(avatarId) },
    }),
  );

  if (!result.Item) return null;

  return {
    avatarId: result.Item.avatarId as string,
    roomId: result.Item.roomId as string,
    lastParticipatedAt: result.Item.lastParticipatedAt as number,
    messagesSinceLastReply: result.Item.messagesSinceLastReply as number,
    cooldownUntil: result.Item.cooldownUntil as number | undefined,
    threadHints: result.Item.threadHints as string[] | undefined,
    affinityScore: result.Item.affinityScore as number | undefined,
  };
}

/**
 * Read room metadata. Returns null if the room has never been written to.
 */
export async function getRoomState(
  roomId: string,
  tableName?: string,
): Promise<SharedRoomState | null> {
  const client = getDynamoClient();
  const table = tableName || getTableName();
  const pk = roomPk(roomId);

  const result = await client.send(
    new GetCommand({
      TableName: table,
      Key: { pk, sk: META_SK },
    }),
  );

  if (!result.Item) return null;

  return {
    roomId: result.Item.roomId as string,
    platform: result.Item.platform as SharedRoomState['platform'],
    createdAt: result.Item.createdAt as number,
    messageCount: result.Item.messageCount as number,
  };
}
