/**
 * Agent Types
 */

export interface AgentSecret {
  key: string;
  name: string;
  description?: string;
  isSet: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  color?: string;
  persona?: string;
  model?: string;
  secrets: AgentSecret[];
  createdAt: number;
  updatedAt: number;
  // Creator tracking (permanent - who created this agent)
  creatorWallet?: string;
  // Inhabitant tracking (current inhabitant)
  inhabitantWallet?: string;
  inhabitedAt?: number;
  // Legacy fields (deprecated)
  ownerWallet?: string;
  ownerClaimedAt?: number;
}

export interface Agent extends AgentConfig {
  status: 'shell' | 'configured' | 'active' | 'error';
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
  inhabitedAgentId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isLoading?: boolean;
  error?: string;
  /** Tool calls that need user interaction */
  toolCalls?: ToolCall[];
  /** Pending async jobs (image/video generation) */
  pendingJobs?: PendingJob[];
  /** Sender identity (for user messages) */
  sender?: MessageSender;
}

export interface AgentChat {
  agentId: string;
  messages: ChatMessage[];
}
