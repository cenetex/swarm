/**
 * Admin API Types
 */
import { z } from 'zod';

// User session from first-party auth
export interface UserSession {
  email: string;
  userId: string;
  isAdmin: boolean;
  accessToken: string;
  accountId?: string;
}

// Secret types that can be managed
export const SecretType = z.enum([
  'telegram_bot_token',
  'telegram_webhook_secret',  // Secret token for webhook verification
  'twitter_api_key',
  'twitter_api_secret',
  'twitter_access_token',
  'twitter_access_secret',
  'twitter_bearer_token',
  'discord_bot_token',
  'discord_client_id',
  'discord_client_secret',
  'discord_webhook_url',
  'openrouter_api_key',
  'anthropic_api_key',
  'replicate_api_key',
  'openai_api_key',
  'helius_api_key',
  'solana_wallet_key',
  'ethereum_wallet_key',
  'moltbook_api_key',
  'token_launch_api_key',
  'token_launch_partner_key',
  'token_launch_referral_code',
  'custom',
]);

export type SecretType = z.infer<typeof SecretType>;

// Secret metadata (stored in DynamoDB, NOT the actual secret)
export interface SecretMetadata {
  pk: string; // AVATAR#{avatarId} or GLOBAL
  sk: string; // SECRET#{secretType}#{name}
  secretType: SecretType;
  name: string;
  description?: string;
  secretArn: string; // Reference to Secrets Manager
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  isGlobal: boolean;
  // For wallets
  publicKey?: string;
  walletType?: 'solana' | 'ethereum';
}

// Wallet info (public data only)
export interface WalletInfo {
  id: string;
  avatarId: string;
  walletType: 'solana' | 'ethereum';
  publicKey: string;
  address: string;
  name: string;
  createdAt: number;
  createdBy: string;
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

// =============================================================================
// Unified Integration Configuration
// =============================================================================

/**
 * All supported integration types
 */
export type IntegrationType =
  // Platform integrations
  | 'telegram'
  | 'twitter'
  | 'discord'
  | 'web'
  // AI providers
  | 'replicate'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  // Blockchain
  | 'solana'
  | 'ethereum';

/**
 * Capabilities that AI providers can offer
 */
export type AICapability =
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'    // abstract audio/music/sound effects
  | 'voice_clone'         // clone voice from reference audio
  | 'text_to_speech'      // generate speech from text
  | 'transcription'       // speech to text
  | 'llm';                // text generation

/**
 * Configuration for AI provider integrations (Replicate, OpenAI, etc.)
 */
export interface AIProviderConfig {
  enabled: boolean;

  // Whether to use global (system-wide) API key or avatar-specific
  useGlobalKey: boolean;

  // Model preferences per capability (overrides system defaults)
  models?: {
    image_generation?: string;     // e.g., 'google/nano-banana-pro'
    video_generation?: string;     // e.g., 'minimax/video-01'
    audio_generation?: string;     // e.g., 'stability-ai/stable-audio-2.5'
    voice_clone?: string;          // e.g., 'lucataco/xtts-v2'
    text_to_speech?: string;       // e.g., 'lucataco/xtts-v2' or 'gpt-4o-mini-tts'
    transcription?: string;        // e.g., 'openai/whisper'
    llm?: string;                  // e.g., 'anthropic/claude-3-opus'
  };

  // Provider-specific settings
  webhookUrl?: string;             // For async predictions (Replicate)
  pollIntervalMs?: number;         // For sync prediction polling
}

/**
 * Configuration for platform integrations (Telegram, Twitter, Discord)
 */
export interface PlatformIntegrationConfig {
  enabled: boolean;

  // Platform-specific settings (varies by platform)
  settings?: Record<string, unknown>;

  // Connection status
  status?: 'not_configured' | 'configured' | 'connected' | 'error';
  statusMessage?: string;
  lastCheckedAt?: number;
}

/**
 * Telegram-specific integration config
 */
export interface TelegramIntegrationConfig extends PlatformIntegrationConfig {
  botUsername?: string;
  botId?: number;
  webhookConfigured?: boolean;
}

/**
 * Twitter-specific integration config
 */
export interface TwitterIntegrationConfig extends PlatformIntegrationConfig {
  username?: string;
  userId?: string;
}

/**
 * Discord-specific integration config
 */
export interface DiscordIntegrationConfig extends PlatformIntegrationConfig {
  guildId?: string;
  mode?: 'webhook' | 'bot' | 'hybrid';
  useGateway?: boolean;
  intents?: number;
  respondToMentions?: boolean;
  respondInDMs?: boolean;
  allowedChannels?: string[];
  allowedGuilds?: string[];
  applicationId?: string;
  publicKey?: string;
}

/**
 * Unified integrations configuration for an avatar
 */
export interface IntegrationsConfig {
  // AI Providers
  replicate?: AIProviderConfig;
  openai?: AIProviderConfig;
  anthropic?: AIProviderConfig;
  openrouter?: AIProviderConfig;

  // Platform integrations
  telegram?: TelegramIntegrationConfig;
  twitter?: TwitterIntegrationConfig;
  discord?: DiscordIntegrationConfig;
  web?: PlatformIntegrationConfig;

