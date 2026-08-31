import { API_BASE } from './api/apiBase';
import type { PortableAvatarBundleV1 } from '@swarm/core/hosted';

export type HostedProviderStatus = {
  connected: boolean;
  provider: 'openrouter' | null;
};

export type HostedAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  slug?: string;
  visibility?: 'public' | 'private';
  listed?: boolean;
  revisionId?: string;
};

export type PublicHostedAvatar = {
  avatarId: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public';
  listed: boolean;
  revisionId: string;
  controller: string;
  createdAt: number;
  updatedAt: number;
};

export type PublicHostedAvatarProject = PublicHostedAvatar & {
  sha256: string;
  bundle: PortableAvatarBundleV1;
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

export type HostedTelegramGroup = {
  chatId: string;
  title: string;
  type: string;
  enabled: boolean;
  membershipStatus: 'member' | 'administrator' | 'restricted' | 'left' | 'kicked' | 'unknown';
  lastActivityAt?: number;
};

export type HostedTelegramStatus = {
  connected: boolean;
  status: 'disconnected' | 'binding_required' | 'connected' | 'repair_needed';
  bot?: { id: string; username: string; name: string };
  ownerBound: boolean;
  ownerBindUrl?: string;
  addToGroupUrl?: string;
  groupBindCommand?: string;
  groups: HostedTelegramGroup[];
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

export async function listPublicHostedAvatars(): Promise<PublicHostedAvatar[]> {
  return requestJson<PublicHostedAvatar[]>('/public/avatars');
}

export async function getPublicHostedAvatar(slug: string): Promise<PublicHostedAvatarProject> {
  return requestJson<PublicHostedAvatarProject>(`/public/avatars/${encodeURIComponent(slug)}`);
}

export function publicHostedAvatarBundleUrl(slug: string): string {
  return `${API_BASE}/public/avatars/${encodeURIComponent(slug)}/bundle`;
}

export function publicHostedAvatarNftMetadataUrl(slug: string): string {
  return `${API_BASE}/public/avatars/${encodeURIComponent(slug)}/nft-metadata`;
}

export type CreateHostedAvatarInput = {
  name: string;
  description?: string;
  persona?: string;
  visibility?: 'public' | 'private';
  listed?: boolean;
};

export async function createHostedAvatar(input: string | CreateHostedAvatarInput): Promise<HostedAvatar> {
  const body = typeof input === 'string' ? { name: input } : input;
  return requestJson<HostedAvatar>('/avatars', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function importHostedAvatar(bundle: unknown): Promise<HostedAvatar> {
  return requestJson<HostedAvatar>('/avatars/import', {
    method: 'POST',
    body: JSON.stringify({ bundle }),
  });
}

export function ownedHostedAvatarBundleUrl(avatarId: string): string {
  return `${API_BASE}/avatars/${encodeURIComponent(avatarId)}/bundle`;
}

export async function updateHostedAvatarProfile(
  avatarId: string,
  profile: { name: string; description: string; persona: string },
): Promise<HostedAvatar> {
  return requestJson<HostedAvatar>(`/avatars/${encodeURIComponent(avatarId)}`, {
    method: 'PATCH',
    body: JSON.stringify(profile),
  });
}

export async function updateHostedAvatarPublication(
  avatarId: string,
  publication: { visibility: 'public' | 'private'; listed: boolean },
): Promise<HostedAvatar> {
  return requestJson<HostedAvatar>(`/avatars/${encodeURIComponent(avatarId)}/publication`, {
    method: 'PATCH',
    body: JSON.stringify(publication),
  });
}

export async function getHostedTelegramStatus(avatarId: string): Promise<HostedTelegramStatus> {
  return requestJson<HostedTelegramStatus>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram`,
  );
}

export async function connectHostedTelegram(
  avatarId: string,
  botToken: string,
): Promise<HostedTelegramStatus> {
  return requestJson<HostedTelegramStatus>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram`,
    { method: 'POST', body: JSON.stringify({ botToken }) },
  );
}

export async function repairHostedTelegram(avatarId: string): Promise<HostedTelegramStatus> {
  return requestJson<HostedTelegramStatus>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram/repair`,
    { method: 'POST' },
  );
}

export async function disconnectHostedTelegram(avatarId: string): Promise<void> {
  await requestJson<{ disconnected: true }>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram`,
    { method: 'DELETE' },
  );
}

export async function setHostedTelegramGroupEnabled(
  avatarId: string,
  chatId: string,
  enabled: boolean,
): Promise<HostedTelegramStatus> {
  return requestJson<HostedTelegramStatus>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram/groups/${encodeURIComponent(chatId)}`,
    { method: 'PATCH', body: JSON.stringify({ enabled }) },
  );
}

export async function forgetHostedTelegramGroup(
  avatarId: string,
  chatId: string,
): Promise<HostedTelegramStatus> {
  return requestJson<HostedTelegramStatus>(
    `/avatars/${encodeURIComponent(avatarId)}/integrations/telegram/groups/${encodeURIComponent(chatId)}`,
    { method: 'DELETE' },
  );
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
