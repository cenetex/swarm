/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Avatar Lifetime Stats
 *
 * Aggregates all-time usage statistics for an avatar, used to enrich
 * Lineage NFT metadata when avatars are abandoned.
 *
 * Queries are best-effort: failures return partial data and never block
 * the abandon flow.
 */
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'SwarmAdminTable';

export interface AvatarLifetimeStats {
  messagesProcessed: number;
  mediaGenerated: number;
  voiceMinutesUsed: number;
  daysActive: number;
  burnTier?: number;
  burnTierName?: string;
}

/**
 * Aggregate all-time stats for an avatar by summing daily usage records.
 *
 * Each day's usage is stored as pk=USAGE#{avatarId}, sk=DAY#{YYYY-MM-DD}.
 * We query all records with no date bounds to get the full lifetime.
 *
 * Burn tier is fetched from pk=AVATAR#{avatarId}, sk=BURN_STATS.
 *
 * Every query is wrapped in try/catch so that partial failures never
 * propagate — the caller always gets a result.
 */
export async function getAvatarLifetimeStats(avatarId: string): Promise<AvatarLifetimeStats> {
  const stats: AvatarLifetimeStats = {
    messagesProcessed: 0,
    mediaGenerated: 0,
    voiceMinutesUsed: 0,
    daysActive: 0,
  };

  // --- Aggregate daily usage records ---
  try {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: ADMIN_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USAGE#${avatarId}`,
          ':prefix': 'DAY#',
        },
        ExclusiveStartKey: lastKey,
      }));

      for (const item of result.Items ?? []) {
        stats.messagesProcessed += Number(item.messagesProcessed ?? 0);
        stats.mediaGenerated +=
          Number(item.imageGenerations ?? 0) +
          Number(item.videoGenerations ?? 0) +
          Number(item.stickerGenerations ?? 0);
        stats.voiceMinutesUsed += Number(item.voiceMinutesUsed ?? 0);
        stats.daysActive += 1;
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  } catch (error) {
    console.warn(
      '[AvatarLifetimeStats] Failed to aggregate usage records for',
      avatarId,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- Fetch burn tier ---
  try {
    const burnResult = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'BURN_STATS',
      },
    }));

    if (burnResult.Item) {
      // Re-derive tier from totalBurned using the same tiers as burn-stats.ts
      const totalBurned = Number(burnResult.Item.totalBurned ?? 0);
      // Inline tier derivation to avoid importing @swarm/core at this layer.
      // Tiers mirror packages/core BURN_TIERS: 0 → Ember, 1 → Spark, 2 → Blaze,
      // 3 → Inferno, 4 → Nova, 5 → Supernova.
      const TIER_THRESHOLDS = [
        { tier: 5, min: 1_000_000, name: 'Supernova' },
        { tier: 4, min: 500_000,   name: 'Nova' },
        { tier: 3, min: 100_000,   name: 'Inferno' },
        { tier: 2, min: 10_000,    name: 'Blaze' },
        { tier: 1, min: 1_000,     name: 'Spark' },
        { tier: 0, min: 0,         name: 'Ember' },
      ];

      const matched = TIER_THRESHOLDS.find(t => totalBurned >= t.min) ?? TIER_THRESHOLDS.at(-1)!;
      stats.burnTier = matched.tier;
      stats.burnTierName = matched.name;
    }
  } catch (error) {
    console.warn(
      '[AvatarLifetimeStats] Failed to fetch burn stats for',
      avatarId,
      error instanceof Error ? error.message : String(error),
    );
  }

  return stats;
}
