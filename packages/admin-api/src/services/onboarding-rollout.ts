import { createHash } from 'node:crypto';
import { GetCommand } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('onboarding-rollout');

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE;
const ONBOARDING_FLAGS_PK = process.env.ONBOARDING_FLAGS_PK || 'SYSTEM#FEATURE_FLAGS';
const ONBOARDING_FLAGS_SK = process.env.ONBOARDING_FLAGS_SK || 'ONBOARDING#V2';
const ONBOARDING_FLAGS_CACHE_TTL_MS = parsePositiveInt(
  process.env.ONBOARDING_FLAGS_CACHE_TTL_MS,
  10_000
);

type OnboardingFlagSource = 'env' | 'dynamo' | 'safe-fallback';

export interface OnboardingV2FlagsSnapshot {
  enabled: boolean;
  rolloutPercent: number;
  avatarAllowlist: string[];
  forceLegacy: boolean;
  source: OnboardingFlagSource;
  readAt: number;
}

export interface OnboardingAssignmentInput {
  attemptKey?: string;
  accountId?: string;
  walletAddress?: string;
  userId?: string;
  avatarId?: string;
  avatarName?: string;
}

export type OnboardingAssignmentKeySource =
  | 'attempt_key'
  | 'account_avatar'
  | 'account_name'
  | 'wallet_avatar'
  | 'wallet_name'
  | 'user_avatar'
  | 'user_name'
  | 'avatar'
  | 'name'
  | 'anonymous';

export interface OnboardingAssignmentKey {
  key: string;
  source: OnboardingAssignmentKeySource;
}

export type OnboardingDecisionReason =
  | 'force_legacy'
  | 'disabled'
  | 'allowlist'
  | 'rollout'
  | 'rollout_excluded';

export interface OnboardingRoutingDecision {
  onboardingVersion: 'v1' | 'v2';
  reason: OnboardingDecisionReason;
  cohortBucket: number;
  assignmentKeyHash: string;
  assignmentKeySource: OnboardingAssignmentKeySource;
  matchedAvatarAllowlist: boolean;
  flags: OnboardingV2FlagsSnapshot;
}

let cachedFlags: { value: OnboardingV2FlagsSnapshot; expiresAt: number } | null = null;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return fallback;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.floor(value)));
}

function parseRolloutPercent(value: unknown, fallback: number): number {
  if (typeof value === 'number') return clampPercent(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return clampPercent(parsed);
  }
  return clampPercent(fallback);
}

function normalizeAllowlist(values: readonly string[]): string[] {
  const deduped = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeToken(raw);
    if (normalized) deduped.add(normalized);
  }
  return [...deduped];
}

function parseAllowlist(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowlist(
      value
        .filter((entry): entry is string => typeof entry === 'string')
    );
  }
  if (typeof value === 'string') {
    return normalizeAllowlist(value.split(','));
  }
  return [...fallback];
}

function getNestedValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function readFlagValue(
  item: Record<string, unknown>,
  dottedKey: string,
  nestedPath: readonly string[],
  fallbackKey: string
): unknown {
  if (Object.hasOwn(item, dottedKey)) return item[dottedKey];
  const nested = getNestedValue(item, nestedPath);
  if (nested !== undefined) return nested;
  if (Object.hasOwn(item, fallbackKey)) return item[fallbackKey];
  return undefined;
}

function getEnvFlagsSnapshot(): OnboardingV2FlagsSnapshot {
  const enabled = parseBooleanValue(process.env.ONBOARDING_V2_ENABLED, false);
  const rolloutPercent = parseRolloutPercent(process.env.ONBOARDING_V2_ROLLOUT_PERCENT, 0);
  const avatarAllowlist = parseAllowlist(process.env.ONBOARDING_V2_AVATAR_ALLOWLIST, []);
  const forceLegacy = parseBooleanValue(process.env.ONBOARDING_V2_FORCE_LEGACY, false);

  return {
    enabled,
    rolloutPercent,
    avatarAllowlist,
    forceLegacy,
    source: 'env',
    readAt: Date.now(),
  };
}

function mergeWithDynamoFlags(
  envFlags: OnboardingV2FlagsSnapshot,
  item: Record<string, unknown>
): OnboardingV2FlagsSnapshot {
  const enabled = parseBooleanValue(
    readFlagValue(item, 'onboarding.v2.enabled', ['onboarding', 'v2', 'enabled'], 'enabled'),
    envFlags.enabled
  );
  const rolloutPercent = parseRolloutPercent(
    readFlagValue(item, 'onboarding.v2.rolloutPercent', ['onboarding', 'v2', 'rolloutPercent'], 'rolloutPercent'),
    envFlags.rolloutPercent
  );
  const avatarAllowlist = parseAllowlist(
    readFlagValue(item, 'onboarding.v2.avatarAllowlist', ['onboarding', 'v2', 'avatarAllowlist'], 'avatarAllowlist'),
    envFlags.avatarAllowlist
  );
  const forceLegacy = parseBooleanValue(
    readFlagValue(item, 'onboarding.v2.forceLegacy', ['onboarding', 'v2', 'forceLegacy'], 'forceLegacy'),
    envFlags.forceLegacy
  );

  return {
    enabled,
    rolloutPercent,
    avatarAllowlist,
    forceLegacy,
    source: 'dynamo',
    readAt: Date.now(),
  };
}

function forceLegacyFallback(): OnboardingV2FlagsSnapshot {
  return {
    enabled: false,
    rolloutPercent: 0,
    avatarAllowlist: [],
    forceLegacy: true,
    source: 'safe-fallback',
    readAt: Date.now(),
  };
}

