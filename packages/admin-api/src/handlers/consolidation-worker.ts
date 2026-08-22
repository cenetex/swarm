/**
 * Memory Consolidation Worker
 *
 * Scheduled Lambda that runs memory consolidation for all avatars.
 * Triggered by EventBridge on a daily schedule.
 *
 * Consolidation steps per avatar:
 * 1. Apply decay to recent and core memory tiers
 * 2. Promote overflow from immediate to recent tier
 * 3. Generate identity evolution statement (optional)
 *
 * @see memory-consolidation.ts for business logic
 */
import type { TimerEvent, ExecutionContext } from "@swarm/core";
import { logger } from '@swarm/core';
import { consolidateAllAvatars, type BatchConsolidationResult } from '../services/memory-consolidation.js';

/**
 * Handler for scheduled memory consolidation
 *
 * Triggered by EventBridge rule (e.g., daily at 3 AM UTC)
 */
export async function handler(
  event: TimerEvent,
  context: ExecutionContext
): Promise<BatchConsolidationResult> {
  logger.setContext({
    subsystem: 'memory-consolidation',
    requestId: context.awsRequestId,
  });

  logger.info('Starting scheduled memory consolidation', {
    event: 'consolidation_scheduled_start',
    eventSource: event.source,
    eventTime: event.time,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  });

  const startTime = Date.now();

  try {
    // Calculate max avatars based on remaining time
    // Allow ~5 seconds per avatar, reserve 30 seconds for cleanup
    const remainingMs = context.getRemainingTimeInMillis();
    const maxAvatars = Math.max(1, Math.floor((remainingMs - 30000) / 5000));

    const result = await consolidateAllAvatars({
      maxAvatars,
      // Skip identity evolution if we're short on time
      skipIdentity: remainingMs < 120000, // < 2 min remaining
    });

    logger.info('Scheduled memory consolidation complete', {
      event: 'consolidation_scheduled_complete',
      ...result,
      executionTimeMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    logger.error('Scheduled memory consolidation failed', error, {
      event: 'consolidation_scheduled_error',
      executionTimeMs: Date.now() - startTime,
    });

    // Return a failed result rather than throwing
    // This prevents Lambda retries for a failed consolidation batch
    return {
      totalAvatars: 0,
      processed: 0,
      succeeded: 0,
      failed: 1,
      skipped: 0,
      results: [],
      durationMs: Date.now() - startTime,
    };
  }
}
