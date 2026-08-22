import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@swarm/core';
import { getGateStatus } from './nft-gate.js';
import type { AvatarRecord } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { logger } from '@swarm/core';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';

const ddb = getDynamoClient();

const ORB_SLOT_SK = 'SLOT';

function orbSlotKey(mintAddress: string) {
  return { pk: `ORB#${mintAddress}`, sk: ORB_SLOT_SK };
}

function walletOrbKey(walletAddress: string, mintAddress: string) {
  return { pk: `WALLET#${walletAddress}`, sk: `ORB#${mintAddress}` };
}

export interface OrbSlotRecord {
  pk: string;
  sk: string;
  mintAddress: string;
  walletAddress: string;
  avatarId: string;
  slottedAt: number;
  updatedAt: number;
  resonance: number;
  resonanceUpdatedAt: number;
}

export interface OrbSlotsDeps {
  ddb?: Pick<typeof ddb, 'send'>;
  tableName?: string;
  now?: () => number;
  getGateStatus?: typeof getGateStatus;
}

export async function getOrbSlot(mintAddress: string, deps?: OrbSlotsDeps): Promise<OrbSlotRecord | null> {
  const resolvedDdb = deps?.ddb ?? ddb;
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;

  const existing = await resolvedDdb.send(
    new GetCommand({
      TableName: resolvedTableName,
      Key: orbSlotKey(mintAddress),
    })
  );

  return (existing.Item as OrbSlotRecord) ?? null;
}

export async function slotOrbToAvatar(
  walletAddress: string,
  avatar: Pick<AvatarRecord, 'avatarId'>,
  mintAddress: string,
  deps?: OrbSlotsDeps
): Promise<{ success: boolean; error?: 'not_owned' | 'already_slotted' | 'avatar_already_has_orb' }>
{
  const resolvedDdb = deps?.ddb ?? ddb;
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;
  const now = deps?.now?.() ?? Date.now();
  const resolvedGetGateStatus = deps?.getGateStatus ?? getGateStatus;

  const gateStatus = await resolvedGetGateStatus(walletAddress);
  const isOwned = (gateStatus.ownedNFTs ?? []).some((nft) => nft.id === mintAddress);
  if (!isOwned) {
    return { success: false, error: 'not_owned' };
  }

  try {
    await resolvedDdb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: resolvedTableName,
              Item: {
                ...orbSlotKey(mintAddress),
                mintAddress,
                walletAddress,
                avatarId: avatar.avatarId,
                slottedAt: now,
                updatedAt: now,
                resonance: 0,
                resonanceUpdatedAt: now,
                // GSI1 allows lookup by avatarId for resonance tracking
                gsi1pk: `AVATAR#${avatar.avatarId}`,
                gsi1sk: ORB_SLOT_SK,
              } satisfies OrbSlotRecord & { gsi1pk: string; gsi1sk: string },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: resolvedTableName,
              Item: {
                ...walletOrbKey(walletAddress, mintAddress),
                mintAddress,
                walletAddress,
                avatarId: avatar.avatarId,
                slottedAt: now,
                updatedAt: now,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: resolvedTableName,
              Key: { pk: `AVATAR#${avatar.avatarId}`, sk: 'CONFIG' },
              UpdateExpression:
                'SET orbMint = :mint, orbWallet = :wallet, orbSlottedAt = :now, updatedAt = :now',
              ConditionExpression: 'attribute_not_exists(orbMint) OR orbMint = :mint',
              ExpressionAttributeValues: {
                ':mint': mintAddress,
                ':wallet': walletAddress,
                ':now': now,
              },
            },
          },
        ],
      })
    );

    return { success: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      // We don't get fine-grained reasons reliably; infer based on current state.
      const existing = await getOrbSlot(mintAddress, { ...deps, ddb: resolvedDdb, tableName: resolvedTableName });
      if (existing) return { success: false, error: 'already_slotted' };
      return { success: false, error: 'avatar_already_has_orb' };
    }
    throw err;
  }
}

