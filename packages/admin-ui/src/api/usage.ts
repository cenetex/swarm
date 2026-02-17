/**
 * Usage Metering API
 * Fetches avatar usage data and limits for inline chat display.
 */
import { API_BASE } from './apiBase';

export interface UsageMeter {
  used: number;
  limit: number;
  label: string;
}

export interface ToolCreditStatus {
  used: number;
  limit: number;
  remaining: number;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
}

export interface UsageEnergy {
  current: number;
  max: number;
  refillPerHour: number;
  bankCredits?: number;
}

export interface UsageResponse {
  avatarId: string;
  date: string;
  plan: string;
  source: string;
  meters: {
    messages: UsageMeter;
    media: UsageMeter;
    voice: UsageMeter;
  };
  toolCredits: Record<string, ToolCreditStatus>;
  energy: UsageEnergy | null;
}

export interface DailyUsageSummary {
  date: string;
  messagesProcessed: number;
  mediaCreditsUsed: number;
  voiceMinutesUsed: number;
  toolCallsMade: number;
  imageGenerations: number;
  videoGenerations: number;
  stickerGenerations: number;
}

export interface UsageHistoryResponse {
  avatarId: string;
  days: number;
  history: DailyUsageSummary[];
}

/**
 * Get current usage vs limits for an avatar
 */
export async function getAvatarUsage(avatarId: string): Promise<UsageResponse> {
  const response = await fetch(
    `${API_BASE}/avatars/${encodeURIComponent(avatarId)}/usage`,
    {
      method: 'GET',
      credentials: 'include',
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get historical daily usage for an avatar
 */
export async function getAvatarUsageHistory(
  avatarId: string,
  days: number = 7,
): Promise<UsageHistoryResponse> {
  const response = await fetch(
    `${API_BASE}/avatars/${encodeURIComponent(avatarId)}/usage/history?days=${days}`,
    {
      method: 'GET',
      credentials: 'include',
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
