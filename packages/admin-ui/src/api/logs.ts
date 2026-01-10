/**
 * Logs API - Consolidated agent logs endpoint.
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface AgentLogEvent {
  timestamp?: string;
  message?: string;
  logGroup?: string;
  logStream?: string;
}

export interface AgentLogResponse {
  agentId: string;
  startTime: number;
  endTime: number;
  logGroups: string[];
  filters: {
    level?: string;
    subsystem?: string;
    query?: string;
    limit: number;
  };
  events: AgentLogEvent[];
}

export interface LogQueryOptions {
  level?: string;
  subsystem?: string;
  since?: string;
  limit?: number;
  query?: string;
  start?: number;
  end?: number;
}

export async function fetchAgentLogs(
  agentId: string,
  options: LogQueryOptions = {}
): Promise<AgentLogResponse> {
  const params = new URLSearchParams();

  if (options.level) params.set('level', options.level);
  if (options.subsystem) params.set('subsystem', options.subsystem);
  if (options.since) params.set('since', options.since);
  if (options.query) params.set('query', options.query);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.start) params.set('start', String(options.start));
  if (options.end) params.set('end', String(options.end));

  const url = `${API_BASE}/agents/${agentId}/logs${params.toString() ? `?${params}` : ''}`;

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
