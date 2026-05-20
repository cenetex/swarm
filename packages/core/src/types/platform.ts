/**
 * Platform and agent configuration types
 *
 * These types are defined here (rather than in index.ts) so that sibling
 * type modules (envelope.ts, response.ts, service.ts, state.ts) can import
 * them without creating circular dependencies through the barrel.
 */

// =============================================================================
// PLATFORM TYPES
// =============================================================================

export type Platform = 'telegram' | 'discord' | 'twitter' | 'web' | 'shared-chat' | 'raticross';

// =============================================================================
// RESPONSE STYLE CONFIGURATION
// =============================================================================

export interface ResponseStyle {
  maxLength?: 'short' | 'medium' | 'long'; // short=1-2 sentences, medium=paragraph, long=essay
  stageDirections?: boolean; // allow [action] and *action* formatting
  emojiDensity?: 'none' | 'sparingly' | 'heavy';
  format?: 'conversational' | 'structured' | 'literary';
  bulletPoints?: boolean; // allow bullet-point lists
}

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

/**
 * Operator override of the assembled system prompt. When set, the full
 * prompt-builder template stack is bypassed and this value is used verbatim.
 * `inline` carries the text directly; `url` fetches at request time with a
 * short in-memory cache (default 300s) and falls back to the template on
 * fetch failure. See aws-swarm#1522.
 */
export type SystemPromptOverride =
  | { kind: 'inline'; text: string }
  | { kind: 'url'; url: string; cacheTtlSec?: number };

export interface AvatarConfig {
  id: string;
  name: string;
  version: string;
  persona: string; // Path or content of persona markdown
  systemPromptOverride?: SystemPromptOverride; // #1522 — operator override of assembled prompt
  responseStyle?: ResponseStyle; // Formatting and length preferences (separate from persona)
  brain?: {
    writeMode?: 'legacy' | 'dual' | 'canonical';
    readMode?: 'legacy' | 'hybrid' | 'canonical';
  };

  // Avatar/profile image for Discord webhooks
  profileImage?: {
    url: string;
    s3Key?: string;
    updatedAt?: number;
  };

  // Character reference for full-body consistency in image/video generation
  characterReference?: {
    url: string;
    s3Key?: string;
    description?: string;
    generatedPrompt?: string;
    updatedAt?: number;
  };

  // NFT ownership fields for handler-side access verification (#1385 handlers follow-up)
  nftMint?: string;
  creatorWallet?: string;

  platforms: PlatformConfigs;
  llm: LLMConfig;
  media: MediaConfig;
  scheduling: SchedulingConfig;
  behavior: BehaviorConfig;
  voice?: VoiceConfig;
  solana?: SolanaConfig;
  tools: string[];
  secrets: string[];
}

export interface RaticrossConfig {
  enabled: boolean;
  relayUrl: string;
  agentId?: string;
}

export interface SubstackConfig {
  enabled: boolean;
  subdomain: string; // e.g., "myagent" for myagent.substack.com
  sendEmail?: boolean; // Whether to email subscribers (default: false)
  publishImmediately?: boolean; // Whether to publish immediately or as draft (default: true)
}

export interface PlatformConfigs {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  twitter?: TwitterConfig;
  web?: WebConfig;
  raticross?: RaticrossConfig;
  substack?: SubstackConfig;
}

/**
 * Reference to a Telegram user (stores both ID and display info).
 * Used for DM allowlists - ID is required for filtering, username/displayName for UI.
 */
export interface TelegramUserRef {
  userId: string;        // Telegram user ID (required for filtering)
  username?: string;     // @username without @ (for display)
  displayName?: string;  // First name (for display)
}

/**
 * Reference to a Telegram chat/group (stores both ID and display info).
 * Used for group allowlists - ID is required for filtering, username/title for UI.
 */
export interface TelegramChatRef {
  chatId: string;        // Chat ID (required for filtering), e.g. "-1001234567890"
  username?: string;     // @groupname without @ (for public groups)
  title?: string;        // Group title (for display)
}

