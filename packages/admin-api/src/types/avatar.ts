/**
 * Avatar configuration types
 */
import type { VoiceConfig, McpConfig } from './media.js';
import type {
  IntegrationsConfig,
  TelegramUserRef,
  TelegramChatRef,
  TwitterCommunityConfig,
  AutonomousPostsConfig,
} from './platform.js';
import type { MemoryConfig } from './billing.js';

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
      mode?: 'webhook' | 'bot' | 'hybrid' | 'global';
      botUsername?: string;
      botId?: string;
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
