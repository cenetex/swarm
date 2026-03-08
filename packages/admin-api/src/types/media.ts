/**
 * Media types — voice, audio, gallery, media jobs, MCP config
 */

export interface VoiceConfig {
  enabled: boolean;
  defaultVoiceId?: string;
  ttsProvider?: 'voice-clone';
  speed?: number;
  pitch?: number;
  format?: 'ogg' | 'mp3' | 'wav';
  referenceUrl?: string;
}

// MCP Server Configuration
export type ToolsetId =
  | 'core' | 'media' | 'voice' | 'wallet' | 'profile' | 'gallery'
  | 'secrets' | 'jobs' | 'reference' | 'models' | 'config' | 'admin'
  | 'diagnostics' | 'telegram' | 'twitter' | 'discord' | 'property'
  | 'memory' | 'nft' | 'claude-code' | 'moltbook' | 'github';

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
