/**
 * Avatar Inhabitation Service
 *
 * Manages 1:1 inhabitation between Solana wallets and avatars.
 * Each wallet can only "inhabit" one avatar at a time.
 * Inhabiting an avatar lets the user appear as that avatar in chat.
 *
 * Key concepts:
 * - INHABIT = Claim an unclaimed avatar (FREE, no NFT required)
 * - ABANDON = Release an avatar (REQUIRES burning a Gate NFT)
 *
 * Data Model (uses GSI1 for wallet→avatar lookup):
 * - Avatar record: pk=AVATAR#<id>, sk=CONFIG, inhabitantWallet=<wallet>
 * - Inhabitant mapping: pk=AVATAR#<id>, sk=INHABITANT#<wallet>
 * - GSI1 query: sk=INHABITANT#<wallet> → returns pk=AVATAR#<id>
 */
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord } from '../types.js';
import { getGateStatus, type GateStatus } from './web3/nft-gate.js';
import { verifyGateBurn } from './web3/lineage-nft.js';
import { canInhabitAscendedAvatar } from './avatar-ascend.js';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('avatar-ownership');

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const GSI1_NAME = 'GSI1';
const WALLET_MAPPING_SK = 'INHABITS';

const ddb = getDynamoClient();

export interface InhabitResult {
  success: boolean;
  error?: string;
  avatarId?: string;
  avatarName?: string;
  avatarUrl?: string;
  era?: number;  // Which era they will be when they abandon
}

export interface AbandonResult {
  success: boolean;
  error?: string;
  avatarId?: string;
  avatarName?: string;
  era?: number;
  lineageNftMint?: string;
  burnedMint?: string;
  gateStatus?: GateStatus;
}

export interface AvatarOwnershipDeps {
  ddb: Pick<typeof ddb, 'send'>;
  tableName?: string;
}

// Legacy type alias
export type OwnershipResult = InhabitResult;

// =============================================================================
// INHABITATION API (uses GSI1 for wallet→avatar lookups)
// =============================================================================

/**
 * Get the avatar inhabited by a wallet (if any)
 * Uses GSI1 to query by sk=INHABITANT#<wallet>
 */
export async function getInhabitedAvatar(
  walletAddress: string,
  deps?: AvatarOwnershipDeps
): Promise<AvatarRecord | null> {
  const resolvedTableName = deps?.tableName ?? TABLE_NAME;
  const resolvedDdb = deps?.ddb ?? ddb;

  // New schema (preferred): pk=WALLET#<wallet>, sk=INHABITS -> { avatarId }
  const walletMapping = await resolvedDdb.send(
    new GetCommand({
      TableName: resolvedTableName,
      Key: {
        pk: `WALLET#${walletAddress}`,
        sk: WALLET_MAPPING_SK,
      },
    })
  );

  const mappedAvatarId = (walletMapping.Item as { avatarId?: string } | undefined)?.avatarId;

  // Legacy schema fallback (GSI1): sk=INHABITANT#<wallet> -> pk=AVATAR#<avatarId>
  let legacyAvatarId: string | undefined;
  if (!mappedAvatarId) {
    const legacyResult = await resolvedDdb.send(
      new QueryCommand({
        TableName: resolvedTableName,
        IndexName: GSI1_NAME,
        KeyConditionExpression: 'sk = :sk',
        ExpressionAttributeValues: {
          ':sk': `INHABITANT#${walletAddress}`,
        },
        // Fetch up to 2 to detect data corruption (a wallet should map to at most 1 avatar).
        Limit: 2,
        ScanIndexForward: true,
      })
    );

    if (!legacyResult.Items || legacyResult.Items.length === 0) {
      return null;
    }

    if (legacyResult.Items.length > 1) {
      log.error('inhabit', 'data_corruption_multiple_legacy_mappings', {
        walletPrefix: walletAddress.slice(0, 8),
        count: legacyResult.Items.length,
      });
    }

    const pk = legacyResult.Items[0].pk as string;
    legacyAvatarId = pk.replace('AVATAR#', '');
  }

  const avatarId = mappedAvatarId ?? legacyAvatarId;

  if (!avatarId) {
    return null;
  }

  // Get the full avatar record
  const avatarResult = await resolvedDdb.send(
    new GetCommand({
      TableName: resolvedTableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
    })
  );

  return (avatarResult.Item as AvatarRecord) || null;
}

/**
 * Inhabit an unclaimed avatar (FREE - no NFT required)
 *
 * Uses TransactWriteItems for atomic update of both:
 * 1. Avatar CONFIG record (set inhabitantWallet)
 * 2. Inhabitant mapping record (for GSI1 lookup)
 *
 * @param walletAddress - The wallet inhabiting the avatar
 * @param avatarId - The avatar to inhabit
 * @returns Result with success/error and avatar info
 */
