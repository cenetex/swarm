/**
 * Vanity mint policy helpers.
 *
 * Base58 is case-sensitive, so "RATi" and "RATI" are different patterns.
 */

export type VanityMintMode = 'best_effort' | 'strict';
export type VanityMatchPosition = 'prefix' | 'suffix' | 'contains' | 'none';

export interface VanityMintConfig {
  /**
   * Base58 pattern to target. Defaults to "RATi".
   * Note: uppercase "I" is not valid base58.
   */
  pattern?: string;
  /**
   * strict:
   * - only prefix/suffix matches satisfy policy
   *
   * best_effort:
   * - any contains match is acceptable
   */
  mode?: VanityMintMode;
  /**
   * Search budget in milliseconds for vanity mint attempts.
   * External providers may enforce their own upper caps.
   */
  maxSearchMs?: number;
  /**
   * Search budget in attempts for vanity mint selection.
   * External providers may enforce their own upper caps.
   */
  maxAttempts?: number;
}

export interface ResolvedVanityMintConfig {
  pattern: string;
  mode: VanityMintMode;
  maxSearchMs: number;
  maxAttempts: number;
}

export interface VanityMatchInfo {
  matched: boolean;
  position: VanityMatchPosition;
}

export interface VanitySearchCandidate<T> {
  value: T;
  address: string;
}

export interface VanitySearchSelection<T> {
  selected: VanitySearchCandidate<T>;
  match: VanityMatchInfo;
  /**
   * Whether the selected candidate satisfied the requested policy.
   * In best-effort mode this can be false (fallback candidate).
   */
  satisfied: boolean;
  /**
   * Candidate index from the original list (0-based).
   */
  index: number;
}

export type VanityAddressMatcher = (address: string) => VanityMatchInfo;

const BASE58_PATTERN = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

const DEFAULT_PATTERN = 'RATi';
const DEFAULT_MODE: VanityMintMode = 'best_effort';
const DEFAULT_MAX_SEARCH_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 11_316_496; // 58^4, expected trials for 4-char suffix

function classifyVanityPosition(address: string, pattern: string): VanityMatchPosition {
  // Fast constant-time boundary checks avoid full scans for common strict cases.
  if (address.startsWith(pattern)) return 'prefix';
  if (address.endsWith(pattern)) return 'suffix';
  return address.includes(pattern) ? 'contains' : 'none';
}

export function resolveVanityMintConfig(config?: VanityMintConfig): ResolvedVanityMintConfig | null {
  if (!config) return null;

  const pattern = (config.pattern || DEFAULT_PATTERN).trim();
  if (!pattern) {
    throw new Error('Vanity mint pattern cannot be empty');
  }
  if (!BASE58_PATTERN.test(pattern)) {
    throw new Error(
      'Vanity mint pattern must use base58 characters only (1-9, A-H, J-N, P-Z, a-k, m-z)'
    );
  }

  return {
    pattern,
    mode: config.mode || DEFAULT_MODE,
    maxSearchMs: config.maxSearchMs && config.maxSearchMs > 0 ? config.maxSearchMs : DEFAULT_MAX_SEARCH_MS,
    maxAttempts: config.maxAttempts && config.maxAttempts > 0 ? config.maxAttempts : DEFAULT_MAX_ATTEMPTS,
  };
}

export function getVanityMatchPosition(address: string, pattern: string): VanityMatchPosition {
  return classifyVanityPosition(address, pattern);
}

export function evaluateVanityMatch(address: string, config: ResolvedVanityMintConfig): VanityMatchInfo {
  const position = classifyVanityPosition(address, config.pattern);
  if (config.mode === 'strict') {
    return { matched: position === 'prefix' || position === 'suffix', position };
  }
  return { matched: position !== 'none', position };
}

/**
 * Build an optimized matcher closure for repeated checks.
 */
export function createVanityMatcher(config: ResolvedVanityMintConfig): VanityAddressMatcher {
  const pattern = config.pattern;
  const strict = config.mode === 'strict';

  return (address: string): VanityMatchInfo => {
    const position = classifyVanityPosition(address, pattern);

    if (!strict) {
      return { matched: position !== 'none', position };
    }
    return { matched: position === 'prefix' || position === 'suffix', position };
  };
}

/**
 * Select candidate according to vanity mode.
 *
 * strict:
 * - return first policy-satisfying candidate
 * - return null if none satisfy policy
 *
 * best_effort:
 * - return most recent satisfying candidate (any contains)
 * - if none satisfy, return most recent candidate as fallback
 */
export function selectVanityCandidate<T>(
  candidates: VanitySearchCandidate<T>[],
  config: ResolvedVanityMintConfig
): VanitySearchSelection<T> | null {
  if (candidates.length === 0) return null;
  const matcher = createVanityMatcher(config);

  if (config.mode === 'strict') {
    for (let i = 0; i < candidates.length; i += 1) {
      const match = matcher(candidates[i].address);
      if (match.matched) {
        return {
          selected: candidates[i],
          match,
          satisfied: true,
          index: i,
        };
      }
    }
    return null;
  }

  let latestMatchIndex = -1;
  let latestMatchInfo: VanityMatchInfo | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const match = matcher(candidates[i].address);
    if (match.matched) {
      latestMatchIndex = i;
      latestMatchInfo = match;
    }
  }

  if (latestMatchIndex >= 0 && latestMatchInfo) {
    return {
      selected: candidates[latestMatchIndex],
      match: latestMatchInfo,
      satisfied: true,
      index: latestMatchIndex,
    };
  }

  const fallbackIndex = candidates.length - 1;
  const fallback = candidates[fallbackIndex];
  return {
    selected: fallback,
    match: matcher(fallback.address),
    satisfied: false,
    index: fallbackIndex,
  };
}
