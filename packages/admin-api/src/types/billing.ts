/**
 * Billing & entitlement types — plans, limits, usage tracking
 */

// ============================================================================
// Entitlements & Plans (M1 Billing)
// ============================================================================

/**
 * Available plan types
 */
export type PlanType = 'free' | 'pro' | 'enterprise' | 'team';

/**
 * Plan limits configuration
 */
export interface PlanLimits {
  // Memory settings
  memoryEnabled: boolean;
  memoryRetentionDays: number;    // 0 = no retention (stateless)
  maxMemoriesPerTier: number;     // Max memories per tier

  // Usage limits (per day unless noted)
  dailyMessageLimit: number;      // Max messages processed per day
  dailyMediaCredits: number;      // Image/video generation credits
  dailyVoiceMinutes: number;      // Voice TTS minutes
  maxToolCallsPerMessage: number; // Tool iterations per message

  // Platform limits
  maxPlatforms: number;           // Connected platforms
  maxChannels: number;            // Total monitored channels

  // Features
  autonomousPostsEnabled: boolean;
  customModelEnabled: boolean;
  priorityProcessing: boolean;
}

/**
 * Default plan configurations
 *
 * Tier pricing:
 *   free     = $0/mo   — 1 bot, basic model access, CosyWorld branding
 *   pro      = $9/mo   — up to 3 bots, full model access, persistent memory (renamed from "Creator")
 *   team     = $299/mo — unlimited bots, shared memory, admin dashboard, priority access
 *   enterprise (legacy $29/mo) — kept for backward compat; migrated subscribers move to pro
 */
export const PLAN_DEFAULTS: Record<PlanType, PlanLimits> = {
  free: {
    memoryEnabled: false,
    memoryRetentionDays: 0,
    maxMemoriesPerTier: 0,
    dailyMessageLimit: 50,
    dailyMediaCredits: 5,
    dailyVoiceMinutes: 2,
    maxToolCallsPerMessage: 3,
    maxPlatforms: 1,
    maxChannels: 2,
    autonomousPostsEnabled: false,
    customModelEnabled: false,
    priorityProcessing: false,
  },
  pro: {
    memoryEnabled: true,
    memoryRetentionDays: 30,
    maxMemoriesPerTier: 100,
    dailyMessageLimit: 500,
    dailyMediaCredits: 50,
    dailyVoiceMinutes: 30,
    maxToolCallsPerMessage: 5,
    maxPlatforms: 3,
    maxChannels: 10,
    autonomousPostsEnabled: true,
    customModelEnabled: true,
    priorityProcessing: false,
  },
  team: {
    memoryEnabled: true,
    memoryRetentionDays: 365,
    maxMemoriesPerTier: 5000,
    dailyMessageLimit: -1,      // unlimited
    dailyMediaCredits: -1,      // unlimited
    dailyVoiceMinutes: -1,      // unlimited
    maxToolCallsPerMessage: 10,
    maxPlatforms: -1,           // unlimited
    maxChannels: -1,            // unlimited
    autonomousPostsEnabled: true,
    customModelEnabled: true,
    priorityProcessing: true,
  },
  /** @deprecated Legacy $29/mo tier — existing subscribers are migrated to pro */
  enterprise: {
    memoryEnabled: true,
    memoryRetentionDays: 365,
    maxMemoriesPerTier: 1000,
    dailyMessageLimit: 5000,
    dailyMediaCredits: 500,
    dailyVoiceMinutes: 120,
    maxToolCallsPerMessage: 10,
    maxPlatforms: 10,
    maxChannels: 50,
    autonomousPostsEnabled: true,
    customModelEnabled: true,
    priorityProcessing: true,
  },
};

/**
 * Entitlement record stored in DynamoDB
 * Key: pk=ENTITLEMENT#{accountId}, sk=AVATAR#{avatarId}
 */
export interface EntitlementRecord {
  pk: string;                     // ENTITLEMENT#{accountId}
  sk: string;                     // AVATAR#{avatarId}
  accountId: string;
  avatarId: string;
  plan: PlanType;
  limits: PlanLimits;             // Effective limits (plan defaults + overrides)
  overrides?: Partial<PlanLimits>; // Custom overrides for this entitlement

  // Billing metadata
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  billingCycleStart?: number;     // Current billing period start
  billingCycleEnd?: number;       // Current billing period end

  // Status
  status: 'active' | 'suspended' | 'cancelled' | 'trial';
  trialEndsAt?: number;
  suspendedAt?: number;
  suspendedReason?: string;

  // How this entitlement was granted (manual admin, stripe, ascension, design-partner, etc.)
  entitlementSource?: 'manual' | 'stripe' | 'ascension' | 'design-partner';

  // Audit
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;

  // GSI for listing by avatar
  gsi1pk?: string;                // AVATAR#{avatarId}
  gsi1sk?: string;                // ENTITLEMENT
}

/**
 * Usage tracking record (daily buckets)
 * Key: pk=USAGE#{avatarId}, sk=DAY#{YYYY-MM-DD}
 */
export interface UsageRecord {
  pk: string;                     // USAGE#{avatarId}
  sk: string;                     // DAY#{YYYY-MM-DD}
  avatarId: string;
  date: string;                   // YYYY-MM-DD

  // Counters
  messagesProcessed: number;
  mediaCreditsUsed: number;
  voiceMinutesUsed: number;
  toolCallsMade: number;

  // Breakdown by type
  imageGenerations: number;
  videoGenerations: number;
  stickerGenerations: number;

  // TTL for automatic cleanup (30 days after billing cycle)
  ttl: number;
  updatedAt: number;
}

/**
 * Memory configuration for an avatar
 */
export interface MemoryConfig {
  enabled: boolean;
  retentionDays: number;          // 0 = no retention
  consolidationEnabled: boolean;  // Run nightly consolidation
  semanticSearchEnabled: boolean; // Use embeddings for recall
}