export async function inhabitAvatar(
  walletAddress: string,
  avatarId: string
): Promise<InhabitResult> {
  // Check if wallet already inhabits an avatar
  const existingInhabited = await getInhabitedAvatar(walletAddress);
  if (existingInhabited) {
    return {
      success: false,
      error: `You already inhabit ${existingInhabited.name}. You must abandon it first (requires burning a Gate NFT).`,
    };
  }

  // Get the avatar
  const avatarResult = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  if (!avatarResult.Item) {
    return { success: false, error: 'Avatar not found' };
  }

  const avatar = avatarResult.Item as AvatarRecord;

  // Check if already inhabited
  if (avatar.inhabitantWallet) {
    return {
      success: false,
      error: `${avatar.name} is already inhabited by another wallet`,
    };
  }

  // Check if avatar is ascended - only the Ascension NFT holder can inhabit
  if (avatar.isAscended && avatar.ascendedNftMint) {
    const ascensionCheck = await canInhabitAscendedAvatar(avatar, walletAddress);
    if (!ascensionCheck.allowed) {
      return {
        success: false,
        error: ascensionCheck.error || 'Only the Ascension NFT holder can inhabit this avatar',
      };
    }
  }

  const now = Date.now();

  try {
    // Atomic transaction: update avatar AND create mapping in one operation
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // Update avatar with inhabitant - condition: still no inhabitant
            Update: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AVATAR#${avatarId}`,
                sk: 'CONFIG',
              },
              UpdateExpression:
                'SET inhabitantWallet = :wallet, inhabitedAt = :now, updatedAt = :now',
              ConditionExpression: 'attribute_not_exists(inhabitantWallet)',
              ExpressionAttributeValues: {
                ':wallet': walletAddress,
                ':now': now,
              },
            },
          },
          {
            // Create wallet->avatar mapping record (new schema; enforces 1:1 naturally)
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `WALLET#${walletAddress}`,
                sk: WALLET_MAPPING_SK,
                walletAddress,
                avatarId,
                inhabitedAt: now,
                updatedAt: now,
              },
              // Prevent a wallet from inhabiting multiple avatars
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            // Create inhabitant mapping record (for GSI1 lookup)
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `AVATAR#${avatarId}`,
                sk: `INHABITANT#${walletAddress}`,
                avatarId,
                walletAddress,
                inhabitedAt: now,
              },
              // Prevent duplicate mappings
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      })
    );

    log.info('inhabit', 'avatar_inhabited', {
      walletPrefix: walletAddress.slice(0, 8),
      avatarId,
    });

    return {
      success: true,
      avatarId,
      avatarName: avatar.name,
      avatarUrl: avatar.profileImage?.url,
      era: (avatar.currentEra || 0) + 1, // They will be this era when they abandon
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      // Check which condition failed
      const message = err.message || '';
      if (message.includes('ConditionalCheckFailed')) {
        return {
          success: false,
          error: `${avatar.name} was just inhabited by another wallet`,
        };
      }
    }
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        error: `${avatar.name} was just inhabited by another wallet`,
      };
    }
    throw err;
  }
}

/**
 * Check if a wallet can abandon their current avatar
 * Requires holding at least 1 Gate NFT
 */
export async function canAbandon(walletAddress: string): Promise<{
  canAbandon: boolean;
  gateStatus: GateStatus;
  inhabitedAvatar?: AvatarRecord;
  /** @deprecated Use inhabitedAvatar instead */
  inhabitedAgent?: AvatarRecord;
}> {
  const gateStatus = await getGateStatus(walletAddress);
  const inhabitedAvatar = await getInhabitedAvatar(walletAddress) ?? undefined;

  return {
    canAbandon: gateStatus.canAbandon && !!inhabitedAvatar,
    gateStatus,
    inhabitedAvatar,
    inhabitedAgent: inhabitedAvatar, // backwards compat
  };
}

/**
 * Abandon an inhabited avatar (REQUIRES burning a Gate NFT)
 *
 * This function:
 * 1. Verifies the burn transaction on-chain (REQUIRED)
 * 2. Increments the avatar's era
 * 3. Clears the inhabitant atomically
 * 4. Returns info needed to mint the lineage NFT
 *
 * Flow:
 * 1. Client burns Gate NFT → gets transaction signature
 * 2. Client calls this endpoint with signature
 * 3. Backend verifies burn on-chain
 * 4. Backend releases avatar
 *
 * @param walletAddress - The wallet abandoning the avatar
 * @param burnTxSignature - REQUIRED: The signature of the Gate NFT burn transaction
 * @returns Result with avatar info for lineage minting
 */
