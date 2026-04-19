/**
 * MessageProcessor Types
 *
 * Types for the unified message processing pipeline used across all platforms.
 */

import type { Platform, ResponseStyle } from '../types/index.js';

// =============================================================================
// TOOL CATEGORIES
// =============================================================================

/**
 * Tool categories that can be enabled/disabled per avatar
 */
export type ToolCategory =
  | 'secrets'      // Always enabled - request/store secrets
  | 'wallets'      // Solana wallet management
  | 'profile'      // Profile updates (name, description, persona)
  | 'media'        // Image/video/sticker generation
  | 'gallery'      // Media gallery browsing
  | 'voice'        // Voice generation and TTS
  | 'telegram'     // Telegram-specific tools
  | 'twitter'      // Twitter/X tools
  | 'discord'      // Discord tools
  | 'memory'       // Remember/recall facts
  | 'nft'          // NFT and ownership tools
  | 'property'     // Property research tools
  | 'diagnostics'  // Issue reporting
  | 'signal-station' // Signal space mining station governance
  | (string & {}); // Allow arbitrary categories from MCP toolsets

/**
 * Toolset identifiers for tool grouping.
 * This matches the TOOLSETS in @swarm/mcp-server for compatibility.
 */
export type ToolsetId =
  | 'core'
  | 'admin'
  | 'config'
  | 'jobs'
  | 'models'
  | 'secrets'
  | 'wallet'
  | 'profile'
  | 'media'
  | 'gallery'
  | 'voice'
  | 'telegram'
  | 'twitter'
  | 'discord'
  | 'memory'
  | 'nft'
  | 'property'
  | 'diagnostics'
  | 'reference'    // Reference images
  | 'claude-code'  // Claude Code automation
  | 'signal-station' // Signal space mining station governance
  | (string & {}); // Allow arbitrary toolset IDs from MCP plugins

// =============================================================================
// PROCESSOR CONFIGURATION
// =============================================================================

/**
 * Configuration for a single message processing request
 */
export interface ProcessorConfig {
  /** Avatar ID processing this message */
  avatarId: string;
  /** Platform the message originated from */
  platform: Platform | 'admin-ui' | 'api' | 'mcp';
  /** Conversation/channel ID */
  conversationId: string;
  /** User ID of the message sender */
  userId?: string;
  /** Message ID to reply to */
  replyToMessageId?: string;
  /** Session information for auth/permissions */
  session?: {
    email?: string;
    isAdmin?: boolean;
  };
}

/**
 * Avatar configuration needed for message processing
 */
export interface ProcessorAvatarConfig {
  avatarId: string;
  name?: string;
  description?: string;
  persona?: string;
  responseStyle?: ResponseStyle;

  /** Which categories of tools are enabled */
  enabledCategories: ToolCategory[];

  /** Platform-specific configuration */
  platforms?: {
    telegram?: { enabled: boolean };
    twitter?: { enabled: boolean };
    discord?: { enabled: boolean };
  };

  /** Wallets for context injection */
  wallets?: Array<{ name: string; publicKey: string }>;

  /** LLM configuration */
  llmConfig?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };

  /** MCP configuration */
  mcpConfig?: {
    enabledToolsets?: string[];
  };
}

// =============================================================================
// PROCESSOR INPUT/OUTPUT
// =============================================================================

/**
 * A message in the conversation history
 */
export interface ProcessorMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ProcessorMessageContent[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ProcessorToolCall[];
}

export interface ProcessorMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ProcessorToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Media item produced by processing
 */
export interface ProcessorMediaItem {
  type: 'image' | 'video' | 'sticker' | 'audio';
  url: string;
  prompt?: string;
  id?: string;
  caption?: string;
}

/**
 * Pending async job
 */
export interface ProcessorPendingJob {
  jobId: string;
  type: 'image' | 'video' | 'sticker' | 'property_research' | 'claude_code';
  prompt?: string;
  purpose?: string;
  status?: string;
}

/**
 * Result of processing a message
 */
export interface ProcessorResult {
  /** The text response to send */
  response: string;
  /** Updated conversation history */
  history: ProcessorMessage[];
  /** Media items to send */
  media?: ProcessorMediaItem[];
  /** Pending async jobs */
  pendingJobs?: ProcessorPendingJob[];
  /** Avatar updates (e.g., profile image changed) */
  avatarUpdates?: {
    profileImageUrl?: string;
    name?: string;
  };
  /** Tool requiring user input (pause for confirmation) */
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

// =============================================================================
// PROCESSOR OPTIONS
// =============================================================================

/**
 * Options for processing a message
 */
export interface ProcessorOptions {
  /** Custom system prompt (overrides dynamic building) */
  customSystemPrompt?: string;
  /** Attachments with the message */
  attachments?: Array<{
    type: 'image' | 'file' | 'audio';
    data: string;
    name?: string;
  }>;
  /** Override default LLM model */
  model?: string;
  /** Override default max output tokens */
  maxTokens?: number;
  /** Enable dreams context injection */
  dreamsEnabled?: boolean;
}

// =============================================================================
// CATEGORY DETECTION
// =============================================================================

/**
 * Input for detecting which tool categories should be enabled
 */
export interface CategoryDetectionInput {
  voice?: boolean;
  memory?: boolean;
  telegram?: boolean;
  twitter?: boolean;
  discord?: boolean;
  nft?: boolean;
  property?: boolean;
  signalStation?: boolean;
}

// =============================================================================
// SERVICE INTERFACES (for dependency injection)
// =============================================================================

/**
 * Service for loading avatar configuration
 */
export interface AvatarService {
  getAvatar(avatarId: string): Promise<ProcessorAvatarConfig | null>;
}

/**
 * Service for managing conversation history
 */
export interface HistoryService {
  getHistory(avatarId: string, conversationId: string): Promise<ProcessorMessage[]>;
  saveHistory(avatarId: string, conversationId: string, history: ProcessorMessage[]): Promise<void>;
}

/**
 * Service for memory (remember/recall facts)
 */
export interface MemoryService {
  getMemoryContext(avatarId: string): Promise<string | null>;
  getMemoryContextForQuery?(avatarId: string, query: string): Promise<string | null>;
  remember(avatarId: string, fact: string, about?: string, userId?: string): Promise<void>;
  recall(avatarId: string, query: string, userId?: string): Promise<Array<{ fact: string; about?: string; timestamp: number }>>;
}

/**
 * Service for dreams context
 */
export interface DreamsService {
  getDreamForResponse(avatarId: string, persona: string): Promise<{ dream: unknown; isGenerating: boolean }>;
  formatDreamForPrompt(dream: unknown): string | null;
}

/**
 * Service for voice transcription
 */
export interface VoiceService {
  transcribeAudio(params: { avatarId: string; url?: string; assetId?: string }): Promise<{ text: string }>;
}
