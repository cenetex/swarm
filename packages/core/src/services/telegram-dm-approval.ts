/**
 * Telegram DM Approval Store (#1473)
 *
 * Third step of the Telegram-native redesign (#1470). Replaces the typed-in
 * `allowedDmUsers` list with owner-side inline-keyboard approval: when a
 * stranger DMs the bot, the bot DMs the owner with `[Allow] [Deny] [Block]`.
 * The owner's tap is the authorization. The requester sees a holding
 * message until the owner acts.
 *
 * Key schema (in ADMIN_TABLE):
 *   - Pending approval (one per (avatar, requester)):
 *       pk: AVATAR#{avatarId}
 *       sk: TELEGRAM_DM_PENDING#{requesterId}
 *       attrs: { holdingMessageId, ownerMessageId, requesterUsername,
 *                requesterDisplayName, firstMessage, issuedAt, ttl }
 *
 *   - Hard blocklist (no TTL — persistent ban):
 *       pk: AVATAR#{avatarId}
 *       sk: TELEGRAM_BLOCKED#{requesterId}
 *       attrs: { requesterUsername?, blockedAt }
 *
 * TTL: 24h on pending records — abandoned flows are garbage-collected so
 * the requester can try again without the owner being spammed.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

export interface PendingDmRecord {
  pk: string;
  sk: string;
  avatarId: string;
  requesterId: string;
  requesterUsername?: string;
  requesterDisplayName?: string;
  holdingMessageId: number;
  ownerMessageId: number;
  firstMessage: string;
  issuedAt: number;
  ttl: number;
}

export interface BlockedRecord {
  pk: string;
  sk: string;
  avatarId: string;
  requesterId: string;
  requesterUsername?: string;
  blockedAt: number;
}

export interface TelegramDmApprovalStoreDeps {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  now?: () => number;
  pendingTtlSeconds?: number;
}

const DEFAULT_PENDING_TTL_SECONDS = 24 * 60 * 60;
const MAX_FIRST_MESSAGE_CHARS = 280;

export function createTelegramDmApprovalStore(deps: TelegramDmApprovalStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const ttlSeconds = deps.pendingTtlSeconds ?? DEFAULT_PENDING_TTL_SECONDS;
  const table = deps.tableName;

  async function createPendingDm(params: {
    avatarId: string;
    requesterId: string;
    requesterUsername?: string;
    requesterDisplayName?: string;
    holdingMessageId: number;
    ownerMessageId: number;
    firstMessage: string;
  }): Promise<PendingDmRecord> {
    const issuedAt = now();
    const record: PendingDmRecord = {
      pk: `AVATAR#${params.avatarId}`,
      sk: `TELEGRAM_DM_PENDING#${params.requesterId}`,
      avatarId: params.avatarId,
      requesterId: params.requesterId,
      requesterUsername: params.requesterUsername,
      requesterDisplayName: params.requesterDisplayName,
      holdingMessageId: params.holdingMessageId,
      ownerMessageId: params.ownerMessageId,
      firstMessage: params.firstMessage.slice(0, MAX_FIRST_MESSAGE_CHARS),
      issuedAt,
      ttl: Math.floor(issuedAt / 1000) + ttlSeconds,
    };
    await deps.dynamoClient.send(new PutCommand({
      TableName: table,
      Item: record,
    }));
    return record;
  }

  async function getPendingDm(avatarId: string, requesterId: string): Promise<PendingDmRecord | null> {
    if (!avatarId || !requesterId) return null;
    const result = await deps.dynamoClient.send(new GetCommand({
      TableName: table,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `TELEGRAM_DM_PENDING#${requesterId}`,
      },
    }));
    const record = result.Item as PendingDmRecord | undefined;
    if (!record) return null;
    // Client-side TTL check (DynamoDB TTL sweep can lag 48h).
    if (record.ttl && record.ttl <= Math.floor(now() / 1000)) return null;
    return record;
  }

  async function deletePendingDm(avatarId: string, requesterId: string): Promise<void> {
    if (!avatarId || !requesterId) return;
    await deps.dynamoClient.send(new DeleteCommand({
      TableName: table,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `TELEGRAM_DM_PENDING#${requesterId}`,
      },
    }));
  }

  /** List all live pending approvals for an avatar, for the dashboard view. */
  async function listPending(avatarId: string, limit = 50): Promise<PendingDmRecord[]> {
    if (!avatarId) return [];
    const result = await deps.dynamoClient.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'TELEGRAM_DM_PENDING#',
      },
      Limit: limit,
    }));
    const records = (result.Items ?? []) as PendingDmRecord[];
    const cutoff = Math.floor(now() / 1000);
    return records.filter(r => !r.ttl || r.ttl > cutoff);
  }

  async function addBlocked(params: {
    avatarId: string;
    requesterId: string;
    requesterUsername?: string;
  }): Promise<void> {
    await deps.dynamoClient.send(new PutCommand({
      TableName: table,
      Item: {
        pk: `AVATAR#${params.avatarId}`,
        sk: `TELEGRAM_BLOCKED#${params.requesterId}`,
        avatarId: params.avatarId,
        requesterId: params.requesterId,
        requesterUsername: params.requesterUsername,
        blockedAt: now(),
      } satisfies BlockedRecord,
    }));
  }

  async function isBlocked(avatarId: string, requesterId: string): Promise<boolean> {
    if (!avatarId || !requesterId) return false;
    const result = await deps.dynamoClient.send(new GetCommand({
      TableName: table,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `TELEGRAM_BLOCKED#${requesterId}`,
      },
    }));
    return Boolean(result.Item);
  }

  async function removeBlocked(avatarId: string, requesterId: string): Promise<void> {
    if (!avatarId || !requesterId) return;
    await deps.dynamoClient.send(new DeleteCommand({
      TableName: table,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `TELEGRAM_BLOCKED#${requesterId}`,
      },
    }));
  }

  return {
    createPendingDm,
    getPendingDm,
    deletePendingDm,
    listPending,
    addBlocked,
    isBlocked,
    removeBlocked,
  };
}

export type TelegramDmApprovalStore = ReturnType<typeof createTelegramDmApprovalStore>;

/** Truncation constant exposed for callers that want to clamp before persistence. */
export { MAX_FIRST_MESSAGE_CHARS };
