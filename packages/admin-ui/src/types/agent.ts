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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isLoading?: boolean;
  error?: string;
  /** Tool calls that need user interaction */
  toolCalls?: ToolCall[];
}

export interface AgentChat {
  agentId: string;
  messages: ChatMessage[];
}
