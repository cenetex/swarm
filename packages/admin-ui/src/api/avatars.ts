/**
 * Avatars API - Backend calls for avatar CRUD operations
 * Note: API paths remain as /avatars/* for backend compatibility
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
  // Telegram-specific policy
  allowedChatIds?: string[];
  allowedDmUserIds?: string[];
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
  // Wallet ownership (present for wallet-created avatars)
  creatorWallet?: string;
  slotType?: 'free' | 'orb';
  orbMint?: string;
  orbWallet?: string;
  orbSlottedAt?: number;
  currentEra?: number;
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

export async function slotOrb(avatarId: string, mintAddress: string): Promise<{ success: boolean }>{
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/orb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ mintAddress }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function unslotOrb(avatarId: string): Promise<{ success: boolean }>{
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/orb`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
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
 * Activate an avatar (draft/paused -> active)
 * Calls POST /avatars/{id}/activate
 */
export async function activateAvatar(avatarId: string): Promise<{ success: boolean; status: string }> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error?.message || error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Deactivate an avatar (active -> paused)
 * Calls POST /avatars/{id}/deactivate
 */
export async function deactivateAvatar(avatarId: string): Promise<{ success: boolean; status: string }> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/deactivate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
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

/**
 * Reassign avatar ownership (admin-only)
 */
export async function reassignAvatar(
  avatarId: string,
  updates: {
    creatorWallet?: string;
  }
): Promise<AvatarResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/reassign`, {
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

// ============================================================================
// Energy System API
// ============================================================================

export interface EnergyStatus {
  avatarId: string;
  currentEnergy: number;
  maxEnergy: number;
  refillPerHour: number;
  baseRefillPerHour: number;
  bonusRefillPerHour: number;
  ownerTokenBalance: number;
  timeToNextEnergy: number | null;
  timeToFull: number | null;
  bankCredits?: number;
}

export interface EnergyEvent {
  eventId: string;
  timestamp: number;
  eventType: 'consume' | 'refill' | 'set' | 'add';
  energyBefore: number;
  energyAfter: number;
  cost?: number;
  operation?: string;
  message?: string;
}

type ApiEnergyStatus = {
  avatarId: string;
  current: number;
  max: number;
  nextRefillIn: number; // minutes
  refillPerHour: number;
  baseRefillPerHour: number;
  bonusRefillPerHour: number;
  ownerTokenBalance?: number;
  refillCap?: number;
  bankCredits?: number;
};

function toUiEnergyStatus(raw: ApiEnergyStatus): EnergyStatus {
  const currentEnergy = Number(raw.current ?? 0);
  const maxEnergy = Number(raw.max ?? 0);
  const refillPerHour = Number(raw.refillPerHour ?? 0);

  const timeToNextEnergy = typeof raw.nextRefillIn === 'number'
    ? raw.nextRefillIn * 60_000
    : null;

  const timeToFull = (maxEnergy > currentEnergy && refillPerHour > 0)
    ? Math.ceil(((maxEnergy - currentEnergy) / refillPerHour) * 3_600_000)
    : null;

  return {
    avatarId: raw.avatarId,
    currentEnergy,
    maxEnergy,
    refillPerHour,
    baseRefillPerHour: Number(raw.baseRefillPerHour ?? 0),
    bonusRefillPerHour: Number(raw.bonusRefillPerHour ?? 0),
    ownerTokenBalance: Number(raw.ownerTokenBalance ?? 0),
    timeToNextEnergy,
    timeToFull,
    bankCredits: raw.bankCredits,
  };
}

/**
 * Get current energy status for an avatar
 */
export async function getEnergyStatus(avatarId: string): Promise<EnergyStatus> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/energy`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const raw = (await response.json()) as ApiEnergyStatus;
  return toUiEnergyStatus(raw);
}

/**
 * Set energy level for an avatar (admin only)
 */
export async function setEnergy(
  avatarId: string,
  value: number
): Promise<{ avatarId: string; success: boolean; newValue: number }> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/energy/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Add energy to an avatar (admin only)
 */
export async function addEnergy(
  avatarId: string,
  amount: number
): Promise<{ avatarId: string; success: boolean; newValue: number }> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/energy/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ amount }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get energy usage history for an avatar
 */
export async function getEnergyHistory(
  avatarId: string,
  limit = 20
): Promise<{ events: EnergyEvent[] }> {
  const response = await fetch(
    `${API_BASE}/avatars/${encodeURIComponent(avatarId)}/energy/history?limit=${limit}`,
    {
      method: 'GET',
      credentials: 'include',
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const raw = (await response.json()) as {
    avatarId: string;
    events: Array<{
      operation?: string;
      cost?: number;
      energyBefore: number;
      energyAfter: number;
      refillRate?: number;
      timestamp: string;
    }>;
    count?: number;
  };

  const events: EnergyEvent[] = (raw.events || []).map((e, idx) => ({
    eventId: `${raw.avatarId || avatarId}-${idx}-${e.timestamp}`,
    timestamp: Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : Date.now(),
    eventType: 'consume',
    energyBefore: e.energyBefore,
    energyAfter: e.energyAfter,
    cost: e.cost,
    operation: e.operation,
    message: undefined,
  }));

  return { events };
}

/**
 * Burn deposited SPL tokens (allowed mint) from the avatar's Solana wallet into energy bank credits.
 */
export async function burnDepositedTokensForEnergy(
  avatarId: string,
  params?: { mint?: string }
): Promise<unknown> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/energy/burn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ mint: params?.mint }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
