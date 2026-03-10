import { API_BASE } from './apiBase';

export interface SharedChatMessage {
  id: string;
  channelId: string;
  content: string;
  sender: {
    walletAddress: string;
    displayName?: string;
    avatarUrl?: string;
  };
  timestamp: number;
  replyToId?: string;
}

export interface ChannelAvatarInfo {
  avatarId: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  persona?: string;
  connectedPlatforms?: string[];
}

export async function getSharedChatMessages(channelId: string): Promise<{
  messages: SharedChatMessage[];
  sender?: SharedChatMessage['sender'];
  avatar?: ChannelAvatarInfo;
}> {
  const response = await fetch(`${API_BASE}/shared-chat/messages?channelId=${encodeURIComponent(channelId)}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to load messages');
  }

  return response.json() as Promise<{
    messages: SharedChatMessage[];
    sender?: SharedChatMessage['sender'];
    avatar?: ChannelAvatarInfo;
  }>;
}

/**
 * Get avatar info for a channel (public, no auth required)
 */
export async function getChannelAvatar(channelId: string): Promise<{ avatar: ChannelAvatarInfo | null }> {
  const response = await fetch(`${API_BASE}/shared-chat/avatar?channelId=${encodeURIComponent(channelId)}`);

  if (!response.ok) {
    if (response.status === 404) {
      return { avatar: null };
    }
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to load avatar info');
  }

  return response.json() as Promise<{ avatar: ChannelAvatarInfo }>;
}

export interface SendMessageResult {
  message: SharedChatMessage;
  avatarResponse?: SharedChatMessage;
}

/**
 * Custom error class for rate limiting
 */
export class RateLimitError extends Error {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export async function sendSharedChatMessage(channelId: string, content: string, replyToId?: string): Promise<SendMessageResult> {
  const response = await fetch(`${API_BASE}/shared-chat/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ channelId, content, replyToId }),
  });

  if (!response.ok) {
    // Handle rate limiting
    if (response.status === 429) {
      const data = await response.json().catch(() => ({ retryAfter: 60 })) as { error?: string; retryAfter?: number };
      throw new RateLimitError(
        data.error || 'Too many messages. Please slow down.',
        data.retryAfter || 60
      );
    }
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to send message');
  }

  const data = await response.json() as { message: SharedChatMessage; avatarResponse?: SharedChatMessage };
  return { message: data.message, avatarResponse: data.avatarResponse };
}

/**
 * Get typing indicator status for a channel
 */
export async function getTypingStatus(channelId: string): Promise<{ typing: boolean; avatarName?: string }> {
  const response = await fetch(`${API_BASE}/shared-chat/typing?channelId=${encodeURIComponent(channelId)}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    return { typing: false };
  }

  return response.json() as Promise<{ typing: boolean; avatarName?: string }>;
}

export async function getSharedChatIdentity(): Promise<{ sender?: SharedChatMessage['sender'] }> {
  const response = await fetch(`${API_BASE}/shared-chat/identity`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to load identity');
  }

  return response.json() as Promise<{ sender?: SharedChatMessage['sender'] }>;
}
