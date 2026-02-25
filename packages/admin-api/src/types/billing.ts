/**
 * Billing & entitlement types — plans, limits, usage tracking
 */

// ============================================================================
// Entitlements & Plans (M1 Billing)
// ============================================================================

/**
 * Available plan types
 */
export type PlanType = 'free' | 'pro' | 'enterprise';

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
  enterprise: {
    memoryEnabled: true,
    memoryRetentionDays: 365,
    maxMemoriesPerTier: 1000,
    dailyMessageLimit: -1,  // Unlimited
    dailyMediaCredits: -1,  // Unlimited
    dailyVoiceMinutes: -1,  // Unlimited
    maxToolCallsPerMessage: 10,
    maxPlatforms: -1,       // Unlimited
    maxChannels: -1,        // Unlimited
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

  // How this entitlement was granted (manual admin, stripe, ascension, etc.)
  entitlementSource?: 'manual' | 'stripe' | 'ascension';

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