export async function getOnboardingV2FlagsSnapshot(): Promise<OnboardingV2FlagsSnapshot> {
  if (cachedFlags && Date.now() < cachedFlags.expiresAt) {
    return cachedFlags.value;
  }

  const envFlags = getEnvFlagsSnapshot();
  if (!ADMIN_TABLE) {
    cachedFlags = {
      value: envFlags,
      expiresAt: Date.now() + ONBOARDING_FLAGS_CACHE_TTL_MS,
    };
    return envFlags;
  }

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: ONBOARDING_FLAGS_PK,
        sk: ONBOARDING_FLAGS_SK,
      },
    }));

    const merged = result.Item
      ? mergeWithDynamoFlags(envFlags, result.Item as Record<string, unknown>)
      : envFlags;

    cachedFlags = {
      value: merged,
      expiresAt: Date.now() + ONBOARDING_FLAGS_CACHE_TTL_MS,
    };

    return merged;
  } catch (error) {
    const safeFallback = forceLegacyFallback();
    log.warn('flags', 'load_failed_legacy_fallback', {
      error: error instanceof Error ? error.message : String(error),
      pk: ONBOARDING_FLAGS_PK,
      sk: ONBOARDING_FLAGS_SK,
    });

    cachedFlags = {
      value: safeFallback,
      expiresAt: Date.now() + ONBOARDING_FLAGS_CACHE_TTL_MS,
    };
    return safeFallback;
  }
}

export function buildOnboardingAssignmentKey(input: OnboardingAssignmentInput): OnboardingAssignmentKey {
  const attemptKey = input.attemptKey?.trim();
  if (attemptKey) {
    return { key: `attempt:${attemptKey}`, source: 'attempt_key' };
  }

  const accountId = normalizeToken(input.accountId);
  const wallet = normalizeToken(input.walletAddress);
  const userId = normalizeToken(input.userId);
  const avatarId = normalizeToken(input.avatarId);
  const avatarName = normalizeName(input.avatarName);

  if (accountId && avatarId) {
    return { key: `account:${accountId}|avatar:${avatarId}`, source: 'account_avatar' };
  }
  if (accountId && avatarName) {
    return { key: `account:${accountId}|name:${avatarName}`, source: 'account_name' };
  }
  if (wallet && avatarId) {
    return { key: `wallet:${wallet}|avatar:${avatarId}`, source: 'wallet_avatar' };
  }
  if (wallet && avatarName) {
    return { key: `wallet:${wallet}|name:${avatarName}`, source: 'wallet_name' };
  }
  if (userId && avatarId) {
    return { key: `user:${userId}|avatar:${avatarId}`, source: 'user_avatar' };
  }
  if (userId && avatarName) {
    return { key: `user:${userId}|name:${avatarName}`, source: 'user_name' };
  }
  if (avatarId) {
    return { key: `avatar:${avatarId}`, source: 'avatar' };
  }
  if (avatarName) {
    return { key: `name:${avatarName}`, source: 'name' };
  }

  return { key: 'anonymous', source: 'anonymous' };
}

function cohortBucketForKey(key: string): number {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % 100;
}

function hashKeyForDiagnostics(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function decideOnboardingRouting(
  flags: OnboardingV2FlagsSnapshot,
  assignmentInput: OnboardingAssignmentInput
): OnboardingRoutingDecision {
  const assignment = buildOnboardingAssignmentKey(assignmentInput);
  const cohortBucket = cohortBucketForKey(assignment.key);
  const assignmentKeyHash = hashKeyForDiagnostics(assignment.key);
  const normalizedAvatarId = normalizeToken(assignmentInput.avatarId);
  const allowlist = new Set(flags.avatarAllowlist.map((entry) => normalizeToken(entry)).filter(Boolean) as string[]);
  const matchedAvatarAllowlist = normalizedAvatarId ? allowlist.has(normalizedAvatarId) : false;

  if (flags.forceLegacy) {
    return {
      onboardingVersion: 'v1',
      reason: 'force_legacy',
      cohortBucket,
      assignmentKeyHash,
      assignmentKeySource: assignment.source,
      matchedAvatarAllowlist,
      flags,
    };
  }

  if (!flags.enabled) {
    return {
      onboardingVersion: 'v1',
      reason: 'disabled',
      cohortBucket,
      assignmentKeyHash,
      assignmentKeySource: assignment.source,
      matchedAvatarAllowlist,
      flags,
    };
  }

  if (matchedAvatarAllowlist) {
    return {
      onboardingVersion: 'v2',
      reason: 'allowlist',
      cohortBucket,
      assignmentKeyHash,
      assignmentKeySource: assignment.source,
      matchedAvatarAllowlist,
      flags,
    };
  }

  if (cohortBucket < flags.rolloutPercent) {
    return {
      onboardingVersion: 'v2',
      reason: 'rollout',
      cohortBucket,
      assignmentKeyHash,
      assignmentKeySource: assignment.source,
      matchedAvatarAllowlist,
      flags,
    };
  }

  return {
    onboardingVersion: 'v1',
    reason: 'rollout_excluded',
    cohortBucket,
    assignmentKeyHash,
    assignmentKeySource: assignment.source,
    matchedAvatarAllowlist,
    flags,
  };
}

export async function resolveOnboardingRoutingDecision(
  assignmentInput: OnboardingAssignmentInput
): Promise<OnboardingRoutingDecision> {
  const flags = await getOnboardingV2FlagsSnapshot();
  return decideOnboardingRouting(flags, assignmentInput);
}

export function clearOnboardingFlagCache(): void {
  cachedFlags = null;
}
