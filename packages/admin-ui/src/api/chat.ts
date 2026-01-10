const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface ChatResponse {
  response: string;
  history: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
  }>;
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