export async function abandonAvatar(
  walletAddress: string,
  burnTxSignature: string
): Promise<AbandonResult> {
  // Burn verification is REQUIRED
  if (!burnTxSignature) {
    return {
      success: false,
      error: 'Burn transaction signature is required. You must burn a Gate NFT to abandon.',
    };
  }

  // Get the inhabited avatar first (before verification, for better UX)
  const avatar = await getInhabitedAvatar(walletAddress);

  if (!avatar) {
    return {
      success: false,
      error: 'You do not currently inhabit any avatar',
    };
  }

  // Verify this wallet is the inhabitant
  if (avatar.inhabitantWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this avatar',
    };
  }

  // Verify the burn transaction on-chain
  const burnVerification = await verifyGateBurn(walletAddress, burnTxSignature);
  if (!burnVerification.verified) {
    return {
      success: false,
      error: `Burn verification failed: ${burnVerification.error || 'Invalid transaction'}`,
    };
  }

  const burnedMint = burnVerification.burnedMint;
  const now = Date.now();
  const newEra = (avatar.currentEra || 0) + 1;

  try {
    const updateExpression = `
      SET currentEra = :era, updatedAt = :now, lastBurnTx = :burnTx${burnedMint ? ', lastBurnMint = :burnMint' : ''}
      REMOVE inhabitantWallet, inhabitedAt
    `;

    // Atomic transaction: update avatar AND delete mapping
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // Update avatar: increment era, clear inhabitant
            Update: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AVATAR#${avatar.avatarId}`,
                sk: 'CONFIG',
              },
              UpdateExpression: updateExpression,
              // Ensure we're still the inhabitant
              ConditionExpression: 'inhabitantWallet = :wallet',
              ExpressionAttributeValues: {
                ':era': newEra,
                ':now': now,
                ':burnTx': burnTxSignature,
                ...(burnedMint ? { ':burnMint': burnedMint } : {}),
                ':wallet': walletAddress,
              },
            },
          },
          {
            // Delete wallet->avatar mapping record (new schema)
            Delete: {
              TableName: TABLE_NAME,
              Key: {
                pk: `WALLET#${walletAddress}`,
                sk: WALLET_MAPPING_SK,
              },
              // Safety: only delete if it matches this avatar
              ConditionExpression: 'avatarId = :avatarId',
              ExpressionAttributeValues: {
                ':avatarId': avatar.avatarId,
              },
            },
          },
          {
            // Delete inhabitant mapping record
            Delete: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AVATAR#${avatar.avatarId}`,
                sk: `INHABITANT#${walletAddress}`,
              },
            },
          },
        ],
      })
    );

    log.info('abandon', 'avatar_abandoned', {
      walletPrefix: walletAddress.slice(0, 8),
      avatarId: avatar.avatarId,
      era: newEra,
      burnTxPrefix: burnTxSignature.slice(0, 16),
    });

    // Get updated gate status
    const gateStatus = await getGateStatus(walletAddress);

    return {
      success: true,
      avatarId: avatar.avatarId,
      avatarName: avatar.name,
      era: newEra,
      lineageNftMint: avatar.nftCollectionMint,
      burnedMint,
      gateStatus,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      return {
        success: false,
        error: 'Avatar state changed during abandon. Please try again.',
      };
    }
    throw err;
  }
}

/**
 * Abandon without burn verification (LEGACY - for migration only)
 * @deprecated Use abandonAvatar with burnTxSignature instead
 */
export async function abandonAvatarLegacy(
  walletAddress: string
): Promise<AbandonResult> {
  // Get current gate status
  const gateStatus = await getGateStatus(walletAddress);

  if (!gateStatus.canAbandon) {
    return {
      success: false,
      error: 'You must hold at least 1 Gate NFT to abandon an avatar.',
      gateStatus,
    };
  }

  const avatar = await getInhabitedAvatar(walletAddress);

  if (!avatar) {
    return {
      success: false,
      error: 'You do not currently inhabit any avatar',
      gateStatus,
    };
  }

  if (avatar.inhabitantWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this avatar',
      gateStatus,
    };
  }

  const now = Date.now();
  const newEra = (avatar.currentEra || 0) + 1;

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: {
              pk: `AVATAR#${avatar.avatarId}`,
              sk: 'CONFIG',
            },
            UpdateExpression: `
              SET currentEra = :era, updatedAt = :now
              REMOVE inhabitantWallet, inhabitedAt
            `,
            ExpressionAttributeValues: {
              ':era': newEra,
              ':now': now,
            },
          },
        },
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: {
              pk: `WALLET#${walletAddress}`,
              sk: WALLET_MAPPING_SK,
            },
            ConditionExpression: 'avatarId = :avatarId',
            ExpressionAttributeValues: {
              ':avatarId': avatar.avatarId,
            },
          },
        },
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: {
              pk: `AVATAR#${avatar.avatarId}`,
              sk: `INHABITANT#${walletAddress}`,
            },
          },
        },
      ],
    })
  );

  log.info('abandon', 'avatar_abandoned_legacy', {
    walletPrefix: walletAddress.slice(0, 8),
    avatarId: avatar.avatarId,
    era: newEra,
  });

  return {
    success: true,
    avatarId: avatar.avatarId,
    avatarName: avatar.name,
    era: newEra,
    lineageNftMint: avatar.nftCollectionMint,
    gateStatus,
  };
}

