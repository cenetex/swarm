/**
 * Issues API - Avatar-reported issues endpoint.
 */
import { API_BASE } from './apiBase';
import { apiFetch as fetch } from './client';

export interface AvatarIssue {
  id: string;
  timestamp: number;
  avatarId: string;
  platform: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  description: string;
  userMessage?: string;
  context?: Record<string, unknown>;
  logStream?: string;
}

export interface AvatarIssuesResponse {
  avatarId: string;
  issues: AvatarIssue[];
}

export interface IssueQueryOptions {
  limit?: number;
  status?: 'open' | 'resolved' | 'all';
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export async function fetchAvatarIssues(
  avatarId: string,
  options: IssueQueryOptions = {}
): Promise<AvatarIssuesResponse> {
  const params = new URLSearchParams();

  if (options.limit) params.set('limit', String(options.limit));
  if (options.status) params.set('status', options.status);
  if (options.severity) params.set('severity', options.severity);

  const url = `${API_BASE}/avatars/${avatarId}/issues${params.toString() ? `?${params}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
