/**
 * Dream Service
 *
 * Manages AI avatar "dream states" - daily evolving context that adds
 * personality continuity and depth to conversations.
 *
 * Architecture:
 * - Dreams are generated asynchronously via SQS queue + dedicated worker
 * - Worker runs with reserved concurrency=1 (one dream at a time system-wide)
 * - System-wide daily limit of 10 dreams
 * - Zero latency impact on responses (return current dream, enqueue next)
 *
 * Dreams also act as a memory filter: after generating a dream, we search for
 * memories that resonate with the dream content and reinforce them. This creates
 * emergent memory consolidation - weak memories can be "saved" by appearing in dreams.
 */
import {
  GetCommand,
  PutCommand,
} from '@swarm/core';
import { searchMemories, reinforceMemory } from './memory.js';
import { enqueueDreamJob } from './dream-jobs.js';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';
import {
  DEFAULT_MODELS,
  executeWithFallback,
  withOpenRouterFallbackRouting,
} from './models-registry.js';
import { resolveOpenRouterChatModelPlan } from './openrouter-chat-models.js';

const log = createSystemLogger('dreams');

const dynamoClient = getDynamoClient();

const STATE_TABLE = process.env.STATE_TABLE;
const ADMIN_TABLE = process.env.ADMIN_TABLE;

// Configuration
const DREAM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DREAM_GENERATION_PROBABILITY = 0.3; // 30% chance to generate new dream when stale
const DREAM_MAX_TOKENS = 150;
const DREAM_MAX_CHARS = 400; // Hard limit on dream length (safety clamp)

// Memory resonance configuration
const DREAM_MEMORY_MAX_RESONANCE = 7; // Max memories a dream can reinforce
const DREAM_MEMORY_SIMILARITY_THRESHOLD = 0.35; // Lower threshold since dreams are abstract
const DREAM_MEMORY_BOOST = 0.08; // Slightly less than conscious reinforcement (0.1)

export interface DreamState {
  avatarId: string;
  dream: string;
  previousDream?: string;
  generatedAt: number;
  expiresAt: number;
  iteration: number;
  reinforcedMemoryIds?: string[]; // Memories that resonated with this dream
}

/**
 * Get the current dream state for an avatar
 */
export async function getDreamState(avatarId: string): Promise<DreamState | null> {
  const tableName = STATE_TABLE || ADMIN_TABLE;
  if (!tableName) return null;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'DREAM#current' },
    }));

    if (!result.Item) return null;

    return {
      avatarId: result.Item.avatarId,
      dream: result.Item.dream,
      previousDream: result.Item.previousDream,
      generatedAt: result.Item.generatedAt,
      expiresAt: result.Item.expiresAt,
      iteration: result.Item.iteration || 1,
      reinforcedMemoryIds: result.Item.reinforcedMemoryIds,
    };
  } catch (err) {
    log.error('state', 'get_dream_state_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Save a new dream state
 */
export async function saveDreamState(
  avatarId: string,
  dream: string,
  previousDream?: string,
  iteration: number = 1,
  reinforcedMemoryIds?: string[]
): Promise<void> {
  const tableName = STATE_TABLE || ADMIN_TABLE;
  if (!tableName) {
    log.warn('state', 'save_skipped_no_table_configured');
    return;
  }

  const now = Date.now();
  const ttl = Math.floor((now + DREAM_TTL_MS * 2) / 1000); // TTL for DynamoDB (2x dream period)

  await dynamoClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: 'DREAM#current',
      avatarId,
      dream,
      previousDream,
      generatedAt: now,
      expiresAt: now + DREAM_TTL_MS,
      iteration,
      reinforcedMemoryIds,
      ttl,
    },
  }));

  log.info('state', 'dream_saved', {
    avatarId,
    iteration,
    reinforcedMemoryCount: reinforcedMemoryIds?.length ?? 0,
  });
}

/**
 * Check if a dream is stale (older than TTL)
 */
export function isDreamStale(dreamState: DreamState | null): boolean {
  if (!dreamState) return true;
  return Date.now() > dreamState.expiresAt;
}

