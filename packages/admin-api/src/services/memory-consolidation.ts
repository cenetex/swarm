/**
 * Memory Consolidation Service
 *
 * Orchestrates scheduled memory consolidation for avatars:
 * - Apply decay to recent and core tiers
 * - Promote immediate → recent when overflow
 * - Extract patterns and generate identity evolution
 *
 * Designed to be called by EventBridge on a schedule (e.g., daily).
 *
 * @module memory-consolidation
 */
import { logger, MetricsLogger, getEnvironmentDimension } from '@swarm/core';
import {
  applyDecay,
  promoteImmediateToRecent,
  getMemories,
  getIdentity,
  saveIdentitySnapshot,
  getMemoryCounts,
  pruneGraph,
  DEFAULT_CONFIG,
} from './memory.js';
import type { AvatarMemory } from '../types.js';
import type { GraphPruneConfig } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

const LLM_API_KEY = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
const LLM_MODEL = process.env.CONSOLIDATION_MODEL || 'anthropic/claude-3-5-haiku-latest';

/** Minimum memories required to attempt identity evolution */
const MIN_MEMORIES_FOR_IDENTITY = 5;

/** Maximum avatars to consolidate per invocation (for Lambda timeout safety) */
const MAX_AVATARS_PER_RUN = 50;

/** CloudWatch metric namespace for consolidation metrics */
const METRICS_NAMESPACE = 'AwsSwarm/MemoryConsolidation';

/**
 * Create a MetricsLogger for consolidation, pre-configured with the
 * AwsSwarm/MemoryConsolidation namespace and Environment dimension.
 */
export function createConsolidationMetrics(): MetricsLogger {
  return new MetricsLogger('MemoryConsolidation', {
    namespace: METRICS_NAMESPACE,
    dimensions: { Environment: getEnvironmentDimension() },
  });
}

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationResult {
  avatarId: string;
  success: boolean;
  decay: {
    recent: { decayed: number; pruned: number };
    core: { decayed: number; pruned: number };
  };
  promotion: { promoted: number };
  graph?: {
    decayed: number;
    pruned: number;
    orphansRemoved: number;
  };
  identity?: {
    generated: boolean;
    statement?: string;
    error?: string;
  };
  durationMs: number;
  error?: string;
}

export interface BatchConsolidationResult {
  totalAvatars: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: ConsolidationResult[];
  durationMs: number;
}

export interface ConsolidationOptions {
  /** Skip identity evolution generation */
  skipIdentity?: boolean;
  /** Force consolidation even if recently consolidated */
  force?: boolean;
  /** Custom decay rate (default: 0.95) */
  decayRate?: number;
  /** Skip graph pruning */
  skipGraphPrune?: boolean;
  /** Custom graph pruning config */
  graphConfig?: Partial<GraphPruneConfig>;
}

// ============================================================================
// Identity Evolution
// ============================================================================

/**
 * Generate an identity evolution statement based on recent memories
 *
 * Uses Haiku to analyze patterns in memories and generate an "I am becoming..."
 * statement that captures the avatar's evolution.
 */
