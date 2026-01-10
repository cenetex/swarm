const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface MediaItem {
  type: 'image' | 'video' | 'sticker';
  url: string;
  prompt?: string;
  id?: string;
}

interface PendingJob {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  prompt?: string;
}

interface ChatResponse {
  response: string;
  history: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
  }>;
  media?: MediaItem[];
  pendingJobs?: PendingJob[];
  pendingToolCall?: PendingToolCall;
  error?: string;
}

interface AgentContext {
  id: string;
  name: string;
  description?: string;
  persona?: string;
}

/**
 * Send a chat message to the admin API
 */
export async function sendChatMessage(
  message: string,
  history: Array<{ role: string; content: string }>,
  agent?: AgentContext
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // CF Access token is automatically included via cookie/header by Cloudflare
    },
    credentials: 'include',
    body: JSON.stringify({
      message,
      history: history.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      // Pass agent context so the LLM knows which agent it IS
      agent: agent ? {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        persona: agent.persona,
      } : undefined,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Submit a tool call result (e.g., secret input)
 */
export async function submitToolResult(
  agentId: string,
  toolCallId: string,
  result: unknown
): Promise<void> {
  const response = await fetch(`${API_BASE}/agents/${agentId}/tools/${toolCallId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ result }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Save a secret for an agent
 */
export async function saveAgentSecret(
  agentId: string,
  secretKey: string,
  secretValue: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/agents/${agentId}/secrets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ key: secretKey, value: secretValue }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Check if user is authenticated
 */
export async function checkAuth(): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const response = await fetch(`${API_BASE}/health`, {
      credentials: 'include',
    });
    
    if (response.ok) {
      return { authenticated: true };
    }
    
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Fetch chat history from backend (for cross-device sync)
 */
export async function fetchChatHistory(
  agentId?: string
): Promise<Array<{ role: string; content: string }>> {
  const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const response = await fetch(`${API_BASE}/chat${params}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.history || [];
}

/**
 * Clear chat history on the backend
 */
export async function clearChatHistory(agentId?: string): Promise<void> {
  const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const response = await fetch(`${API_BASE}/chat${params}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

// ============================================================================
// Job Status Polling (for async image/video generation)
// ============================================================================

export interface JobStatus {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resultUrl?: string;
  url?: string; // Alias for resultUrl for compatibility
  error?: string;
}

/**
 * Get the status of a specific job
 */
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get all pending jobs for an agent
 */
export async function getPendingJobs(agentId: string): Promise<{ count: number; jobs: JobStatus[] }> {
  const response = await fetch(`${API_BASE}/jobs?agentId=${encodeURIComponent(agentId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Poll for job completion
 * Returns the completed job status or throws if the job fails
 */
export async function pollJobCompletion(
  jobId: string,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
    onProgress?: (status: JobStatus) => void;
  } = {}
): Promise<JobStatus> {
  const { maxAttempts = 120, intervalMs = 2000, onProgress } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getJobStatus(jobId);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'completed') {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(status.error || 'Job failed');
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Job timed out');
}
