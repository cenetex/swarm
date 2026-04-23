/**
 * Telegram integration API client (#1474).
 *
 * Endpoints for the read-only Telegram dashboard: owner binding, aggregated
 * state (one round-trip), and per-row revoke.
 */
import { getApiBase } from './apiBase.js';

const API_BASE = getApiBase();

export interface TelegramBindingInfo {
  telegramUserId?: string;
  telegramUsername?: string;
  boundAt?: number;
}

export interface TelegramAllowedChat {
  chatId: string;
  title?: string;
  username?: string;
}

export interface TelegramAllowedDmUser {
  userId: string;
  username?: string;
  displayName?: string;
}

export interface TelegramPendingDm {
  requesterId: string;
  requesterUsername?: string;
  requesterDisplayName?: string;
  firstMessage: string;
  issuedAt: number;
}

export interface TelegramState {
  botUsername?: string;
  platformEnabled: boolean;
  binding: TelegramBindingInfo | null;
  allowedChats: TelegramAllowedChat[];
  allowedDmUsers: TelegramAllowedDmUser[];
  pendingDms: TelegramPendingDm[];
}

export interface TelegramBindCodeResponse {
  code: string;
  deepLink: string;
  expiresAt: number;
}

async function jsonOr(response: Response, context: string): Promise<unknown> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `${context}: HTTP ${response.status}`);
  }
  return response.json();
}

export async function getTelegramState(avatarId: string): Promise<TelegramState> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/telegram/state`, {
    method: 'GET',
    credentials: 'include',
  });
  return jsonOr(response, 'Failed to fetch Telegram state') as Promise<TelegramState>;
}

export async function issueTelegramBindCode(avatarId: string): Promise<TelegramBindCodeResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/telegram/bind-code`, {
    method: 'POST',
    credentials: 'include',
  });
  return jsonOr(response, 'Failed to issue bind code') as Promise<TelegramBindCodeResponse>;
}

export async function revokeTelegramChat(avatarId: string, chatId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/avatars/${avatarId}/telegram/allowed-chats/${encodeURIComponent(chatId)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  await jsonOr(response, 'Failed to revoke chat');
}

export async function revokeTelegramDmer(avatarId: string, userId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/avatars/${avatarId}/telegram/allowed-dmers/${encodeURIComponent(userId)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  await jsonOr(response, 'Failed to revoke DM access');
}
