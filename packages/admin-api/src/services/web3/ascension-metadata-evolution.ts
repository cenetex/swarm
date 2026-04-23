/**
 * Ascension NFT Metadata Evolution
 *
 * Periodically refreshes on-chain metadata for Ascension NFTs so that
 * marketplace listings reflect up-to-date avatar stats (messages processed,
 * media generated, burn tier, resonance, etc.).
 *
 * Pipeline per avatar:
 * 1. Query avatar record → confirm isAscended + ascendedNftMint
 * 2. Aggregate lifetime stats (messages, media, voice, days active, burn tier)
 * 3. Generate evolved Metaplex-standard metadata JSON
 * 4. Upload to Arweave via Irys → get permanent ar:// URI
 * 5. Update on-chain metadata URI via Metaplex (requires update authority)
 * 6. Record evolution event in DynamoDB
 *
 * Steps 5 is deferred until the Metaplex SDK is wired up. For now the
 * pipeline stops after step 4 and records the new Arweave URI so it can
 * be applied manually or by a future on-chain updater.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { createSystemLogger } from '../structured-logger.js';
import { getAvatarLifetimeStats } from './avatar-lifetime-stats.js';
import { getOrbResonance } from './orb-slots.js';
import { uploadJsonToArweave, type ArweaveServiceConfig } from './arweave.js';
import {
  ASCENSION_ENERGY_BOOST,
  getTierForBurnAmount,
} from '@swarm/core';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const dynamoClient = getDynamoClient();
const log = createSystemLogger('metadata-evolution');

// =============================================================================
// Types
// =============================================================================

export interface EvolutionResult {
  avatarId: string;
  avatarName: string;
  success: boolean;
  /** New Arweave URI for the evolved metadata. */
  arweaveUri?: string;
  /** Whether on-chain update was applied (false until Metaplex wiring). */
  onChainUpdated: boolean;
  /** Previous metadata URI (if known). */
  previousUri?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface EvolutionBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: EvolutionResult[];
}

// =============================================================================
// Metadata Generation
// =============================================================================

interface EvolvedMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  attributes: Array<{
    trait_type: string;
    value: string | number | boolean;
    display_type?: string;
  }>;
  properties: {
    category: string;
    creators: Array<{ address: string; share: number }>;
  };
}

/**
 * Generate evolved Metaplex-standard metadata for an Ascension NFT.
 *
 * Includes all static ascension data plus dynamic lifetime stats.
 */
function generateEvolvedMetadata(
  avatar: AvatarRecord,
  stats: Awaited<ReturnType<typeof getAvatarLifetimeStats>> | null,
  resonance: Awaited<ReturnType<typeof getOrbResonance>>,
): EvolvedMetadata {
  const tier = getTierForBurnAmount(avatar.ascensionRatiBurnAmount || 0);

  const attributes: EvolvedMetadata['attributes'] = [
    { trait_type: 'Avatar ID', value: avatar.avatarId },
    { trait_type: 'Avatar Name', value: avatar.name },
    { trait_type: 'Ascended At', value: new Date(avatar.ascendedAt || 0).toISOString() },
    { trait_type: 'Ascension Tier', value: tier.name },
    { trait_type: 'RATI Burned', value: avatar.ascensionRatiBurnAmount || 0, display_type: 'number' },
    { trait_type: 'Energy Boost', value: `+${(ASCENSION_ENERGY_BOOST.maxEnergyMultiplier - 1) * 100}%` },
    { trait_type: 'Persona Locked', value: 'true' },
  ];

  // Dynamic stats
  if (stats) {
    attributes.push(
      { trait_type: 'Messages Processed', value: stats.messagesProcessed, display_type: 'number' },
      { trait_type: 'Media Generated', value: stats.mediaGenerated, display_type: 'number' },
      { trait_type: 'Voice Minutes', value: Math.round(stats.voiceMinutesUsed * 10) / 10, display_type: 'number' },
      { trait_type: 'Days Active', value: stats.daysActive, display_type: 'number' },
    );
    if (stats.burnTierName) {
      attributes.push({ trait_type: 'Burn Tier', value: stats.burnTierName });
    }
  }

  // Resonance (from Orb slot)
  if (resonance) {
    attributes.push(
      { trait_type: 'Orb Resonance', value: resonance.resonance, display_type: 'number' },
      { trait_type: 'Resonance Tier', value: resonance.tier.label },
    );
  }

  // Metadata evolution timestamp
  attributes.push({
    trait_type: 'Last Evolved',
    value: new Date().toISOString(),
  });

  return {
    name: `${avatar.name} (Ascended)`,
    symbol: 'ASCEND',
    description:
      `Ascended Avatar NFT for ${avatar.name}. ` +
      `This NFT grants ownership of the avatar — the holder can control this avatar. ` +
      `Persona and profile image are permanently locked. ` +
      `Stats evolve over time as the avatar is used.`,
    image: avatar.profileImage?.url || '',
    external_url: `https://rati.chat/avatar/${avatar.avatarId}`,
    attributes,
    properties: {
      category: 'image',
      creators: [
        { address: avatar.ascendedByWallet || '', share: 100 },
      ],
    },
  };
}

