/**
 * Avatar Health API — fetches health summaries for admin dashboard.
 */
import { API_BASE } from './apiBase';

export interface AvatarHealthSummary {
  avatarId: string;
  name: string;
  status: string;
  memoryCounts: {
    immediate: number;
    recent: number;
    core: number;
    total: number;
  };
  lastActiveAt: number;
  consolidationStatus: 'healthy' | 'needs_consolidation' | 'empty' | 'unknown';
  errorCount: number;
}

export interface AvatarHealthResponse {
  avatars: AvatarHealthSummary[];
  total: number;
  cursor?: string;
}

/**
 * Fetch paginated avatar health summaries (admin only).
 */
export async function getAvatarHealth(
  limit = 20,
  cursor?: string,
): Promise<AvatarHealthResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const response = await fetch(`${API_BASE}/avatars/health?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
