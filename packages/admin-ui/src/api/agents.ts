/**
 * Agents API - Backend calls for agent CRUD operations
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface LlmConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  useGlobalKey: boolean;
}

export interface MediaConfig {
  enabled: boolean;
  provider?: string;
}

export interface VoiceConfig {
  enabled: boolean;
  provider?: string;
}

export interface PlatformConfig {
  enabled: boolean;
  botUsername?: string;
  username?: string;
  guildId?: string;
}

export interface AgentResponse {
  agentId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell' | 'configured' | 'active' | 'error';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  mediaConfig?: MediaConfig;
  voiceConfig?: VoiceConfig;
  platforms?: {
    telegram?: PlatformConfig;
    twitter?: PlatformConfig;
    discord?: PlatformConfig;
  };
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
  telegram?: {
    botUsername: string;
    enabled: boolean;
  };
  twitter?: {
    username: string;
    enabled: boolean;
  };
  llmConfig?: LlmConfig;
}

/**
 * Create a new agent
 */
export async function createAgent(name: string, description?: string): Promise<AgentResponse> {
  const response = await fetch(`${API_BASE}/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ name, description }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * List all agents
 */
export async function listAgents(): Promise<AgentResponse[]> {
  const response = await fetch(`${API_BASE}/agents`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get a single agent
 */
export async function getAgent(agentId: string): Promise<AgentResponse> {
  const response = await fetch(`${API_BASE}/agents/${agentId}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Update an agent
 */
export async function updateAgent(
  agentId: string,
  updates: Partial<Pick<AgentResponse, 'name' | 'description' | 'persona' | 'profileImage' | 'characterReference' | 'llmConfig' | 'mediaConfig' | 'voiceConfig' | 'platforms'>>
): Promise<AgentResponse> {
  const response = await fetch(`${API_BASE}/agents/${agentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Delete an agent
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/agents/${agentId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Toggle a feature on/off for an agent
 */
export type ToggleableFeature = 'media' | 'voice' | 'twitter' | 'telegram' | 'discord';

export async function toggleFeature(
  agentId: string,
  feature: ToggleableFeature,
  enabled: boolean
): Promise<AgentResponse> {
  // Map feature names to their config paths
  const updates: Partial<AgentResponse> = {};

  switch (feature) {
    case 'media':
      updates.mediaConfig = { enabled };
      break;
    case 'voice':
      updates.voiceConfig = { enabled };
      break;
    case 'twitter':
    case 'telegram':
    case 'discord':
      updates.platforms = {
        [feature]: { enabled },
      };
      break;
  }

  return updateAgent(agentId, updates);
}
