import { API_BASE } from './apiBase';
import { apiFetch as fetch } from './client';

export interface PersonaResponse {
  avatarId: string;
  name: string;
  persona: string;
}

export interface PersonaPreviewResponse {
  systemPrompt: string;
  diff: {
    added: string[];
    removed: string[];
  };
  tokenDelta: number;
  preview: {
    oldLength: number;
    newLength: number;
    oldTokens: number;
    newTokens: number;
  };
}

export interface PersonaUpdateResponse extends PersonaResponse {
  updatedAt: number;
  updatedBy?: string;
  tokenDelta: number;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function getPersona(avatarId: string): Promise<PersonaResponse> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/persona`, {
    credentials: 'include',
  });
  return readJson<PersonaResponse>(response);
}

export async function previewPersona(
  avatarId: string,
  persona: string,
): Promise<PersonaPreviewResponse> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/persona/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ persona }),
  });
  return readJson<PersonaPreviewResponse>(response);
}

export async function updatePersona(
  avatarId: string,
  persona: string,
): Promise<PersonaUpdateResponse> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/persona`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ persona }),
  });
  return readJson<PersonaUpdateResponse>(response);
}
