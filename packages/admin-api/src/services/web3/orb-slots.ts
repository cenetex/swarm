import {
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { getGateStatus } from './nft-gate.js';
import type { AvatarRecord } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

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
              } satisfies OrbSlotRecord,
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