  // Blockchain integrations
  solana?: PlatformIntegrationConfig;
  ethereum?: PlatformIntegrationConfig;
}

// MCP Server Configuration
export type ToolsetId =
  | 'core' | 'media' | 'voice' | 'wallet' | 'profile' | 'gallery'
  | 'secrets' | 'jobs' | 'reference' | 'models' | 'config' | 'admin'
  | 'diagnostics' | 'telegram' | 'twitter' | 'discord' | 'property'
  | 'memory' | 'nft' | 'claude-code' | 'moltbook';

export interface ExternalMcpServer {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  enabled: boolean;              // Whether this server is active
  transport: 'stdio' | 'sse';    // Connection type
  command?: string;              // For stdio: command to run
  args?: string[];               // For stdio: command arguments
  url?: string;                  // For SSE: server URL
  env?: Record<string, string>;  // Environment variables
  addedAt: number;
  addedBy: string;
}

export interface McpConfig {
  // Internal toolsets - all disabled by default
  enabledToolsets: ToolsetId[];
  // External MCP servers
  externalServers: ExternalMcpServer[];
  // Runtime brain rollout overrides (optional, per avatar)
  brain?: {
    writeMode?: 'legacy' | 'dual' | 'canonical';
    readMode?: 'legacy' | 'hybrid' | 'canonical';
  };
}

export interface VoiceProfile {
  pk: string; // VOICE#{voiceId}
  sk: string; // PROFILE
  voiceId: string;
  avatarId: string;
  status: 'creating' | 'ready' | 'failed';
  provider: 'stable-audio' | 'voice-clone';
  seedAssetId?: string;
  cloneAssetId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AudioAsset {
  pk: string; // AUDIO#{assetId}
  sk: string; // ASSET
  assetId: string;
  avatarId: string;
  source: 'telegram' | 'upload' | 'stable-audio' | 'tts' | 'voice-clone' | 'voice-clone-smoothed';
  format: 'ogg' | 'mp3' | 'wav';
  durationMs?: number;
  url: string;
  createdAt: number;
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

export interface TwitterCommunityConfig {
  id: string;
  name: string;
  postFrequency?: number;
}

export interface AutonomousPostsConfig {
  enabled: boolean;
  minIntervalHours?: number;
  maxIntervalHours?: number;
  imageChance?: number;
  useMemories?: boolean;
  topics?: string[];
}

// Avatar configuration stored in DynamoDB
export interface AvatarRecord {
  pk: string; // AVATAR#{avatarId}
  sk: string; // CONFIG
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;

  // Profile image for character consistency (avatar/headshot)
  profileImage?: {
    url: string;           // S3/CDN URL
    s3Key: string;         // S3 key for reference
    generatedPrompt?: string; // If AI-generated, the prompt used
    updatedAt: number;
  };

  // Character reference for full-body consistency
  // Used as default reference for image/video generation when available
  // Falls back to profileImage if not set
  characterReference?: {
    url: string;           // S3/CDN URL
    s3Key: string;         // S3 key for reference
    generatedPrompt?: string; // If AI-generated, the prompt used
    description?: string;  // Description of the character sheet (e.g., "turnaround, blue furry creature")
    updatedAt: number;
  };

  // Media configuration
  mediaConfig?: {
    image: {
      provider: 'openrouter' | 'replicate' | 'dalle' | 'gemini';
      model: string;
    };
    video?: {
      provider: 'replicate';
      model: string;
    };
    // Use profile image as reference for character consistency
    useProfileAsReference: boolean;
  };

  // Telegram sticker pack (if created)
  stickerPack?: {
    name: string;          // e.g., "agent_name_by_botusername"
    title: string;
    stickerCount: number;
    createdAt: number;
  };

  platforms: {
    telegram?: {
      enabled: boolean;
      botUsername?: string;
      botId?: number;
      /** @deprecated Use allowedChats instead for richer display info */
      allowedChatIds?: string[];
      /** @deprecated Use allowedDmUsers instead for richer display info */
      allowedDmUserIds?: string[];
      /** Allowlist of users who can DM the bot (with display info). */
      allowedDmUsers?: TelegramUserRef[];
      /** Allowlist of groups/channels the bot can respond in (with display info). */
      allowedChats?: TelegramChatRef[];
      /** Primary home channel chat ID (e.g., "-1001234567890"). */
      homeChannelId?: string;
      /** Display-friendly channel username without @ (e.g., "ratibots"). */
      homeChannelUsername?: string;
      /** URL to the home channel (e.g., "https://t.me/ratichat"). */
      homeChannelUrl?: string;
      /** Coin/token symbol for this avatar (e.g., "$RATiOS"). */
      coinSymbol?: string;
      /** Coin/token contract address. */
      coinAddress?: string;
    };
    twitter?: {
      enabled: boolean;
      username?: string;
      features?: ('scheduled_tweets' | 'mention_replies' | 'dm_responses' | 'autonomous_posts' | 'community_posts')[];
      communities?: TwitterCommunityConfig[];
      autonomousPosts?: AutonomousPostsConfig;
      /** Simulation mode configuration - for bots without real Twitter integration */
      simulation?: {
        enabled: boolean;
        feedVisibility: 'self' | 'linked';
        autoApprove: boolean;
      };
    };
    discord?: {
      enabled: boolean;
      guildId?: string;
      mode?: 'webhook' | 'bot' | 'hybrid';
      useGateway?: boolean;
      intents?: number;
      respondToMentions?: boolean;
      respondInDMs?: boolean;
      allowedChannels?: string[];
      allowedGuilds?: string[];
      applicationId?: string;
      publicKey?: string;
    };
    web?: { enabled: boolean };
  };
  llmConfig: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    useGlobalKey: boolean;
  };
  voiceConfig?: VoiceConfig;

  // MCP server configuration - all toolsets disabled by default
  mcpConfig?: McpConfig;

  // Unified integrations configuration (AI providers + platforms)
  // This is the new unified config - mediaConfig, voiceConfig, platforms will be migrated here
  integrations?: IntegrationsConfig;

  // Creation tracking - who created this avatar (permanent, for slot counting)
  creatorWallet?: string;

  // Inhabitation - the Solana wallet that currently "inhabits" this avatar
  // 1:1 relationship: one wallet can only inhabit one avatar at a time
  // Inhabiting is FREE, but abandoning requires burning a Gate NFT
  inhabitantWallet?: string;
  inhabitedAt?: number;

  // Slot type - tracks how this avatar was created
  // 'free' = first avatar (free slot), 'orb' = NFT-backed slot
  slotType?: 'free' | 'orb';

  // Orb slotting - optional explicit Orb NFT backing for this avatar
  orbMint?: string;
  orbWallet?: string;
  orbSlottedAt?: number;

  // Health status indicators
  healthStatus?: 'healthy' | 'rate_limited' | 'error' | 'inactive';
  healthMessage?: string;      // e.g., "Twitter rate limit exceeded"
  lastHealthCheck?: number;    // timestamp

  // NFT-backing (for collection-based avatars)
  // Avatars can be created from NFTs in whitelisted collections
  nftMint?: string;            // Solana mint address of the NFT
  nftCollection?: string;      // Collection address
  nftName?: string;            // Name from NFT metadata
  nftImage?: string;           // Image URL from NFT metadata

  // Legacy fields (for migration, will be removed)
  ownerWallet?: string;
  ownerClaimedAt?: number;

  // Lineage tracking for NFT minting on abandonment
  nftCollectionMint?: string;     // Metaplex Core collection for this avatar's lineage
  currentEra?: number;            // Increments on each abandonment (defaults to 0)
  lastBurnTx?: string;
  lastBurnMint?: string;

  // DynamoDB GSI fields for Telegram bot ID lookup
  gsi3pk?: string; // TELEGRAM_BOT#{botId} - for finding avatar by Telegram bot ID
  gsi3sk?: string; // AVATAR

  // Memory configuration (M1)
  memoryConfig?: MemoryConfig;

  // Activation tracking (M1)
  activatedAt?: number;           // When the avatar was explicitly activated
  activatedBy?: string;           // Who activated it (wallet or email)

  // Token launch
  tokenLaunch?: {
    mint: string;           // Token mint address
    symbol: string;         // Token symbol
    name: string;           // Token name
    launchedAt: number;     // Timestamp of launch
    signature: string;      // Launch transaction signature
    metadataUrl: string;    // IPFS metadata URL
    launchUrl: string;
  };

  // ==========================================================================
  // Avatar Ascension (Burn Orb + RATI to mint unique Avatar NFT)
  // Ascended avatars have locked personas, tradeable via NFT ownership
  // ==========================================================================

  /** Whether this avatar has been ascended (persona/image locked, NFT-owned) */
  isAscended?: boolean;
  /** When ascension occurred */
  ascendedAt?: number;
  /** Wallet that performed the ascension */
  ascendedByWallet?: string;
  /** The minted Ascension NFT address (holder = owner) */
  ascendedNftMint?: string;

  /** Orb NFT burn transaction signature for ascension */
  ascensionOrbBurnSignature?: string;
  /** RATI token burn transaction signature for ascension */
  ascensionRatiBurnSignature?: string;
  /** Amount of RATI burned for ascension */
  ascensionRatiBurnAmount?: number;

  status: 'draft' | 'active' | 'paused' | 'deleted';
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

// Gallery item for tracking generated media
export interface GalleryItem {
  pk: string;              // AVATAR#{avatarId}
  sk: string;              // GALLERY#{timestamp}#{id}
  id: string;
  avatarId: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  s3Key: string;
  prompt: string;
  caption?: string;
  model: string;
  platform?: string;       // Where it was generated for
  postedToTwitter: boolean;
  convertedToSticker: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
  // Sticker metadata (populated when converted to sticker)
  stickerInfo?: {
    emoji: string;
    setName: string;
    fileId?: string;       // Telegram file_id for direct sending
    stickerUrl?: string;   // S3 URL of the processed sticker
    convertedAt: number;
  };
}

// Media generation job for async operations
export interface MediaJob {
  pk: string;              // MEDIAJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  avatarId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;

  // Callback info
  conversationId: string;
  platform: string;
  replyToMessageId?: string;

  // Purpose hint for avatar continuation
  // e.g., 'post_to_twitter' tells the avatar to chain this to a tweet
  purpose?: 'profile' | 'post_to_twitter' | 'send_to_chat' | 'gallery';

  // Provider tracking
  provider: string;
  externalId?: string;     // Replicate prediction ID, etc.

  // Results
  resultUrl?: string;
  resultS3Key?: string;
  error?: string;

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// Chat job for async admin chat operations
export interface ChatJob {
  pk: string;              // CHATJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  avatarId: string;
  type: 'chat';
  status: 'pending' | 'processing' | 'completed' | 'failed';

  // For display/debugging (compat with other job UIs)
  prompt: string;

  // Who initiated the job (used only for auditing; access checks are avatar-based)
  session: {
    userId?: string;
    email?: string;
    isAdmin?: boolean;
  };

  // Full request payload to execute
  request: {
    message: string;
    history: AdminChatMessage[];
    avatar?: z.infer<typeof AvatarContextSchema>;
    sender?: MessageSender;
    systemPrompt?: string;
    attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>;
    model?: string;
  };

  // Results (filled on completion)
  result?: {
    response: string;
    history: AdminChatMessage[];
    media?: Array<{ type: 'image' | 'video' | 'sticker' | 'audio'; url: string; prompt?: string; id?: string }>;
    pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
    avatarUpdates?: { profileImageUrl?: string; name?: string };
    pendingToolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  };

  error?: string;

  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;
}

// Dream generation job (async, processed by dream worker)
export interface DreamJob {
  pk: string;              // DREAMJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  avatarId: string;
  type: 'dream';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

  // Inputs
  persona: string;
  previousDream?: string;
  previousIteration: number;

  // Idempotency / queue processing
  slotReserved?: boolean;
  skippedReason?: string;

  // Results
  result?: {
    dream: string;
    iteration: number;
    reinforcedMemoryIds?: string[];
  };
  error?: string;

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// System counter for limiting dreams/day
export interface DailyCounter {
  pk: string;              // SYSTEM#dreams
  sk: string;              // DAILY#YYYY-MM-DD
  feature: string;         // 'dreams'
  date: string;            // YYYY-MM-DD
  count: number;
  limit: number;
  updatedAt: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// Credit bucket for rate limiting
export interface CreditBucket {
  pk: string;              // AVATAR#{avatarId}
  sk: string;              // CREDIT#{toolName}
  avatarId: string;
  toolName: string;
  credits: number;
  maxCredits: number;
  lastRefillAt: number;
  dailyUsed: number;
  dailyLimit: number;
  dailyResetAt: number;
}

// Chat message schemas for the admin chatbot
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

// Sender identity for chat messages
export const MessageSenderSchema = z.object({
  walletAddress: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type MessageSender = z.infer<typeof MessageSenderSchema>;

export const AdminChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  sender: MessageSenderSchema.optional(),
  media: z.array(z.object({
    type: z.enum(['image', 'video', 'sticker']),
    url: z.string(),
    prompt: z.string().optional(),
    id: z.string().optional(),
    thumbnailUrl: z.string().optional(),
  })).optional(),
});

export const ToolResultSchema = z.object({
  tool_call_id: z.string(),
  role: z.literal('tool'),
  content: z.string(),
});

// Avatar context in chat request
export const AvatarContextSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  persona: z.string().optional(),
  // Optional: when present, used to constrain tool availability/prompt generation.
  // Uses z.string() to allow arbitrary MCP toolset categories beyond core-defined ones.
  enabledCategories: z.array(z.string()).optional(),
});

// Chat request body schema
export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(AdminChatMessageSchema).default([]),
  avatar: AvatarContextSchema.optional(),
  sender: MessageSenderSchema.optional(),
  systemPrompt: z.string().optional(), // Override default system prompt
  attachments: z.array(z.object({
    type: z.enum(['image', 'file', 'audio']),
    data: z.string(), // base64 data URL or public URL for audio
    name: z.string().optional(),
  })).optional(),
  model: z.string().optional(), // Override default LLM model (e.g., 'anthropic/claude-3-5-haiku-20241022')
});

// Infer types from schemas
export type AdminChatMessage = z.infer<typeof AdminChatMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// Admin chatbot tool definitions
export const AdminTools = {
  // Avatar Management
  create_avatar: z.object({
    name: z.string().describe('Name for the new avatar'),
    description: z.string().optional().describe('Description of the avatar'),
  }),

  update_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar to update'),
    name: z.string().optional(),
    description: z.string().optional(),
    persona: z.string().optional(),
  }),

