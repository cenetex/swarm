import { API_BASE } from './apiBase';
import { apiFetch as fetch } from './client';

export interface TwitterConnectionStatus {
  connected: boolean;
  username?: string;
  userId?: string;
  connectedAt?: number;
}

export async function getTwitterConnectionStatus(avatarId: string): Promise<TwitterConnectionStatus> {
  const response = await fetch(`${API_BASE}/oauth/twitter/status/${encodeURIComponent(avatarId)}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