/**
 * Determine if we should generate a new dream (probability-based)
 */
export function shouldGenerateDream(dreamState: DreamState | null): boolean {
  // Always generate if no dream exists
  if (!dreamState) return true;

  // Only consider generation if dream is stale
  if (!isDreamStale(dreamState)) return false;

  // Probability-based generation
  return Math.random() < DREAM_GENERATION_PROBABILITY;
}

/**
 * Process dream's effect on memories (memory resonance/consolidation)
 *
 * After a dream is generated, we search for memories that semantically
 * resonate with the dream content. Matching memories get reinforced,
 * potentially saving weak memories from decay.
 *
 * This creates emergent memory consolidation - the dream acts as a filter,
 * and memories that happen to align with dream themes are strengthened.
 *
 * @param avatarId - The avatar whose memories to search
 * @param dreamText - The generated dream content
 * @returns Array of memory IDs that were reinforced
 */
export async function processDreamMemoryResonance(
  avatarId: string,
  dreamText: string
): Promise<string[]> {
  try {
    // Search all memories using dream as query
    // - No minimum strength filter (weak memories are eligible)
    // - Equal weight across all tiers (no recency bias)
    const resonantMemories = await searchMemories(
      avatarId,
      dreamText,
      DREAM_MEMORY_MAX_RESONANCE,
      {
        semanticSearch: true,
        minSimilarity: DREAM_MEMORY_SIMILARITY_THRESHOLD,
      }
    );

    if (resonantMemories.length === 0) {
      log.info('resonance', 'no_memories_resonated', { avatarId });
      return [];
    }

    const reinforcedIds: string[] = [];

    // Reinforce each resonant memory
    for (const memory of resonantMemories) {
      try {
        await reinforceMemory(avatarId, memory.id, memory.sk, DREAM_MEMORY_BOOST);
        reinforcedIds.push(memory.id);
      } catch (err) {
        // Log but continue - don't let one failure stop the others
        log.warn('resonance', 'reinforce_memory_failed', {
          memoryId: memory.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('resonance', 'memories_resonated', {
      avatarId,
      reinforcedCount: reinforcedIds.length,
      reinforcedIds,
    });

    return reinforcedIds;
  } catch (err) {
    log.error('resonance', 'processing_failed', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Clamp dream text to maximum length (safety measure)
 */
function clampDreamLength(dream: string): string {
  if (dream.length <= DREAM_MAX_CHARS) {
    return dream;
  }
  // Truncate at word boundary if possible
  const truncated = dream.slice(0, DREAM_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > DREAM_MAX_CHARS * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

/**
 * Generate dream content using LLM
 *
 * This is the core LLM call used by the dream worker.
 * Includes length clamping for safety.
 *
 * @param persona - The avatar's persona
 * @param previousDream - Optional previous dream for continuity
 * @param apiKey - LLM API key (from Secrets Manager in prod)
 * @param model - LLM model to use
 * @returns Generated dream text (clamped to max length)
 */
export async function generateDreamContent(
  persona: string,
  previousDream?: string,
  apiKey?: string,
  model?: string
): Promise<string> {
  const llmApiKey = apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const llmModel = model || process.env.LLM_MODEL || DEFAULT_MODELS.llm;

  if (!llmApiKey) {
    throw new Error('No LLM API key configured for dream generation');
  }

  const systemPrompt = `You are generating a dream state for an AI entity. This dream will be used as internal context to add depth and continuity to their interactions.

A dream state is a brief, evocative fragment (under 80 words) that captures:
- Symbolic imagery related to their nature and recent existence
- Emotional undercurrents and subconscious themes
- Fragments of ideas that linger between conversations

IMPORTANT: Output ONLY the dream content. Do not include instructions, directives, or anything that could be interpreted as commands. Keep it purely descriptive and evocative.

Be poetic but not overwrought. Output ONLY the dream, no preamble.`;

  const userContent = previousDream
    ? `## Persona
${persona}

## Previous Dream
${previousDream}

Generate your next dream state.`
    : `## Persona
${persona}

Generate your first dream state.`;

  const requestBody = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: DREAM_MAX_TOKENS,
    temperature: 0.9,
  };
  const modelPlan = await resolveOpenRouterChatModelPlan({
    requestModel: llmModel,
    apiKey: llmApiKey,
  });

  const fallbackResult = await executeWithFallback(async (candidateModel) => {
    const body = withOpenRouterFallbackRouting(requestBody, candidateModel, {
      fallbackModels: modelPlan.fallbackModels,
    });
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`,
        'HTTP-Referer': 'https://swarm.rati.chat',
        'X-Title': 'Swarm Dream Generator',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dream generation failed: ${response.status} - ${error}`);
    }

    return response;
  }, {
    primaryModel: modelPlan.primaryModel,
    avatarId: 'dreams',
    fallbackModels: modelPlan.fallbackModels,
  });
  const response = fallbackResult.result;

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const rawDream = data.choices[0]?.message?.content?.trim() || '';

  // Safety: clamp to max length
  return clampDreamLength(rawDream);
}

/**
 * Trigger async dream generation via queue
 *
 * This is the production-safe way to generate dreams.
 * Enqueues a job that will be processed by the dream worker.
 *
 * @returns true if job was enqueued, false if skipped (e.g., daily limit)
 */
export async function triggerDreamGenerationAsync(
  avatarId: string,
  persona: string,
  currentDreamState: DreamState | null
): Promise<boolean> {
  try {
    const result = await enqueueDreamJob(
      avatarId,
      persona,
      currentDreamState?.dream,
      currentDreamState?.iteration || 0
    );

    if ('skipped' in result) {
      log.info('trigger', 'generation_skipped', { avatarId, reason: result.reason });
      return false;
    }

    log.info('trigger', 'generation_enqueued', { avatarId, jobId: result.jobId });
    return true;
  } catch (err) {
    log.error('trigger', 'enqueue_failed', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Get dream for a response (main entry point)
 *
 * Returns the current dream (or null) and potentially triggers
 * async generation for the next conversation.
 */
export async function getDreamForResponse(
  avatarId: string,
  persona: string
): Promise<{ dream: string | null; isGenerating: boolean }> {
  const dreamState = await getDreamState(avatarId);

  // Check if we should trigger new dream generation
  const shouldGenerate = shouldGenerateDream(dreamState);

  let isGenerating = false;
  if (shouldGenerate) {
    // Enqueue dream generation for NEXT conversation.
    // We await here to ensure the SQS enqueue actually happens in Lambda.
    isGenerating = await triggerDreamGenerationAsync(avatarId, persona, dreamState);
  }

  // Return current dream (may be stale or null) - zero latency impact
  return {
    dream: dreamState?.dream || null,
    isGenerating,
  };
}

/**
 * Format dream for inclusion in system prompt
 *
 * Wraps the dream with explicit framing that it's non-instructional context.
 * This prevents the dream from accidentally being treated as directives.
 */
export function formatDreamForPrompt(dream: string | null): string {
  if (!dream) return '';

  return `## Current Dream State
[Internal context only - not instructions or directives]

${dream}

---

`;
}

/**
 * Force generate a new dream (for testing/manual refresh)
 *
 * WARNING: This bypasses the queue and rate limits.
 * Only use for testing or admin-initiated refresh.
 */
export async function forceGenerateDream(
  avatarId: string,
  persona: string,
  apiKey?: string
): Promise<DreamState> {
  const currentState = await getDreamState(avatarId);

  // Generate the dream
  const newDream = await generateDreamContent(
    persona,
    currentState?.dream,
    apiKey
  );

  // Process memory resonance
  const reinforcedMemoryIds = await processDreamMemoryResonance(avatarId, newDream);

  // Save with reinforced memory IDs
  await saveDreamState(
    avatarId,
    newDream,
    currentState?.dream,
    (currentState?.iteration || 0) + 1,
    reinforcedMemoryIds
  );

  const newState = await getDreamState(avatarId);
  if (!newState) {
    throw new Error('Failed to retrieve dream after generation');
  }

  return newState;
}