  list_avatars: z.object({}),

  get_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar'),
  }),

  delete_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar to delete'),
    confirm: z.boolean().describe('Must be true to confirm deletion'),
  }),

  // Platform Configuration
  configure_telegram: z.object({
    avatarId: z.string(),
    botToken: z.string().describe('Telegram bot token from @BotFather'),
    botUsername: z.string().optional(),
  }),
  
  configure_twitter: z.object({
    avatarId: z.string(),
    apiKey: z.string(),
    apiSecret: z.string(),
    accessToken: z.string(),
    accessSecret: z.string(),
    bearerToken: z.string().optional(),
    username: z.string().optional(),
  }),
  
  configure_discord: z.object({
    avatarId: z.string(),
    botToken: z.string(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    guildId: z.string().optional(),
    mode: z.enum(['webhook', 'bot', 'hybrid']).optional(),
    useGateway: z.boolean().optional(),
    intents: z.number().optional(),
    respondToMentions: z.boolean().optional(),
    respondInDMs: z.boolean().optional(),
    allowedChannels: z.array(z.string()).optional(),
    allowedGuilds: z.array(z.string()).optional(),
    applicationId: z.string().optional(),
    publicKey: z.string().optional(),
  }),

  // AI Provider Keys
  set_openrouter_key: z.object({
    apiKey: z.string().describe('OpenRouter API key'),
    avatarId: z.string().optional().describe('Avatar ID for per-avatar key, omit for global'),
  }),
  
  set_anthropic_key: z.object({
    apiKey: z.string().describe('Anthropic API key'),
    avatarId: z.string().optional(),
  }),
  
  set_openai_key: z.object({
    apiKey: z.string().describe('OpenAI API key'),
    avatarId: z.string().optional(),
  }),
  
  set_replicate_key: z.object({
    apiKey: z.string().describe('Replicate API key'),
    avatarId: z.string().optional(),
  }),

  // Wallet Management
  generate_solana_wallet: z.object({
    avatarId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),
  
  generate_ethereum_wallet: z.object({
    avatarId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),
  
  list_wallets: z.object({
    avatarId: z.string().optional().describe('Filter by avatar, omit for all'),
  }),
  
  get_wallet_balance: z.object({
    walletId: z.string(),
  }),

  // Secret Management (write-only)
  set_custom_secret: z.object({
    avatarId: z.string().optional().describe('Avatar ID or omit for global'),
    name: z.string().describe('Name of the secret'),
    value: z.string().describe('Secret value'),
    description: z.string().optional(),
  }),
  
  list_secrets: z.object({
    avatarId: z.string().optional().describe('Filter by avatar, omit for all'),
  }),
  
  delete_secret: z.object({
    avatarId: z.string().optional(),
    secretName: z.string(),
    confirm: z.boolean(),
  }),

  // Deployment
  deploy_avatar: z.object({
    avatarId: z.string(),
    environment: z.enum(['dev', 'staging', 'prod']).optional(),
  }),
  
  get_deployment_status: z.object({
    avatarId: z.string(),
  }),
};

export type AdminToolName = keyof typeof AdminTools;

// === CHANNEL STATE (Kyro-style architecture) ===

// Channel state machine states
export type ChannelState = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

// Media attachment in a buffered message
export interface BufferedMedia {
  type: 'photo' | 'video' | 'animation' | 'document' | 'sticker';
  fileId: string;
  mimeType?: string;
}

// Buffered message in a channel
export interface BufferedMessage {
  messageId: number;
  userId: number;
  userName: string;
  username?: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToUserId?: number;
  replyToUserName?: string;
  replyToUsername?: string;
  replyToText?: string;
  isMention?: boolean;
  isReplyToBot?: boolean;
  media?: BufferedMedia[];
  // Bot-to-bot interaction tracking
  isFromBot?: boolean;           // True if sender is a bot
  senderBotUsername?: string;    // Bot username if isFromBot
}

// Channel state record stored in DynamoDB
export interface ChannelStateRecord {
  pk: string;              // CHANNEL#{avatarId}#{chatId}
  sk: string;              // STATE
  avatarId: string;
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // State machine
  state: ChannelState;
  stateChangedAt: number;

  // Message buffer (last N messages)
  messageBuffer: BufferedMessage[];
  bufferSize: number;

  // Response tracking
  lastResponseAt?: number;
  lastResponseMessageId?: number;
  pendingResponseAt?: number;  // Scheduled response time
  
  // Bot-to-bot interaction tracking
  lastBotResponseAt?: number;     // Last time we responded to a bot message
  lastBotRespondedTo?: string;    // Username of last bot we responded to

  // Engagement tracking
  directEngagementAt?: number;  // Last mention/reply

  // Sticky engagement window (after mention/reply, stay responsive to the engager)
  stickyEngagementUserId?: number;
  stickyEngagementUntil?: number;
  stickyEngagementRemaining?: number;
  lastActivityAt: number;

  // TTL for cleanup
  ttl: number;
  updatedAt: number;
}

// Response trigger types
export type ResponseTrigger =
  | 'direct_engagement'    // Mention or reply to bot
  | 'sticky_followup'      // Follow-up messages after a mention/reply
  | 'message_threshold'    // N messages accumulated
  | 'conversation_gap'     // Silence after activity
  | 'scheduled'            // Scheduled evaluation
  | 'private_chat';        // Always respond in private

// Response decision
export interface ResponseDecision {
  shouldRespond: boolean;
  trigger: ResponseTrigger | 'none';
  delay: number;           // Delay in ms before responding (0 = immediate)
  priority: 'high' | 'normal' | 'low';
}

// ========================================
// Multi-Avatar D&D Coordination Types
// ========================================

/**
 * D&D ability scores with computed modifiers
 * Generated deterministically from avatar createdAt timestamp
 */
export interface AvatarStats {
  STR: number; // Strength - reserved for future use
  DEX: number; // Dexterity - Initiative modifier
  CON: number; // Constitution - reserved for future use
  INT: number; // Intelligence - reserved for future use
  WIS: number; // Wisdom - Interest check (reflective contexts)
  CHA: number; // Charisma - Interest check (social contexts)
  modifiers: {
    STR: number;
    DEX: number;
    CON: number;
    INT: number;
    WIS: number;
    CHA: number;
  };
}

/**
 * Shared channel registry record
 * Tracks all avatars present in a Telegram channel/group
 * Key: pk=SHARED_CHANNEL#{chatId}, sk=AVATAR#{avatarId}
 */
export interface SharedChannelRecord {
  pk: string;              // SHARED_CHANNEL#{chatId}
  sk: string;              // AVATAR#{avatarId}
  chatId: number;
  avatarId: string;
  botUsername: string;     // For mention detection
  joinedAt: number;        // First seen in channel
  lastSeenAt: number;      // Last activity
  stats: AvatarStats;       // D&D ability scores
  ttl: number;             // Auto-cleanup after inactivity
}

/**
 * Shared channel message - a message in the shared history visible to all bots
 * This allows bots to see each other's responses in multi-avatar channels
 */
export interface SharedChannelMessage {
  messageId: number;       // Telegram message ID
  avatarId: string;         // Which bot sent this
  botUsername: string;     // Bot's @username for display
  text: string;            // Message content
  timestamp: number;       // When it was sent
  replyToMessageId?: number; // What message this replies to
}

/**
 * Shared channel history record
 * Stores recent bot messages visible to all bots in the channel
 * Key: pk=SHARED_HISTORY#{chatId}, sk=HISTORY
 */
export interface SharedChannelHistoryRecord {
  pk: string;              // SHARED_HISTORY#{chatId}
  sk: string;              // HISTORY
  chatId: number;
  messages: SharedChannelMessage[];
  ttl: number;             // Auto-cleanup
  updatedAt: number;
}

/**
 * Initiative round phases
 */
export type InitiativePhase = 'interest' | 'rolling' | 'responding' | 'reacting' | 'complete';

/**
 * Initiative round coordination record
 * Coordinates which avatar responds to a message in multi-avatar channels
 * Key: pk=INITIATIVE#{chatId}#{messageId}, sk=META or ROLL#{avatarId}
 */
export interface InitiativeRoundRecord {
  pk: string;              // INITIATIVE#{chatId}#{messageId}
  sk: string;              // META or ROLL#{avatarId}
  chatId: number;
  messageId: number;       // Triggering message ID

  // For META record (sk: META)
  phase?: InitiativePhase;
  startedAt?: number;
  expiresAt?: number;      // Round times out after this
  winnerId?: string;       // Avatar who won initiative
  winnerRoll?: number;     // Winning roll total
  winnerRespondedAt?: number;

  // Reaction coordination (META record)
  reactionCount?: number;         // Number of reactions already applied for this triggering message
  reactionAvatars?: string[];     // Avatars that have already reacted (dedupe)

  // For ROLL records (sk: ROLL#{avatarId})
  avatarId?: string;
  interested?: boolean;    // Interest check result
  interestRoll?: number;   // CHA/WIS check roll
  initiativeRoll?: number; // d20 roll
  initiativeModifier?: number; // DEX modifier
  totalInitiative?: number; // roll + modifier
  rolledAt?: number;

  ttl: number;             // Auto-cleanup (5 min)
}

/**
 * Interest check result
 */
export interface InterestCheckResult {
  interested: boolean;
  roll: number;
  modifier: number;
  dc: number;
  reason: 'direct_engagement' | 'context_interest' | 'not_interested' | 'bot_interaction_interest' | 'bot_message_skipped';
}

/**
 * Initiative coordination result
 */
export type InitiativeAction = 'respond' | 'react' | 'skip';

export interface InitiativeResult {
  action: InitiativeAction;
  reason: string;
  priority?: 'primary' | 'secondary';
  winnerId?: string;
  winnerRoll?: number;
  myRoll?: number;
}

// ============================================================================
// Chat Modification Voting System
// ============================================================================

/**
 * Types of chat modifications that require voting
 */
export type ChatModificationType = 'photo' | 'description' | 'title';

/**
 * Status of a chat modification proposal
 */
export type ChatModificationStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

/**
 * Chat modification proposal record
 * Tracks proposals for changing chat photo, description, or title
 * Key: pk=CHAT_VOTE#{chatId}, sk=PROPOSAL#{proposalId}
 */
export interface ChatModificationProposal {
  pk: string;              // CHAT_VOTE#{chatId}
  sk: string;              // PROPOSAL#{proposalId}
  proposalId: string;      // UUID
  chatId: number;
  type: ChatModificationType;
  
  // Proposal details
  proposedBy: string;      // Avatar ID who proposed
  proposedAt: number;      // Timestamp
  
  // What to change
  newValue: string;        // URL for photo, text for description/title
  currentValue?: string;   // Current value for reference
  reason?: string;         // Why the change is proposed
  
  // Voting
  status: ChatModificationStatus;
  votes: Record<string, {
    avatarId: string;
    vote: 'approve' | 'reject';
    votedAt: number;
    comment?: string;
  }>;
  requiredVotes: number;   // Number of avatars that need to approve
  
  // Execution
  executedAt?: number;
  executedBy?: string;
  
  ttl: number;             // Auto-cleanup after 7 days
}

/**
 * Chat modification rate limit record
 * Tracks when modifications were last made to enforce weekly limit
 * Key: pk=CHAT_MOD_LIMIT#{chatId}, sk=TYPE#{type}
 */
export interface ChatModificationLimit {
  pk: string;              // CHAT_MOD_LIMIT#{chatId}
  sk: string;              // TYPE#{type}
  chatId: number;
  type: ChatModificationType;
  lastModifiedAt: number;  // Timestamp of last successful modification
  lastModifiedBy: string;  // Avatar ID
  proposalId: string;      // Reference to the approved proposal
  ttl: number;             // Auto-cleanup after 30 days
}

/**
 * User profile photo info (from Telegram API)
 */
export interface TelegramUserProfilePhotos {
  totalCount: number;
  photos: Array<{
    fileId: string;
    width: number;
    height: number;
    fileSize?: number;
  }>;
}

// ============================================================================
// Property Research System
// ============================================================================

/**
 * Property address for research
 */
export interface PropertyAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

/**
 * Research progress tracking
 */
export type ResearchStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface ResearchProgress {
  listings: ResearchStepStatus;
  assessor: ResearchStepStatus;
  comparables: ResearchStepStatus;
  demographics: ResearchStepStatus;
  schools: ResearchStepStatus;
  walkability: ResearchStepStatus;
}

/**
 * Property listing found via web search
 */
export interface PropertyListing {
  source: string;           // zillow, redfin, realtor.com, etc.
  url: string;
  price?: number;
  priceStr?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  lotSize?: string;
  yearBuilt?: number;
  propertyType?: string;    // single-family, condo, townhouse, etc.
  status?: string;          // for sale, pending, sold
  daysOnMarket?: number;
  description?: string;
  imageUrl?: string;
}

/**
 * Comparable sale (comp)
 */
export interface ComparableSale {
  address: string;
  salePrice: number;
  saleDate: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  pricePerSqft?: number;
  distanceMiles?: number;
  source: string;
  url?: string;
}

/**
 * Neighborhood/demographic info
 */
export interface NeighborhoodInfo {
  medianHomePrice?: number;
  medianRent?: number;
  medianIncome?: number;
  population?: number;
  crimeRate?: string;        // low, medium, high, or score
  walkScore?: number;
  transitScore?: number;
  bikeScore?: number;
  sources: string[];
}

/**
 * School info
 */
export interface SchoolInfo {
  name: string;
  type: 'elementary' | 'middle' | 'high' | 'private' | 'charter';
  rating?: number;           // 1-10 scale
  distance?: string;
  enrollment?: number;
  source: string;
  url?: string;
}

/**
 * Assessor/tax record info
 */
export interface AssessorInfo {
  assessedValue?: number;
  taxAmount?: number;
  taxYear?: number;
  lotSize?: string;
  yearBuilt?: number;
  zoning?: string;
  ownerName?: string;        // Public record
  lastSaleDate?: string;
  lastSalePrice?: number;
  source: string;
  url?: string;
}

/**
 * All research findings for a property
 */
export interface PropertyFindings {
  listings: PropertyListing[];
  comparables: ComparableSale[];
  neighborhood: NeighborhoodInfo | null;
  schools: SchoolInfo[];
  assessor: AssessorInfo | null;
  searchQueries: string[];   // Queries used for audit
  errors: string[];          // Any errors encountered
}

/**
 * Property research job status
 */
export type PropertyResearchStatus = 'queued' | 'researching' | 'completed' | 'failed';

/**
 * Property research job record (DynamoDB)
 * Key: pk=PROPERTY_RESEARCH#{jobId}, sk=JOB
 */
export interface PropertyResearchJob {
  pk: string;
  sk: string;
  jobId: string;
  avatarId: string;
  requestedBy?: string;      // Wallet address or user ID

  // Property being researched
  property: PropertyAddress;

  // Job status
  status: PropertyResearchStatus;
  progress: ResearchProgress;

  // Research findings (populated as research progresses)
  findings?: PropertyFindings;

  // Generated report
  reportMarkdown?: string;
  reportUrl?: string;        // S3 URL if stored externally

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;

  // TTL for auto-cleanup (7 days)
  ttl: number;

  // GSI for avatar queries: gsi2pk=AVATAR#{avatarId}, gsi2sk={status}#{createdAt}
  gsi2pk: string;
  gsi2sk: string;
}

/**
 * Property research authorization grant
 * Key: pk=PROPERTY_AUTH#{avatarId}, sk=USER#{walletAddress}
 */
export interface PropertyResearchAuth {
  pk: string;
  sk: string;
  avatarId: string;
  walletAddress: string;
  grantedAt: number;
  expiresAt: number;         // 24-hour grants by default
  ttl: number;
}

// ============================================================================
// Memory System - Tiered Avatar Memory for Personality Evolution
// ============================================================================

/**
 * Memory tier determines storage duration and detail level
 *
 * Legacy tiers (backward compatible):
 * - immediate: Last N interactions, full detail (short-term)
 * - recent: Summarized memories with themes (medium-term)
 * - core: Permanent learnings, patterns, identity (long-term)
 *
 * New durable tiers:
 * - ephemeral: Session-scoped, auto-expires (maps to immediate)
 * - durable: Long-term with decay (maps to recent)
 * - archival: Permanent, cost-optimized (maps to core)
 */
export type MemoryTier = 'immediate' | 'recent' | 'core' | 'ephemeral' | 'durable' | 'archival';

/**
 * Memory type categorizes what kind of memory this is
 */
export type MemoryType =
  | 'event'        // Something that happened (conversation, action)
  | 'fact'         // A factual piece of information
  | 'learning'     // Something the avatar learned
  | 'pattern'      // A behavioral pattern the avatar noticed
  | 'identity'     // Self-reflection about who the avatar is becoming
  | 'relationship' // Memory about a specific user or entity
  | 'preference';  // User or avatar preference

/**
 * A memory stored in the avatar's memory system
 * Key: pk=MEMORY#{avatarId}, sk={tier}#{timestamp}#{id}
 */
export interface AvatarMemory {
  pk: string;
  sk: string;
  id: string;
  avatarId: string;
  tier: MemoryTier;
  type: MemoryType;
  content: string;           // The memory content
  about?: string;            // Who/what this is about (username, topic)
  userId?: string;           // Associated user ID if applicable
  themes?: string[];         // Tags for retrieval (e.g., 'hunting', 'philosophy')
  strength: number;          // 0-1, how reinforced this memory is
  embedding?: number[];      // Vector embedding for semantic search
  embeddingModel?: string;   // Model used to generate embedding (e.g., 'amazon.titan-embed-text-v2:0')
  embeddingVersion?: number; // Embedding version for re-embedding on model upgrades
  metadata?: Record<string, unknown>; // Additional context
  createdAt: number;
  updatedAt: number;
  consolidatedAt?: number;   // When this was last processed by consolidation
  sourceMemoryIds?: string[]; // For summaries: IDs of memories that were consolidated
  ttl?: number;              // DynamoDB TTL (epoch seconds) for automatic expiration
}

/**
 * Configuration for memory consolidation
 */
export interface MemoryConsolidationConfig {
  // Immediate tier
  immediateMaxCount: number;     // Max memories before promotion (default: 10)
  // Recent tier
  recentMaxCount: number;        // Max memories before summarization (default: 50)
  recentSummaryThreshold: number; // Memories to trigger summary (default: 10)
  // Core tier
  coreMaxCount: number;          // Max core memories (default: 100)
  // Decay settings
  decayRate: number;             // Strength multiplier per cycle (default: 0.95)
  decayIntervalHours: number;    // Hours between decay cycles (default: 24)
  pruneThreshold: number;        // Remove memories below this strength (default: 0.1)
  // Reinforcement
  reinforcementBoost: number;    // Strength boost when pattern repeats (default: 0.1)
}

/**
 * Avatar's consolidated identity snapshot
 * Key: pk=IDENTITY#{avatarId}, sk=SNAPSHOT#{timestamp}
 */
export interface AvatarIdentitySnapshot {
  pk: string;
  sk: string;
  avatarId: string;
  statement: string;         // "I am becoming..." statement
  previousStatement?: string; // Previous identity for comparison
  triggeringMemories: string[]; // Memory IDs that led to this
  createdAt: number;
  ttl?: number;              // DynamoDB TTL (epoch seconds) for automatic expiration
}

/**
 * Memory query options
 */
export interface MemoryQueryOptions {
  tier?: MemoryTier;
  type?: MemoryType;
  about?: string;
  userId?: string;
  themes?: string[];
  minStrength?: number;
  limit?: number;
  semantic?: {
    query: string;
    threshold?: number;      // Minimum similarity (default: 0.5)
  };
}

// ============================================================================
// Memory Graph (Graph RAG)
// ============================================================================

/**
 * Edge relationship types for the memory graph
 */
export type MemoryEdgeType =
  | 'related_to'      // General semantic relatedness
  | 'caused_by'       // Causal relationship (A caused B)
  | 'about_same'      // Same entity/topic
  | 'contradicts'     // Conflicting information
  | 'elaborates'      // B provides more detail about A
  | 'temporal_next'   // B happened after A in sequence
  | 'promoted_from';  // B was promoted/consolidated from A

/**
 * An edge in the memory graph connecting two memories.
 *
 * DynamoDB Key Schema:
 * - pk: EDGE#{avatarId}
 * - sk: {sourceMemoryId}#{targetMemoryId}
 *
 * GSI (reverse lookup):
 * - pk: EDGE#{avatarId}
 * - sk: begins_with(targetMemoryId#) via scan/filter
 */
export interface MemoryEdge {
  pk: string;               // EDGE#{avatarId}
  sk: string;               // {sourceMemoryId}#{targetMemoryId}
  avatarId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  edgeType: MemoryEdgeType;
  weight: number;           // 0.0–1.0, strength of the relationship
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  ttl?: number;             // DynamoDB TTL (epoch seconds)
}

/**
 * Configuration for graph pruning during consolidation
 */
export interface GraphPruneConfig {
  /** Minimum edge weight to keep (edges below this are deleted). Default: 0.1 */
  minEdgeWeight: number;
  /** Decay multiplier applied to edge weights per consolidation cycle. Default: 0.95 */
  edgeDecayRate: number;
  /** Maximum edges per memory node (prune weakest above this). Default: 20 */
  maxEdgesPerNode: number;
  /** Maximum total edges per avatar. Default: 2000 */
  maxTotalEdges: number;
}

/**
 * Result of a graph-enhanced memory search
 */
export interface GraphSearchResult {
  /** Directly matched memories from semantic search */
  directMatches: AvatarMemory[];
  /** Associated memories surfaced via graph traversal */
  graphMatches: AvatarMemory[];
  /** Combined and deduplicated results */
  combined: AvatarMemory[];
  /** Graph edges traversed */
  edgesTraversed: number;
}

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

// ============================================================================
// Home Channel Registry (for multi-bot channel filtering)
// ============================================================================

/**
 * Home channel record
 * Tracks which chat IDs are "home channels" for any ratibot avatar.
 * Avatars can only respond in their own home channel OR home channels of other ratibots.
 * Key: pk=HOME_CHANNELS, sk={chatId}
 */
export interface HomeChannelRecord {
  pk: string;              // "HOME_CHANNELS"
  sk: string;              // "{chatId}" (e.g., "-1001234567890")
  chatId: string;          // Chat ID as string
  avatarId: string;        // Avatar that owns this home channel
  botUsername: string;     // Bot username for reference
  /**
   * Avatars that have registered this chat as a home/allowed channel.
   * Includes the owner avatar.
   */
  registeredAvatars?: Array<{ avatarId: string; botUsername: string }>;
  channelUsername?: string; // Channel @username without @ (e.g., "ratibots")
  channelTitle?: string;   // Human-readable title
  registeredAt: number;    // When first registered
  updatedAt: number;       // Last update timestamp
}
