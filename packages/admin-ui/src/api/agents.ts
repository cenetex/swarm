/**
 * Avatars API - Backend calls for avatar CRUD operations
 */
import { API_BASE } from './apiBase';

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

export interface AvatarResponse {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell' | 'configured' | 'active' | 'error' | 'draft' | 'paused';
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
 * Create a new avatar
 */
export async function createAvatar(name: string, description?: string): Promise<AvatarResponse> {
  const response = await fetch(`${API_BASE}/avatars`, {
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
 * List all avatars
 */
export async function listAvatars(): Promise<AvatarResponse[]> {
  const response = await fetch(`${API_BASE}/avatars`, {
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
 * Get a single avatar
 */
export async function getAvatar(avatarId: string): Promise<AvatarResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}`, {
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
 * Update an avatar
 */
export async function updateAvatar(
  avatarId: string,
  updates: Partial<Pick<AvatarResponse, 'name' | 'description' | 'persona' | 'profileImage' | 'characterReference' | 'llmConfig' | 'mediaConfig' | 'voiceConfig' | 'platforms'>>
): Promise<AvatarResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}`, {
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
 * Delete an avatar
 */
export async function deleteAvatar(avatarId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Toggle a feature on/off for an avatar
 */
export type ToggleableFeature = 'media' | 'voice' | 'twitter' | 'telegram' | 'discord';

export async function toggleFeature(
  avatarId: string,
  feature: ToggleableFeature,
  enabled: boolean
): Promise<AvatarResponse> {
  // Map feature names to their config paths
  const updates: Partial<AvatarResponse> = {};

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

  return updateAvatar(avatarId, updates);
}
