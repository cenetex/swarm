/**
 * Agents API - Backend calls for agent CRUD operations
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface AgentResponse {
  agentId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell' | 'configured' | 'active' | 'error';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  telegram?: {
    botUsername: string;
    enabled: boolean;
  };
  twitter?: {
    username: string;
    enabled: boolean;
  };
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
  updates: Partial<Pick<AgentResponse, 'name' | 'description' | 'persona'>>
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