/**
 * Get inhabitation info for display
 * Returns ghost status for unauthenticated or non-inhabiting users
 */
export async function getInhabitationInfo(walletAddress: string): Promise<{
  isGhost: boolean;
  inhabitsAvatar: boolean;
  /** @deprecated Use inhabitsAvatar instead */
  inhabitsAgent: boolean;
  avatarId?: string;
  avatarName?: string;
  avatarUrl?: string;
  era?: number;
  gateStatus?: GateStatus;
}> {
  const avatar = await getInhabitedAvatar(walletAddress);

  if (!avatar) {
    const gateStatus = await getGateStatus(walletAddress);
    return {
      isGhost: true,
      inhabitsAvatar: false,
      inhabitsAgent: false, // backwards compat
      gateStatus,
    };
  }

  return {
    isGhost: false,
    inhabitsAvatar: true,
    inhabitsAgent: true, // backwards compat
    avatarId: avatar.avatarId,
    avatarName: avatar.name,
    avatarUrl: avatar.profileImage?.url,
    era: avatar.currentEra || 0,
  };
}

// =============================================================================
// RECONCILIATION - Fix orphaned mappings
// =============================================================================

export interface ReconciliationResult {
  orphanedMappings: number;
  orphanedAgents: number;
  fixed: number;
  errors: string[];
}

/**
 * Find and fix orphaned inhabitant mappings
 *
 * Orphaned states can occur if:
 * 1. Mapping exists but avatar.inhabitantWallet is null (mapping orphan)
 * 2. Avatar.inhabitantWallet is set but no mapping exists (avatar orphan)
 *
 * This function scans for both cases and reconciles them.
 */