export async function unslotOrbFromAvatar(
  walletAddress: string,
  avatar: Pick<AvatarRecord, 'avatarId' | 'orbMint'>,
  deps?: OrbSlotsDeps
): Promise<{ success: boolean; error?: 'no_orb_slotted' | 'not_owner' }>
{
  const resolvedDdb = deps?.ddb ?? ddb;
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;
  const now = deps?.now?.() ?? Date.now();

  const mintAddress = avatar.orbMint;
  if (!mintAddress) {
    return { success: false, error: 'no_orb_slotted' };
  }

  const existing = await getOrbSlot(mintAddress, { ...deps, ddb: resolvedDdb, tableName: resolvedTableName });
  if (!existing) {
    // Allow clearing the avatar fields even if mapping is missing.
    await resolvedDdb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: resolvedTableName,
              Key: { pk: `AVATAR#${avatar.avatarId}`, sk: 'CONFIG' },
              UpdateExpression: 'REMOVE orbMint, orbWallet, orbSlottedAt SET updatedAt = :now',
              ExpressionAttributeValues: { ':now': now },
            },
          },
        ],
      })
    );
    return { success: true };
  }

  if (existing.walletAddress !== walletAddress) {
    return { success: false, error: 'not_owner' };
  }

  await resolvedDdb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: resolvedTableName,
            Key: orbSlotKey(mintAddress),
          },
        },
        {
          Delete: {
            TableName: resolvedTableName,
            Key: walletOrbKey(walletAddress, mintAddress),
          },
        },
        {
          Update: {
            TableName: resolvedTableName,
            Key: { pk: `AVATAR#${avatar.avatarId}`, sk: 'CONFIG' },
            UpdateExpression: 'REMOVE orbMint, orbWallet, orbSlottedAt SET updatedAt = :now',
            ConditionExpression: 'orbMint = :mint',
            ExpressionAttributeValues: {
              ':mint': mintAddress,
              ':now': now,
            },
          },
        },
      ],
    })
  );

  return { success: true };
}

// ── Resonance Tiers ─────────────────────────────────────────────────────

export interface ResonanceTier {
  tier: 'none' | 'bronze' | 'silver' | 'gold';
  label: string;
  energyRegenBonus: number;
}

export function getResonanceTier(resonance: number): ResonanceTier {
  if (resonance >= 25000) {
    return { tier: 'gold', label: 'Gold', energyRegenBonus: 2 };
  }
  if (resonance >= 5000) {
    return { tier: 'silver', label: 'Silver', energyRegenBonus: 1 };
  }
  if (resonance >= 1000) {
    return { tier: 'bronze', label: 'Bronze', energyRegenBonus: 0.5 };
  }
  return { tier: 'none', label: 'No Resonance', energyRegenBonus: 0 };
}

// ── Resonance Increment ─────────────────────────────────────────────────

/**
 * Look up the slotted Orb for an avatar and atomically increment its
 * resonance counter.  Designed for fire-and-forget usage — logs errors
 * but never throws.
 */
export async function incrementOrbResonance(
  avatarId: string,
  amount = 1,
  deps?: OrbSlotsDeps,
): Promise<void> {
  const resolvedDdb = deps?.ddb ?? ddb;
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;
  const now = deps?.now?.() ?? Date.now();

  try {
    // Find the Orb slotted to this avatar via a query on the GSI or scan.
    // Since we key Orb records by mint address, we need to find the record
    // for this avatar.  We query using a begins_with on pk=ORB# and filter
    // on avatarId.
    const queryResult = await resolvedDdb.send(
      new QueryCommand({
        TableName: resolvedTableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :avatarKey AND gsi1sk = :slot',
        ExpressionAttributeValues: {
          ':avatarKey': `AVATAR#${avatarId}`,
          ':slot': ORB_SLOT_SK,
        },
        Limit: 1,
      }),
    );

    // Fallback: scan for the orb slot if no GSI available
    let orbRecord: OrbSlotRecord | null = null;
    if (queryResult.Items && queryResult.Items.length > 0) {
      orbRecord = queryResult.Items[0] as OrbSlotRecord;
    }

    if (!orbRecord) {
      // No Orb slotted to this avatar — nothing to do.
      return;
    }

    await resolvedDdb.send(
      new UpdateCommand({
        TableName: resolvedTableName,
        Key: orbSlotKey(orbRecord.mintAddress),
        UpdateExpression:
          'SET resonance = if_not_exists(resonance, :zero) + :amount, resonanceUpdatedAt = :now',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':amount': amount,
          ':now': now,
        },
      }),
    );
  } catch (err) {
    logger.warn('Failed to increment Orb resonance', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get the resonance data for a slotted Orb by avatar ID.
 * Returns null if no Orb is slotted.
 */
export async function getOrbResonance(
  avatarId: string,
  deps?: OrbSlotsDeps,
): Promise<{ resonance: number; tier: ResonanceTier; mintAddress: string } | null> {
  const resolvedDdb = deps?.ddb ?? ddb;
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;

  try {
    const queryResult = await resolvedDdb.send(
      new QueryCommand({
        TableName: resolvedTableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :avatarKey AND gsi1sk = :slot',
        ExpressionAttributeValues: {
          ':avatarKey': `AVATAR#${avatarId}`,
          ':slot': ORB_SLOT_SK,
        },
        Limit: 1,
      }),
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return null;
    }

    const record = queryResult.Items[0] as OrbSlotRecord;
    const resonance = record.resonance ?? 0;
    return {
      resonance,
      tier: getResonanceTier(resonance),
      mintAddress: record.mintAddress,
    };
  } catch (err) {
    logger.warn('Failed to get Orb resonance', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
