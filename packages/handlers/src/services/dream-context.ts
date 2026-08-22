/**
 * Dream Context Service (handlers-side)
 *
 * Retrieves the current dream state for an avatar from the STATE_TABLE.
 * Dream state is stored by the admin-api dream worker and provides
 * narrative continuity context for autonomous content generation.
 */
import { GetCommand } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';
import { logger } from '@swarm/core';

export interface DreamContext {
  dream: string;
  previousDream?: string;
  generatedAt: number;
  iteration: number;
}

/**
 * Get the current dream state for an avatar.
 * Returns null if no dream exists or STATE_TABLE is not configured.
 */
export async function getDreamContext(
  avatarId: string,
  options: { stateTable?: string } = {}
): Promise<DreamContext | null> {
  const tableName = options.stateTable || process.env.STATE_TABLE;
  if (!tableName) return null;

  try {
    const result = await getDynamoClient().send(new GetCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'DREAM#current' },
    }));

    if (!result.Item) return null;

    const item = result.Item as Record<string, unknown>;

    // Check if dream is stale (older than 24 hours)
    const dreamAge = Date.now() - (item.generatedAt as number || 0);
    const DREAM_TTL_MS = 24 * 60 * 60 * 1000;
    if (dreamAge > DREAM_TTL_MS) {
      logger.debug('Dream state is stale, skipping', {
        avatarId,
        dreamAge,
        generatedAt: item.generatedAt,
      });
      return null;
    }

    return {
      dream: item.dream as string,
      previousDream: item.previousDream as string | undefined,
      generatedAt: item.generatedAt as number,
      iteration: (item.iteration as number) || 1,
    };
  } catch (error) {
    logger.warn('Failed to retrieve dream context', {
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