export async function reconcileInhabitantMappings(
  dryRun: boolean = true
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    orphanedMappings: 0,
    orphanedAgents: 0,
    fixed: 0,
    errors: [],
  };

  log.info('reconcile', 'reconciliation_started', { dryRun });

  try {
    // Scan for all INHABITANT# mappings
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

    let mappingCount = 0;
    let mappingLastKey: Record<string, unknown> | undefined;

    do {
      const mappingScan = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':prefix': 'INHABITANT#',
          },
          ExclusiveStartKey: mappingLastKey,
          // Keep pages reasonably sized; this scan can be expensive.
          Limit: 1000,
        })
      );

      const mappings = mappingScan.Items || [];
      mappingCount += mappings.length;
      mappingLastKey = mappingScan.LastEvaluatedKey as Record<string, unknown> | undefined;

      for (const mapping of mappings) {
        const avatarId = mapping.avatarId as string;
        const walletAddress = mapping.walletAddress as string;

        // Get the avatar record
        const avatarResult = await ddb.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `AVATAR#${avatarId}`,
              sk: 'CONFIG',
            },
          })
        );

        const avatar = avatarResult.Item as AvatarRecord | undefined;

        if (!avatar) {
          // Avatar doesn't exist - delete orphaned mapping
          result.orphanedMappings++;
          result.errors.push(`Mapping for non-existent avatar: ${avatarId}`);

          if (!dryRun) {
            const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
            await ddb.send(
              new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                  pk: `AVATAR#${avatarId}`,
                  sk: `INHABITANT#${walletAddress}`,
                },
              })
            );
            result.fixed++;
            log.info('reconcile', 'orphaned_mapping_deleted', { avatarId });
          }
        } else if (avatar.inhabitantWallet !== walletAddress) {
          // Avatar has different or no inhabitant - delete stale mapping
          result.orphanedMappings++;
          result.errors.push(
            `Stale mapping: avatar ${avatarId} has inhabitant ${avatar.inhabitantWallet || 'none'}, but mapping points to ${walletAddress}`
          );

          if (!dryRun) {
            const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
            await ddb.send(
              new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                  pk: `AVATAR#${avatarId}`,
                  sk: `INHABITANT#${walletAddress}`,
                },
              })
            );
            result.fixed++;
            log.info('reconcile', 'stale_mapping_deleted', { avatarId });
          }
        }
      }

      if (mappings.length > 0) {
        log.info('reconcile', 'mappings_scanned_progress', { mappingCount });
      }
    } while (mappingLastKey);

    log.info('reconcile', 'mappings_scan_complete', { mappingCount });

    // Also scan for avatars with inhabitantWallet but no mapping
    let avatarCount = 0;
    let avatarLastKey: Record<string, unknown> | undefined;

    do {
      const avatarScan = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'sk = :config AND attribute_exists(inhabitantWallet)',
          ExpressionAttributeValues: {
            ':config': 'CONFIG',
          },
          ExclusiveStartKey: avatarLastKey,
          Limit: 1000,
        })
      );

      const avatars = avatarScan.Items || [];
      avatarCount += avatars.length;
      avatarLastKey = avatarScan.LastEvaluatedKey as Record<string, unknown> | undefined;

      for (const avatar of avatars) {
        const avatarId = avatar.avatarId as string;
        const walletAddress = avatar.inhabitantWallet as string;

        // Check if mapping exists
        const mappingResult = await ddb.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `AVATAR#${avatarId}`,
              sk: `INHABITANT#${walletAddress}`,
            },
          })
        );

        if (!mappingResult.Item) {
          // No mapping exists - create it
          result.orphanedAgents++;
          result.errors.push(`Avatar ${avatarId} has inhabitant ${walletAddress} but no mapping`);

          if (!dryRun) {
            const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
            await ddb.send(
              new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                  pk: `AVATAR#${avatarId}`,
                  sk: `INHABITANT#${walletAddress}`,
                  avatarId,
                  walletAddress,
                  inhabitedAt: avatar.inhabitedAt || Date.now(),
                  reconciledAt: Date.now(),
                },
              })
            );
            result.fixed++;
            log.info('reconcile', 'missing_mapping_created', { avatarId });
          }
        }
      }

      if (avatars.length > 0) {
        log.info('reconcile', 'avatars_scanned_progress', { avatarCount });
      }
    } while (avatarLastKey);

    log.info('reconcile', 'avatars_scan_complete', { avatarCount });

    log.info('reconcile', 'reconciliation_complete', {
      orphanedMappings: result.orphanedMappings,
      orphanedAgents: result.orphanedAgents,
      fixed: result.fixed,
    });
  } catch (err) {
    log.error('reconcile', 'reconciliation_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors.push(`Scan error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  return result;
}

// =============================================================================
// LEGACY API - Deprecated aliases for backwards compatibility
// =============================================================================

// Agent→Avatar aliases (prefer Avatar naming)
/** @deprecated Use getInhabitedAvatar instead */
export const getInhabitedAgent = getInhabitedAvatar;
/** @deprecated Use inhabitAvatar instead */
export const inhabitAgent = inhabitAvatar;
/** @deprecated Use abandonAvatar instead */
export const abandonAgent = abandonAvatar;
/** @deprecated Use abandonAvatarLegacy instead */
export const abandonAgentLegacy = abandonAvatarLegacy;

// Older ownership aliases
/** @deprecated Use getInhabitedAvatar instead */
export const getOwnedAgent = getInhabitedAvatar;
/** @deprecated Use inhabitAvatar instead */
export const claimAgent = inhabitAvatar;

/**
 * @deprecated Use abandonAvatar with burnTxSignature instead
 */
export async function releaseAvatar(
  walletAddress: string
): Promise<OwnershipResult> {
  // Use legacy abandon which doesn't require burn verification
  const result = await abandonAvatarLegacy(walletAddress);
  return {
    success: result.success,
    error: result.error,
    avatarId: result.avatarId,
    avatarName: result.avatarName,
  };
}

/** @deprecated Use abandonAvatar with burnTxSignature instead */
export const releaseAgent = releaseAvatar;

/**
 * @deprecated Use getInhabitationInfo instead
 */
export async function getOwnershipInfo(walletAddress: string): Promise<{
  inhabitsAgent: boolean;
  avatarId?: string;
  avatarName?: string;
  avatarUrl?: string;
}> {
  const info = await getInhabitationInfo(walletAddress);
  return {
    inhabitsAgent: info.inhabitsAgent,
    avatarId: info.avatarId,
    avatarName: info.avatarName,
    avatarUrl: info.avatarUrl,
  };
}