export interface TelegramConfig {
  enabled: boolean;
  botUsername: string;
  botId?: number;
  webhookPath: string;
  /**
   * How long to wait (ms) between deciding to respond and sending the reply.
   * Purpose: let mod-bot / anti-spam deletions land first so the bot never
   * posts a reply to a message that has already been purged. See #1527.
   *
   * Applied ONLY in group/supergroup chats. DMs and private replies bypass
   * the delay. If unset, defaults to 10000 (10s) for groups.
   */
  preReplyDelayMs?: number;
  allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
  /**
   * Optional allowlist of Telegram chat IDs the bot is allowed to respond in.
   * Use string form to safely represent large negative IDs (e.g. "-100123...").
   * @deprecated Use allowedChats instead for richer display info
   */
  allowedChatIds?: string[];
  /**
   * Optional allowlist of Telegram user IDs the bot is allowed to respond to in DMs.
   * Use string form.
   * @deprecated Use allowedDmUsers instead for richer display info
   */
  allowedDmUserIds?: string[];
  /**
   * Allowlist of users who can DM the bot (with display info).
   * Takes precedence over allowedDmUserIds if both are present.
   */
  allowedDmUsers?: TelegramUserRef[];
  /**
   * Allowlist of groups/channels the bot can respond in (with display info).
   * Takes precedence over allowedChatIds if both are present.
   */
  allowedChats?: TelegramChatRef[];
  /**
   * Primary home channel chat ID (e.g., "-1001234567890").
   * The avatar can only respond in this channel or other ratibots' home channels.
   */
  homeChannelId?: string;
  /**
   * Display-friendly channel username without @ (e.g., "ratibots").
   */
  homeChannelUsername?: string;
  /**
   * URL to the home channel (e.g., "https://t.me/ratichat").
   * Used in redirect messages when avatar is mentioned in non-home channels.
   */
  homeChannelUrl?: string;
  /**
   * Coin/token symbol for this avatar (e.g., "$RATiOS", "$MYTOKEN").
   * Used in redirect messages.
   */
  coinSymbol?: string;
  /**
   * Coin/token contract address.
   * Used in redirect messages.
   */
  coinAddress?: string;
  /**
   * If true, this is the admin bot for creating/managing other bots.
   * Admin bots have special handling for DMs.
   */
  isAdminBot?: boolean;
  /**
   * If true, allow DMs from all users (for admin bot).
   * Bypasses the allowedDmUsers check.
   */
  allowAllDms?: boolean;
}

export interface DiscordConfig {
  enabled: boolean;

  /**
   * Operating mode:
   * - 'webhook': Outbound only via Discord webhook (for avatar appearance)
   * - 'bot': Full bot functionality with gateway connection
   * - 'hybrid': Webhook for posting + bot for reading/responding
   * - 'global': Shares a single global bot token; posts via per-channel webhooks with avatar identity
   */
  mode: 'webhook' | 'bot' | 'hybrid' | 'global';

  // For webhook mode (outbound posting with custom avatar)
  webhookUrl?: string;
  webhookId?: string;
  webhookToken?: string;

  // For bot mode (full functionality)
  botUsername?: string;
  botId?: string;
  applicationId?: string;
  publicKey?: string;

  // Gateway options
  useGateway?: boolean; // ECS Fargate for persistent connection
  intents?: number; // Discord gateway intents bitmask

  // Behavior configuration
  respondToMentions?: boolean;
  respondInDMs?: boolean;
  allowedChannels?: string[]; // Channel IDs to operate in (empty = all)
  allowedGuilds?: string[]; // Guild IDs to operate in (empty = all)
  allowedRoleIds?: string[]; // Role IDs allowed to trigger replies in guilds
  /**
   * Primary home channel ID for this avatar on Discord.
   * Persisted after first discovery/creation to avoid duplicate channels.
   */
  homeChannelId?: string;
  /**
   * Guild ID where the home channel resides.
   */
  homeGuildId?: string;
  /**
   * Display-friendly channel name (e.g., "kyro-chat").
   */
  homeChannelName?: string;
}

