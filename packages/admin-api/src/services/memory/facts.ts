/**
 * Memory Service — High-Level Facts API
 *
 * remember(), recall(), getMemoryContext(), getMemoryContextForQuery(),
 * and getMemoryStats(). These are the primary entry points used by
 * MCP tools and chat handlers.
 *
 * @module memory/facts
 */
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryTier,
} from '../../types.js';
import {
  promiseAllWithTimeout,
} from '../promise-timeout.js';
import {
  validateAvatarId,
  validateContent,
  getRetentionDaysForAvatar,
} from './shared.js';
import { createMemory, reinforceMemory } from './crud.js';
import { getMemories, getMemoryCounts } from './search.js';
import { recallAbout, searchMemories, getCoreMemories, getIdentity } from './search.js';
import { promoteImmediateToRecent } from './tiers.js';
import { autoLinkMemory } from './graph.js';

// ============================================================================
// High-Level Memory API (for MCP tools)
// ============================================================================

/**
 * Remember a fact (creates immediate memory, reinforces if similar exists)
 *
 * @param avatarId - The avatar's unique identifier
 * @param fact - The fact to remember
 * @param about - Who or what this fact is about
 * @param userId - Associated user ID
 * @returns Result with saved status and memory ID
 */
export async function remember(
  avatarId: string,
  fact: string,
  about?: string,
  userId?: string
): Promise<{ saved: boolean; memoryId: string; reinforced?: boolean }> {
  const validAvatarId = validateAvatarId(avatarId);
  const validFact = validateContent(fact);

  // Look up retention days for TTL enforcement
  const retentionDays = await getRetentionDaysForAvatar(validAvatarId);

  // Check for similar existing memory to reinforce
  if (about) {
    const existing = await recallAbout(validAvatarId, about, 5);
    const factLower = validFact.toLowerCase();

    const similar = existing.find(m => {
      const contentLower = m.content.toLowerCase();
      // Check for significant overlap (>50% of shorter string)
      const shorter = Math.min(factLower.length, contentLower.length);
      const overlapThreshold = Math.floor(shorter * 0.5);

      return (
        contentLower.includes(factLower.slice(0, overlapThreshold)) ||
        factLower.includes(contentLower.slice(0, overlapThreshold))
      );
    });

    if (similar) {
      await reinforceMemory(validAvatarId, similar.id, similar.sk);
      return { saved: true, memoryId: similar.id, reinforced: true };
    }
  }

  // Create new immediate memory with TTL based on avatar's retention config
  const memory = await createMemory(validAvatarId, {
    tier: 'immediate',
    type: about ? 'fact' : 'event',
    content: validFact,
    about: about?.trim(),
    userId: userId?.trim(),
    retentionDays,
  });

  // Auto-link to related memories via graph edges (async, don't block)
  autoLinkMemory(validAvatarId, memory, { retentionDays }).catch(err => {
    logger.warn('Background auto-link failed', {
      event: 'auto_link_background_error',
      avatarId: validAvatarId,
      memoryId: memory.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  });

  // Check if we need to promote memories (async, don't block)
  promoteImmediateToRecent(validAvatarId).catch(err => {
    logger.warn('Background promotion failed', {
      event: 'memory_promotion_background_error',
      avatarId: validAvatarId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  });

  return { saved: true, memoryId: memory.id };
}

/**
 * Recall facts (searches across all tiers)
 *
 * @param avatarId - The avatar's unique identifier
 * @param query - Search query string
 * @param userId - Filter by user ID
 * @returns Array of matching facts with metadata
 */
export async function recall(
  avatarId: string,
  query: string,
  userId?: string
): Promise<{ facts: Array<{ fact: string; about?: string; timestamp: number; strength: number }> }> {
  const startMs = Date.now();
  const validAvatarId = validateAvatarId(avatarId);
  const memories = await searchMemories(validAvatarId, query, 10);

  // Filter by userId if provided
  const filtered = userId
    ? memories.filter(m => !m.userId || m.userId === userId)
    : memories;

  logger.info('Recall completed', {
    event: 'memory_recall',
    avatarId: validAvatarId,
    query: query.slice(0, 50),
    resultCount: filtered.length,
    totalLatencyMs: Date.now() - startMs,
  });

  return {
    facts: filtered.map(m => ({
      fact: m.content,
      about: m.about,
      timestamp: m.createdAt,
      strength: m.strength,
    })),
  };
}

/**
 * Get memory context for prompt injection
 * Formats memories into a human-readable string for the LLM
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Formatted memory context string
 */
export async function getMemoryContext(avatarId: string): Promise<string> {
  const startMs = Date.now();
  const validAvatarId = validateAvatarId(avatarId);

  const [coreMemories, recentMemories, identity] = await promiseAllWithTimeout([
    getCoreMemories(validAvatarId),
    getMemories(validAvatarId, { tier: 'recent', limit: 10 }),
    getIdentity(validAvatarId),
  ], undefined, 'getMemoryContext');

  const sections: string[] = [];

  // Identity section
  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Core learnings and patterns
  const learnings = coreMemories.filter(m => m.type === 'learning' || m.type === 'pattern');
  if (learnings.length > 0) {
    sections.push('\n## What I\'ve Learned');
    for (const mem of learnings.slice(0, 5)) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Relationships
  const relationships = coreMemories.filter(m => m.type === 'relationship');
  if (relationships.length > 0) {
    sections.push('\n## People I Know');
    for (const mem of relationships.slice(0, 5)) {
      const aboutStr = mem.about ? ` (${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  // Recent experiences
  if (recentMemories.length > 0) {
    sections.push('\n## Recent Experiences');
    for (const mem of recentMemories.slice(0, 5)) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  logger.info('Memory context built', {
    event: 'memory_context_built',
    avatarId: validAvatarId,
    retrievalMethod: 'deterministic',
    coreCount: coreMemories.length,
    recentCount: recentMemories.length,
    identityCount: identity.length,
    totalLatencyMs: Date.now() - startMs,
  });

  return sections.length > 0 ? sections.join('\n') : '';
}

/**
 * Get memory context for prompt injection, tailored to the current user query.
 *
 * This is a higher-signal variant of getMemoryContext(): it uses semantic search
 * to surface the most relevant memories, then formats them consistently for
 * prompt injection.
 */
export async function getMemoryContextForQuery(
  avatarId: string,
  query: string,
  options: {
    limit?: number;
    minSimilarity?: number;
    maxChars?: number;
  } = {}
): Promise<string> {
  const startMs = Date.now();
  const validAvatarId = validateAvatarId(avatarId);
  const queryText = query.trim();
  if (!queryText) {
    return getMemoryContext(validAvatarId);
  }

  const limit = Math.min(options.limit ?? 12, 25);
  const minSimilarity = options.minSimilarity ?? 0.28;
  const maxChars = options.maxChars ?? 2400;

  const [identity, relevant] = await promiseAllWithTimeout([
    getIdentity(validAvatarId),
    searchMemories(validAvatarId, queryText, limit, { semanticSearch: true, minSimilarity }),
  ], undefined, 'getMemoryContextForQuery');

  const sections: string[] = [];

  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  const identityIds = new Set(identity.map((m) => m.id));
  const picked = relevant
    .filter((m) => !identityIds.has(m.id))
    .slice(0, limit);

  if (picked.length > 0) {
    sections.push('\n## Relevant Memories');
    for (const mem of picked) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  const out = sections.length > 0 ? sections.join('\n') : '';

  logger.info('Query-tailored memory context built', {
    event: 'memory_context_for_query_built',
    avatarId: validAvatarId,
    retrievalMethod: 'semantic',
    query: queryText.slice(0, 50),
    identityCount: identity.length,
    relevantCount: picked.length,
    totalLatencyMs: Date.now() - startMs,
  });

  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// ============================================================================
// Statistics & Diagnostics
// ============================================================================

/**
 * Get comprehensive memory statistics for an avatar
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Memory statistics
 */
export async function getMemoryStats(avatarId: string): Promise<{
  counts: Record<MemoryTier, number>;
  totalMemories: number;
  averageStrength: Record<MemoryTier, number>;
  oldestMemory?: { tier: MemoryTier; createdAt: number };
  newestMemory?: { tier: MemoryTier; createdAt: number };
}> {
  const validAvatarId = validateAvatarId(avatarId);
  const counts = await getMemoryCounts(validAvatarId);
  const totalMemories = counts.immediate + counts.recent + counts.core + counts.ephemeral + counts.durable + counts.archival;

  // Get memories for average strength calculation
  const [immediate, recent, core] = await promiseAllWithTimeout([
    getMemories(validAvatarId, { tier: 'immediate', limit: 100 }),
    getMemories(validAvatarId, { tier: 'recent', limit: 100 }),
    getMemories(validAvatarId, { tier: 'core', limit: 100 }),
  ], undefined, 'getMemoryStats');

  const avgStrength = (memories: AvatarMemory[]) =>
    memories.length > 0
      ? memories.reduce((sum, m) => sum + m.strength, 0) / memories.length
      : 0;

  // Find oldest and newest
  const allMemories = [...immediate, ...recent, ...core];
  let oldestMemory: { tier: MemoryTier; createdAt: number } | undefined;
  let newestMemory: { tier: MemoryTier; createdAt: number } | undefined;

  for (const m of allMemories) {
    if (!oldestMemory || m.createdAt < oldestMemory.createdAt) {
      oldestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
    if (!newestMemory || m.createdAt > newestMemory.createdAt) {
      newestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
  }

  return {
    counts,
    totalMemories,
    averageStrength: {
      immediate: avgStrength(immediate),
      recent: avgStrength(recent),
      core: avgStrength(core),
      ephemeral: 0,
      durable: 0,
      archival: 0,
    },
    oldestMemory,
    newestMemory,
  };
}