async function generateIdentityEvolution(
  avatarId: string,
  recentMemories: AvatarMemory[],
  currentIdentity: AvatarMemory[],
  apiKey?: string
): Promise<{ statement: string } | { error: string }> {
  const llmApiKey = apiKey || LLM_API_KEY;

  if (!llmApiKey) {
    return { error: 'No LLM API key configured' };
  }

  if (recentMemories.length < MIN_MEMORIES_FOR_IDENTITY) {
    return { error: `Not enough memories (${recentMemories.length} < ${MIN_MEMORIES_FOR_IDENTITY})` };
  }

  // Format memories for the prompt
  const memoryLines = recentMemories
    .slice(0, 20)
    .map(m => `- ${m.content}${m.about ? ` (about: ${m.about})` : ''}`)
    .join('\n');

  const currentIdentityLines = currentIdentity
    .map(m => `- ${m.content}`)
    .join('\n') || '(No previous identity statements)';

  const prompt = `You are analyzing an avatar's recent memories to understand how they are evolving.

## Current Identity
${currentIdentityLines}

## Recent Memories
${memoryLines}

Based on these memories, generate a single "I am becoming..." statement that captures how this avatar is evolving. The statement should:
- Be introspective and personal (first person)
- Reflect patterns or themes in the memories
- Be concise (one sentence, under 100 characters)
- Feel authentic, not generic

Respond with ONLY the statement, nothing else.`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`,
        'HTTP-Referer': 'https://swarm.rati.chat',
        'X-Title': 'AWS Swarm Memory Consolidation',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'user', content: prompt },
        ],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Identity evolution LLM call failed', {
        event: 'identity_evolution_llm_error',
        avatarId,
        status: response.status,
        error: errorText.slice(0, 200),
      });
      return { error: `LLM call failed: ${response.status}` };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const statement = data.choices?.[0]?.message?.content?.trim();

    if (!statement) {
      return { error: 'Empty response from LLM' };
    }

    // Validate it looks like an identity statement
    const normalized = statement.toLowerCase();
    if (!normalized.startsWith('i am') && !normalized.startsWith('i\'m')) {
      // Try to extract if it's wrapped in quotes or has extra text
      const match = statement.match(/"([^"]+)"/);
      if (match) {
        return { statement: match[1] };
      }
      return { statement }; // Return anyway, it might still be valid
    }

    return { statement };
  } catch (error) {
    logger.error('Identity evolution generation failed', {
      event: 'identity_evolution_error',
      avatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============================================================================
// Consolidation Orchestration
// ============================================================================

/**
 * Consolidate a single avatar's memories
 *
 * 1. Apply decay to recent and core tiers
 * 2. Promote overflow from immediate to recent
 * 3. Generate identity evolution (optional)
 */
export async function consolidateAvatar(
  avatarId: string,
  options: ConsolidationOptions = {}
): Promise<ConsolidationResult> {
  const startTime = Date.now();
  const decayRate = options.decayRate ?? DEFAULT_CONFIG.decayRate;

  const result: ConsolidationResult = {
    avatarId,
    success: false,
    decay: {
      recent: { decayed: 0, pruned: 0 },
      core: { decayed: 0, pruned: 0 },
    },
    promotion: { promoted: 0 },
    durationMs: 0,
  };

  try {
    // 1. Apply decay to recent tier
    result.decay.recent = await applyDecay(avatarId, 'recent', decayRate);

    // 2. Apply decay to core tier (slower decay)
    result.decay.core = await applyDecay(avatarId, 'core', Math.sqrt(decayRate)); // ~0.975

    // 3. Promote immediate → recent
    result.promotion = await promoteImmediateToRecent(avatarId);

    // 4. Generate identity evolution (if enabled and enough memories)
    if (!options.skipIdentity) {
      const [recentMemories, currentIdentity] = await Promise.all([
        getMemories(avatarId, { tier: 'recent', limit: 30 }),
        getIdentity(avatarId),
      ]);

      const identityResult = await generateIdentityEvolution(
        avatarId,
        recentMemories,
        currentIdentity
      );

      if ('statement' in identityResult) {
        // Save the identity snapshot
        const previousStatement = currentIdentity[0]?.content;
        const triggeringMemoryIds = recentMemories.slice(0, 5).map(m => m.id);

        await saveIdentitySnapshot(
          avatarId,
          identityResult.statement,
          triggeringMemoryIds,
          previousStatement
        );

        result.identity = {
          generated: true,
          statement: identityResult.statement,
        };

        logger.info('Identity evolution generated', {
          event: 'identity_evolution_generated',
          avatarId,
          statement: identityResult.statement,
        });
      } else {
        result.identity = {
          generated: false,
          error: identityResult.error,
        };
      }
    }

    // 5. Prune memory graph (if enabled)
    if (!options.skipGraphPrune) {
      try {
        result.graph = await pruneGraph(avatarId, options.graphConfig);
      } catch (graphError) {
        logger.warn('Graph pruning failed (non-fatal)', {
          event: 'graph_prune_error',
          avatarId,
          error: graphError instanceof Error ? graphError.message : 'Unknown',
        });
        result.graph = { decayed: 0, pruned: 0, orphansRemoved: 0 };
      }
    }

    result.success = true;

    logger.info('Avatar consolidation complete', {
      event: 'consolidation_complete',
      avatarId,
      decay: result.decay,
      promotion: result.promotion,
      graph: result.graph,
      identityGenerated: result.identity?.generated ?? false,
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Avatar consolidation failed', {
      event: 'consolidation_error',
      avatarId,
      error: result.error,
    });
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * Get list of avatar IDs that need consolidation
 *
 * In the future, this could check last consolidation time and skip
 * recently consolidated avatars.
 */
async function getAvatarsNeedingConsolidation(limit: number): Promise<string[]> {
  // Import dynamically to avoid circular dependency
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');

  const ADMIN_TABLE = process.env.ADMIN_TABLE;
  if (!ADMIN_TABLE) {
    throw new Error('ADMIN_TABLE environment variable not set');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  // Scan for avatars (pk starts with AVATAR#, sk = CONFIG)
  // DynamoDB Limit restricts items *evaluated*, not items *returned after filter*.
  // We must paginate to ensure we find all matching avatars.
  const avatarIds: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
      ExpressionAttributeValues: {
        ':prefix': 'AVATAR#',
        ':sk': 'CONFIG',
      },
      ProjectionExpression: 'pk',
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const item of result.Items || []) {
      const pk = item.pk as string;
      avatarIds.push(pk.replace('AVATAR#', ''));
      if (avatarIds.length >= limit) break;
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey && avatarIds.length < limit);

  logger.info('Avatars discovered for consolidation', {
    event: 'consolidation_avatar_discovery',
    avatarCount: avatarIds.length,
    limit,
    avatarIds,
  });

  return avatarIds;
}

/**
 * Consolidate all avatars (batch operation)
 *
 * Called by the scheduled Lambda handler. Processes avatars sequentially
 * to avoid overwhelming DynamoDB.
 */
export async function consolidateAllAvatars(
  options: ConsolidationOptions & { maxAvatars?: number } = {}
): Promise<BatchConsolidationResult> {
  const startTime = Date.now();
  const maxAvatars = options.maxAvatars ?? MAX_AVATARS_PER_RUN;

  const result: BatchConsolidationResult = {
    totalAvatars: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
    durationMs: 0,
  };

  const metrics = createConsolidationMetrics();

  try {
    // Get avatars needing consolidation
    const avatarIds = await getAvatarsNeedingConsolidation(maxAvatars);
    result.totalAvatars = avatarIds.length;

    // Emit discovery metric
    metrics.putMetric('AvatarsDiscovered', avatarIds.length, 'Count');
    metrics.flush();

    logger.info('Starting batch consolidation', {
      event: 'batch_consolidation_start',
      avatarCount: avatarIds.length,
      maxAvatars,
    });

    // Process sequentially to avoid thundering herd
    for (const avatarId of avatarIds) {
      try {
        // Check if avatar has any memories (skip if empty)
        // Use getMemoryCounts (COUNT queries) instead of getMemoryStats
        // to avoid fetching up to 300 memory items just for a skip check
        const counts = await getMemoryCounts(avatarId);
        const totalMemories = counts.immediate + counts.recent + counts.core
          + counts.ephemeral + counts.durable + counts.archival;

        if (totalMemories === 0) {
          result.skipped++;
          logger.info('Skipping avatar consolidation: no memories', {
            event: 'consolidation_avatar_skipped',
            avatarId,
            reason: 'no_memories',
            counts,
          });
          continue;
        }

        logger.info('Starting avatar consolidation', {
          event: 'consolidation_avatar_start',
          avatarId,
          totalMemories,
          counts,
        });

        const avatarResult = await consolidateAvatar(avatarId, options);
        result.results.push(avatarResult);
        result.processed++;

        if (avatarResult.success) {
          result.succeeded++;
        } else {
          result.failed++;
          logger.warn('Avatar consolidation did not succeed', {
            event: 'consolidation_avatar_failed',
            avatarId,
            error: avatarResult.error,
            durationMs: avatarResult.durationMs,
          });
        }

        // Small delay between avatars to be nice to DynamoDB
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        result.failed++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Avatar consolidation threw unexpected error', {
          event: 'consolidation_avatar_exception',
          avatarId,
          error: errorMessage,
        });
        result.results.push({
          avatarId,
          success: false,
          decay: { recent: { decayed: 0, pruned: 0 }, core: { decayed: 0, pruned: 0 } },
          promotion: { promoted: 0 },
          durationMs: 0,
          error: errorMessage,
        });
      }
    }

    logger.info('Batch consolidation complete', {
      event: 'batch_consolidation_complete',
      totalAvatars: result.totalAvatars,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
    });
  } catch (error) {
    logger.error('Batch consolidation failed', {
      event: 'batch_consolidation_error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  result.durationMs = Date.now() - startTime;

  // Emit batch-completion metrics
  metrics.putMetric('AvatarsProcessed', result.processed, 'Count');
  metrics.putMetric('AvatarsSkipped', result.skipped, 'Count');
  metrics.putMetric('AvatarsFailed', result.failed, 'Count');
  metrics.putMetric('ConsolidationDurationMs', result.durationMs, 'Milliseconds');
  metrics.setProperty('totalAvatars', result.totalAvatars);
  metrics.setProperty('succeeded', result.succeeded);
  metrics.flush();

  return result;
}

// ============================================================================
// Manual Trigger (for admin tools)
// ============================================================================

/**
 * Trigger consolidation for a specific avatar (for admin chat tool)
 */
export async function triggerConsolidation(
  avatarId: string,
  options: ConsolidationOptions = {}
): Promise<ConsolidationResult> {
  logger.info('Manual consolidation triggered', {
    event: 'manual_consolidation_trigger',
    avatarId,
    options,
  });

  return consolidateAvatar(avatarId, options);
}