export interface TwitterCommunityConfig {
  /** Twitter Community ID */
  id: string;
  /** Human-readable community name */
  name: string;
  /** Posts per day to this community (default: 1) */
  postFrequency?: number;
}

export interface AutonomousPostsConfig {
  /** Whether autonomous posting is enabled */
  enabled: boolean;
  /** Minimum interval between posts in hours (default: 4) */
  minIntervalHours: number;
  /** Maximum interval between posts in hours (default: 6) */
  maxIntervalHours: number;
  /** Probability of including an image (0-1, default: 0.3) */
  imageChance: number;
  /** Whether to use avatar memories for context (default: true) */
  useMemories: boolean;
  /** Optional topic hints for content generation */
  topics?: string[];
  /** Maximum autonomous posts per avatar per day (default: 6) */
  dailyBudget?: number;
}

export interface TwitterConfig {
  enabled: boolean;
  username: string;
  features: ('scheduled_tweets' | 'mention_replies' | 'dm_responses' | 'autonomous_posts' | 'community_posts')[];
  /** Character limit for tweets - 280 for free accounts, 10000 for Premium/Blue */
  charLimit?: number;
  /** Verified type from Twitter API - 'blue', 'business', 'government', or undefined */
  verifiedType?: string;
  /** Twitter Communities the avatar is a member of */
  communities?: TwitterCommunityConfig[];
  /** Autonomous posting configuration */
  autonomousPosts?: AutonomousPostsConfig;
  /** Simulation mode configuration - for bots without real Twitter integration */
  simulation?: {
    /** Whether simulation mode is enabled */
    enabled: boolean;
    /** Feed visibility: 'self' = only see own posts, 'linked' = also see real Twitter */
    feedVisibility: 'self' | 'linked';
    /** Whether to auto-approve posts (skip pre-moderation in simulation) */
    autoApprove: boolean;
  };
}

export interface WebConfig {
  enabled: boolean;
  corsOrigins: string[];
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  tokenGated?: {
    enabled: boolean;
    tokenMint: string;
    minBalance: number;
  };
}

export interface LLMConfig {
  provider: 'bedrock' | 'openrouter' | 'anthropic';
  model: string;
  fallbackModel?: string;
  fastModel?: string;
  thinkingModel?: string;
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
}

export interface VoiceConfig {
  enabled: boolean;
  defaultVoiceId?: string;
  ttsProvider?: 'voice-clone';
  speed?: number;
  pitch?: number;
  format?: 'ogg' | 'mp3' | 'wav';
  referenceUrl?: string;
}

export interface MediaConfig {
  image: {
    provider: 'openrouter' | 'replicate' | 'dalle';
    model: string;
    aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9';
  };
  video?: {
    provider: 'openrouter' | 'replicate';
    model: string;
  };
}

export interface SchedulingConfig {
  tweets?: ScheduledTweet[];
  mentionCheck?: {
    cron: string;
  };
  maintenance?: {
    cron: string;
  };
}

export interface ScheduledTweet {
  cron: string;
  template: string;
  enabled: boolean;
}

export interface BehaviorConfig {
  responseDelayMs: [number, number]; // [min, max] random delay
  typingIndicator: boolean;
  ignoreBots: boolean;
  cooldownMinutes: number;
  maxContextMessages: number;
  groupResponseDeadlineMs?: number;
}

export interface SolanaConfig {
  enabled: boolean;
  network: 'mainnet-beta' | 'devnet' | 'testnet';
  rpcUrl: string;
  tokenMint?: string; // Avatar's token if applicable
  walletSecretName: string;
  features: SolanaFeature[];
}

export type SolanaFeature =
  | 'token_gating'
  | 'nft_generation'
  | 'token_transfers'
  | 'balance_queries'
  | 'wallet_verification';
