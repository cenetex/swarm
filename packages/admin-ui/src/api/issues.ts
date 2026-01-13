/**
 * Issues API - Agent-reported issues endpoint.
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface AgentIssue {
  id: string;
  timestamp: number;
  agentId: string;
  platform: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  description: string;
  userMessage?: string;
  context?: Record<string, unknown>;
  logStream?: string;
}

export interface AgentIssuesResponse {
  agentId: string;
  issues: AgentIssue[];
}

export interface IssueQueryOptions {
  limit?: number;
  status?: 'open' | 'resolved' | 'all';
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export async function fetchAgentIssues(
  agentId: string,
  options: IssueQueryOptions = {}
): Promise<AgentIssuesResponse> {
  const params = new URLSearchParams();

  if (options.limit) params.set('limit', String(options.limit));
  if (options.status) params.set('status', options.status);
  if (options.severity) params.set('severity', options.severity);

  const url = `${API_BASE}/agents/${agentId}/issues${params.toString() ? `?${params}` : ''}`;

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
