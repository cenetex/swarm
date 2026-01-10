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

/**
 * Send a chat message to the admin API
 */
export async function sendChatMessage(
  message: string,
  history: Array<{ role: string; content: string }>
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
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
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
