/**
 * Platform integration types — Telegram, Discord, Twitter, AI providers
 */

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
    image_generation?: string;     // e.g., 'black-forest-labs/flux.2-pro'
    video_generation?: string;     // e.g., 'bytedance/seedance-2.0-fast'
    audio_generation?: string;     // e.g., 'stability-ai/stable-audio-2.5'
    voice_clone?: string;          // e.g., 'lucataco/xtts-v2'
    text_to_speech?: string;       // e.g., 'lucataco/xtts-v2' or 'gpt-4o-mini-tts'
    transcription?: string;        // e.g., 'openai/whisper'
    llm?: string;                  // OpenRouter catalog model ID
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