// =============================================================================
// Single Avatar Evolution
// =============================================================================

/**
 * Run the evolution pipeline for a single ascended avatar.
 */
export async function evolveAscensionMetadata(
  avatar: AvatarRecord,
  arweaveConfig: ArweaveServiceConfig = {},
): Promise<EvolutionResult> {
  const { avatarId, name: avatarName } = avatar;

  if (!avatar.isAscended || !avatar.ascendedNftMint) {
    return {
      avatarId,
      avatarName,
      success: false,
      onChainUpdated: false,
      skipped: true,
      skipReason: 'not_ascended',
    };
  }

  try {
    // Aggregate stats + resonance in parallel
    const [stats, resonance] = await Promise.all([
      getAvatarLifetimeStats(avatarId).catch((err) => {
        log.warn('evolution', 'stats_fetch_failed', {
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
      getOrbResonance(avatarId).catch(() => null),
    ]);

    // Generate evolved metadata
    const metadata = generateEvolvedMetadata(avatar, stats, resonance);

    // Upload to Arweave
    const uploadResult = await uploadJsonToArweave(metadata, arweaveConfig);

    log.info('evolution', 'metadata_uploaded', {
      avatarId,
      arweaveUri: uploadResult.arweaveUri,
    });

    // Record the evolution in DynamoDB
    const now = Date.now();
    await dynamoClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: `
        SET lastMetadataEvolution = :now,
            lastMetadataUri = :uri,
            metadataEvolutionCount = if_not_exists(metadataEvolutionCount, :zero) + :one,
            updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ':now': now,
        ':uri': uploadResult.arweaveUri,
        ':zero': 0,
        ':one': 1,
      },
    }));

    // TODO: On-chain URI update via Metaplex Umi
    // When implemented, this will:
    // 1. Load update authority keypair from Secrets Manager
    // 2. Create Umi instance with Helius RPC
    // 3. Call updateV1() to set the new metadata URI on-chain
    // For now, the Arweave URI is recorded and can be applied manually.

    return {
      avatarId,
      avatarName,
      success: true,
      arweaveUri: uploadResult.arweaveUri,
      onChainUpdated: false,
      previousUri: (avatar as unknown as Record<string, unknown>).lastMetadataUri as string | undefined,
    };
  } catch (error) {
    log.error('evolution', 'evolve_failed', {
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      avatarId,
      avatarName,
      success: false,
      onChainUpdated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// =============================================================================
// Batch Evolution (Scheduled Job)
// =============================================================================

/**
 * Find all ascended avatars and run the evolution pipeline for each.
 *
 * Avatars that were evolved less than `minIntervalMs` ago are skipped.
 */
export async function evolveAllAscensionMetadata(
  arweaveConfig: ArweaveServiceConfig = {},
  minIntervalMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days default
): Promise<EvolutionBatchResult> {
  const now = Date.now();

  // Scan for all ascended avatars
  const scanResult = await dynamoClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'sk = :sk AND isAscended = :true',
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':true': true,
    },
    ProjectionExpression: 'pk, sk, avatarId, #n, isAscended, ascendedNftMint, ascendedAt, ascendedByWallet, ascensionRatiBurnAmount, profileImage, lastMetadataEvolution, lastMetadataUri, metadataEvolutionCount',
    ExpressionAttributeNames: {
      '#n': 'name',
    },
  }));

  const avatars = (scanResult.Items || []) as AvatarRecord[];

  log.info('batch', 'ascended_avatars_found', { count: avatars.length });

  const results: EvolutionResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const avatar of avatars) {
    // Check cooldown
    const lastEvolution = (avatar as unknown as Record<string, unknown>).lastMetadataEvolution as number | undefined;
    if (lastEvolution && (now - lastEvolution) < minIntervalMs) {
      results.push({
        avatarId: avatar.avatarId,
        avatarName: avatar.name,
        success: false,
        onChainUpdated: false,
        skipped: true,
        skipReason: 'cooldown',
      });
      skipped++;
      continue;
    }

    const result = await evolveAscensionMetadata(avatar, arweaveConfig);
    results.push(result);

    if (result.skipped) {
      skipped++;
    } else if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  log.info('batch', 'batch_complete', { succeeded, failed, skipped });

  return {
    processed: avatars.length,
    succeeded,
    failed,
    skipped,
    results,
  };
}
