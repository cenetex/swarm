import { API_BASE } from './api/apiBase';

export type HostedProviderStatus = {
  connected: boolean;
  provider: 'openrouter' | null;
};

export type HostedAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type HostedChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type HostedChatJob = {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  response?: string;
  history?: HostedChatMessage[];
  error?: string;
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw await responseError(response, `Hosted request failed with status ${response.status}.`);
  return response.json() as Promise<T>;
}

export function openRouterConnectUrl(): string {
  return `${API_BASE}/auth/openrouter`;
}

export function openRouterResult(search: string): 'connected' | 'error' | null {
  const result = new URLSearchParams(search).get('openrouter');
  return result === 'connected' || result === 'error' ? result : null;
}

export async function getHostedProviderStatus(): Promise<HostedProviderStatus> {
  return requestJson<HostedProviderStatus>('/auth/openrouter/status');
}

export async function disconnectHostedProvider(): Promise<HostedProviderStatus> {
  return requestJson<HostedProviderStatus>('/auth/openrouter', { method: 'DELETE' });
}

export async function listHostedAvatars(): Promise<HostedAvatar[]> {
  return requestJson<HostedAvatar[]>('/avatars');
}

export async function createHostedAvatar(name: string): Promise<HostedAvatar> {
  return requestJson<HostedAvatar>('/avatars', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function getHostedHistory(avatarId: string): Promise<HostedChatMessage[]> {
  const result = await requestJson<{ history: HostedChatMessage[] }>(
    `/chat?avatarId=${encodeURIComponent(avatarId)}`,
  );
  return result.history;
}

export async function enqueueHostedMessage(avatarId: string, message: string): Promise<{ jobId: string }> {
  const requestId = typeof globalThis.crypto?.randomUUID === 'function'
    ? `request_${globalThis.crypto.randomUUID()}`
    : `request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return requestJson<{ jobId: string }>('/chat', {
    method: 'POST',
    body: JSON.stringify({
      requestId,
      message,
      avatar: { id: avatarId },
      history: [],
    }),
  });
}

export async function getHostedJob(jobId: string): Promise<HostedChatJob> {
  return requestJson<HostedChatJob>(`/jobs/${encodeURIComponent(jobId)}`);
}

export async function waitForHostedJob(
  jobId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<HostedChatJob> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getHostedJob(jobId);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { jobId, status: 'failed', error: 'The hosted response timed out.' };
}
