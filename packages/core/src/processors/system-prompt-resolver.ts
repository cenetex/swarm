/**
 * System Prompt Resolver
 *
 * When an avatar has a `systemPromptOverride` set, this resolver short-circuits
 * the prompt-builder template stack and returns the override content instead.
 *
 * - `kind: 'inline'` — returned verbatim.
 * - `kind: 'url'`    — fetched at request time with a short in-memory cache
 *                      per Lambda instance. Fetch failures fall back to the
 *                      assembled template (fail-closed — never block a reply).
 *
 * See aws-swarm#1522.
 */
import { logger } from '../utils/logger.js';
import type { Platform } from '../types/platform.js';
import type { ProcessorAvatarConfig } from './types.js';
import { buildDynamicSystemPrompt, type RuntimeContext } from './prompt-builder.js';

const DEFAULT_CACHE_TTL_SEC = 300;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CONTENT_BYTES = 512 * 1024; // 512 KiB

interface CacheEntry {
  text: string;
  expiresAt: number;
}

// Per-instance in-memory cache. Warm Lambdas share entries across invocations;
// a cold start re-fetches. This is intentional — no distributed cache, no DDB
// round-trip, so the override path stays fast when the bot is busy.
const urlCache = new Map<string, CacheEntry>();

async function fetchPromptFromUrl(url: string, ttlSec: number): Promise<string | null> {
  const cached = urlCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.text;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain, text/markdown, */*' },
    });
    if (!response.ok) {
      logger.warn('systemPromptOverride URL returned non-2xx', {
        event: 'prompt_override_fetch_non_ok',
        subsystem: 'prompt-builder',
        url,
        status: response.status,
      });
      return null;
    }
    const text = await response.text();
    if (text.length > MAX_CONTENT_BYTES) {
      logger.warn('systemPromptOverride URL content exceeds size cap; truncating', {
        event: 'prompt_override_truncated',
        subsystem: 'prompt-builder',
        url,
        bytes: text.length,
        cap: MAX_CONTENT_BYTES,
      });
    }
    const truncated = text.slice(0, MAX_CONTENT_BYTES);
    urlCache.set(url, { text: truncated, expiresAt: Date.now() + ttlSec * 1000 });
    return truncated;
  } catch (err) {
    logger.warn('systemPromptOverride URL fetch failed', {
      event: 'prompt_override_fetch_error',
      subsystem: 'prompt-builder',
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the effective system prompt for an avatar + request.
 *
 * If an override is set and usable, returns it. Otherwise falls through to
 * `buildDynamicSystemPrompt` with the supplied platform + context.
 */
export async function resolveSystemPrompt(
  avatar: ProcessorAvatarConfig,
  platform: Platform | 'admin-ui' | 'api' | 'mcp' = 'admin-ui',
  context?: RuntimeContext
): Promise<string> {
  const override = avatar.systemPromptOverride;

  if (override?.kind === 'inline' && override.text.trim().length > 0) {
    logger.info('systemPromptOverride applied (inline)', {
      event: 'prompt_override_applied',
      subsystem: 'prompt-builder',
      kind: 'inline',
      avatarId: avatar.avatarId,
      chars: override.text.length,
    });
    return override.text;
  }

  if (override?.kind === 'url') {
    const ttl = override.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC;
    const fetched = await fetchPromptFromUrl(override.url, ttl);
    if (fetched !== null && fetched.trim().length > 0) {
      logger.info('systemPromptOverride applied (url)', {
        event: 'prompt_override_applied',
        subsystem: 'prompt-builder',
        kind: 'url',
        avatarId: avatar.avatarId,
        url: override.url,
        chars: fetched.length,
      });
      return fetched;
    }
    // Fail-closed: fall through to the template so a bad URL never wedges a reply.
    logger.warn('systemPromptOverride URL unusable; falling back to assembled prompt', {
      event: 'prompt_override_fallback',
      subsystem: 'prompt-builder',
      avatarId: avatar.avatarId,
      url: override.url,
    });
  }

  return buildDynamicSystemPrompt(avatar, platform, context);
}

/**
 * Test/operations helper: drop the URL cache. Exported for tests and for any
 * future admin endpoint that wants to force a re-fetch without waiting for TTL.
 */
export function clearSystemPromptOverrideCache(): void {
  urlCache.clear();
}
