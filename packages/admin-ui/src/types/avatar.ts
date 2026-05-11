/**
 * Avatar Types
 */

export interface AvatarSecret {
  key: string;
  name: string;
  description?: string;
  isSet: boolean;
}

export interface PlatformConfig {
  enabled: boolean;
  botUsername?: string;
  username?: string;
  guildId?: string;
  allowedChatIds?: string[];
  allowedDmUserIds?: string[];
  simulation?: {
    enabled: boolean;
    feedVisibility: 'self' | 'linked';
    autoApprove: boolean;
  };
}

export interface AvatarConfig {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  color?: string;
  persona?: string;
  model?: string;
  secrets: AvatarSecret[];
  createdAt: number;
  updatedAt: number;
  // Creator tracking (permanent - who created this avatar)
  creatorWallet?: string;
  // Slot type - how this avatar was created
  slotType?: 'free' | 'orb' | 'nft';
  // Orb slotting - optional explicit Orb NFT backing
  orbMint?: string;
  orbWallet?: string;
  orbSlottedAt?: number;
  // Health status indicators
  healthStatus?: 'healthy' | 'rate_limited' | 'error' | 'inactive';
  healthMessage?: string;
  // Platform configurations
  platforms?: {
    telegram?: PlatformConfig;
    twitter?: PlatformConfig;
    discord?: PlatformConfig;
  };
  // Legacy fields (deprecated)
  ownerWallet?: string;
  ownerClaimedAt?: number;
}

export interface Avatar extends AvatarConfig {
  status: 'shell' | 'configured' | 'active' | 'error' | 'draft' | 'paused';
  lastActivity?: number;
}

/**
 * Tool call from the LLM that requires UI interaction
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status?: 'pending' | 'completed' | 'failed';
  result?: unknown;
}

/**
 * Pending job for async media generation
 */
export interface PendingJob {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt?: string;
  purpose?: string;
  error?: string;
  resultUrl?: string;
}

/**
 * Sender identity for chat messages
 */
export interface MessageSender {
  walletAddress?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Optional internal reasoning extracted from <thinking> tags. */
  thinking?: string[];
  timestamp: number;
  isLoading?: boolean;
  /** UI-only: message originated from a tool result (role=tool on backend). Used for display styling. */
  isToolResult?: boolean;
  /** The tool_call_id for role='tool' messages, linking back to the assistant's tool_calls entry. */
  tool_call_id?: string;
  /** OpenAI-format tool_calls from the server, stored for accurate history reconstruction. */
  serverToolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  error?: string;
  /** Tool calls that need user interaction */
  toolCalls?: ToolCall[];
  /** Pending async jobs (image/video generation) */
  pendingJobs?: PendingJob[];
  /** Sender identity (for user messages) */
  sender?: MessageSender;
  /** Media items returned from tool execution (gallery, generated images, etc) */
  media?: Array<{ type: 'image' | 'video' | 'sticker' | 'audio'; url: string; prompt?: string; id?: string }>;
  /** Structured limit info when a free-tier limit was hit — drives inline upgrade nudge */
  limitInfo?: { limitType: string; current: number; limit: number; remaining: number };
}

export interface AvatarChat {
  avatarId: string;
  messages: ChatMessage[];
}
