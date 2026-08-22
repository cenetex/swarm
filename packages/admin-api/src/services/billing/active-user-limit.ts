import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@swarm/core';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

export interface ActiveUserLimitDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  now: () => number;
  maxRetries: number;
}

function getDefaultDeps(): ActiveUserLimitDeps {
  return {
    dynamoClient,
    tableName: ADMIN_TABLE,
    now: () => Date.now(),
    maxRetries: 5,
  };
}

export type ActiveUserSlot = {
  accountId: string;
  walletAddress: string;
  lastSeenAt: number;
};

export type ActiveUserSlotsRecord = {
  pk: 'ACTIVE_USERS';
  sk: 'SLOTS';
  version: number;
  updatedAt: number;
  slots: ActiveUserSlot[];
};

const SLOTS_KEY = { pk: 'ACTIVE_USERS', sk: 'SLOTS' } as const;

export function getActiveUserLimitFromEnv(): number | null {
  const raw = process.env.SWARM_ACTIVE_USER_LIMIT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function getSlotsRecord(deps: ActiveUserLimitDeps): Promise<ActiveUserSlotsRecord | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: SLOTS_KEY,
    })
  );

  return (result.Item as ActiveUserSlotsRecord | undefined) ?? null;
}

function normalizeSlots(slots: ActiveUserSlot[], limit: number): ActiveUserSlot[] {
  const byAccount = new Map<string, ActiveUserSlot>();
  for (const slot of slots) {
    if (!slot?.accountId) continue;
    byAccount.set(slot.accountId, slot);
  }

  return Array.from(byAccount.values())
    .sort((a, b) => {
      const d = b.lastSeenAt - a.lastSeenAt;
      if (d !== 0) return d;
      return a.accountId.localeCompare(b.accountId);
    })
    .slice(0, limit);
}

export async function upsertActiveUserSlotOnLogin(
  params: { accountId: string; walletAddress: string; isOrbHolder?: boolean },
  deps: ActiveUserLimitDeps = getDefaultDeps()
): Promise<{ allowed: boolean; limit: number; record: ActiveUserSlotsRecord | null }> {
  const limit = getActiveUserLimitFromEnv();
  if (!limit) {
    return { allowed: true, limit: 0, record: null };
  }

  // Orb holders do not count toward the active-user limit.
  if (params.isOrbHolder) {
    return { allowed: true, limit, record: null };
  }

  const now = deps.now();

  for (let attempt = 0; attempt < deps.maxRetries; attempt += 1) {
    const existing = await getSlotsRecord(deps);

    if (!existing) {
      try {
        const record: ActiveUserSlotsRecord = {
          ...SLOTS_KEY,
          version: 1,
          updatedAt: now,
          slots: normalizeSlots(
            [{ accountId: params.accountId, walletAddress: params.walletAddress, lastSeenAt: now }],
            limit
          ),
        };

        await deps.dynamoClient.send(
          new PutCommand({
            TableName: deps.tableName,
            Item: record,
            ConditionExpression: 'attribute_not_exists(pk)',
          })
        );

        const allowed = record.slots.some((s) => s.accountId === params.accountId);
        return { allowed, limit, record };
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          continue;
        }
        throw err;
      }
    }

    const expectedVersion = typeof existing.version === 'number' ? existing.version : 0;
    const updatedSlots = normalizeSlots(
      [
        ...existing.slots,
        { accountId: params.accountId, walletAddress: params.walletAddress, lastSeenAt: now },
      ],
      limit
    );

    const nextVersion = expectedVersion + 1;

    try {
      await deps.dynamoClient.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: SLOTS_KEY,
          UpdateExpression: 'SET #version = :v, updatedAt = :now, slots = :slots',
          ConditionExpression: 'attribute_not_exists(#version) OR #version = :expected',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':v': nextVersion,
            ':expected': expectedVersion,
            ':now': now,
            ':slots': updatedSlots,
          },
        })
      );

      const record: ActiveUserSlotsRecord = {
        ...SLOTS_KEY,
        version: nextVersion,
        updatedAt: now,
        slots: updatedSlots,
      };

      const allowed = record.slots.some((s) => s.accountId === params.accountId);
      return { allowed, limit, record };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        continue;
      }
      throw err;
    }
  }

  // Fail open if we can’t converge on a write.
  return { allowed: true, limit, record: null };
}

export async function checkActiveUserAccess(
  params: { accountId: string; isAdmin: boolean; isOrbHolder?: boolean },
  deps: ActiveUserLimitDeps = getDefaultDeps()
): Promise<{ allowed: boolean; limit: number; cutoffLastSeenAt?: number; slotsCount?: number }> {
  const limit = getActiveUserLimitFromEnv();
  if (!limit) return { allowed: true, limit: 0 };
  if (params.isAdmin) return { allowed: true, limit };
  if (params.isOrbHolder) return { allowed: true, limit };

  const record = await getSlotsRecord(deps);
  if (!record) return { allowed: true, limit };

  const slots = Array.isArray(record.slots) ? record.slots : [];
  if (slots.length < limit) {
    return { allowed: true, limit, slotsCount: slots.length };
  }

  const allowed = slots.some((s) => s.accountId === params.accountId);
  const cutoffLastSeenAt = slots.length ? slots[slots.length - 1]?.lastSeenAt : undefined;

  return { allowed, limit, cutoffLastSeenAt, slotsCount: slots.length };
}
