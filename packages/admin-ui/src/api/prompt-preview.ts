/**
 * Prompt Preview API - Shows what would be sent to the LLM.
 */
import { API_BASE } from './apiBase';

export interface ToolPreview {
  name: string;
  description: string;
  toolset: string;
  parameters: Record<string, unknown>;
}

export interface TokenEstimate {
  systemPrompt: number;
  tools: number;
  messages: number;
  total: number;
}

export interface PromptPreviewResponse {
  systemPrompt: string;
  tools: ToolPreview[];
  toolCount: number;
  enabledToolsets: string[];
  enabledCategories: string[];
  messages: Array<{
    role: string;
    content: string;
  }>;
  tokenEstimate: TokenEstimate;
}

export interface PromptPreviewRequest {
  avatarId: string;
  message?: string;
  history?: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
  }>;
}

export async function fetchPromptPreview(
  request: PromptPreviewRequest
): Promise<PromptPreviewResponse> {
  const response = await fetch(`${API_BASE}/prompt-preview`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body?.error || body?.message || `HTTP ${response.status}`;
    const details = body?.details ? ` (${JSON.stringify(body.details)})` : '';
    throw new Error(`${message}${details}`);
  }

  return response.json();
}
