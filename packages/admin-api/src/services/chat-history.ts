/**
 * Chat History Service
 * Persists chat history per user/avatar for cross-device sync
 */
import type { AdminChatMessage, UserSession } from '../types.js';
import { createChatHistoryStore, type ChatHistoryRecord } from './chat-history-store.js';
import { getDynamoClient } from './dynamo-client.js';
import { sanitizeMessages } from '../handlers/chat-tool-helpers.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const CHAT_HISTORY_TTL_HOURS_RAW = Number(process.env.CHAT_HISTORY_TTL_HOURS || '24');
const CHAT_HISTORY_TTL_HOURS = Number.isFinite(CHAT_HISTORY_TTL_HOURS_RAW) ? CHAT_HISTORY_TTL_HOURS_RAW : 24;
const CHAT_HISTORY_TTL_SECONDS = Math.max(0, CHAT_HISTORY_TTL_HOURS) * 60 * 60;

const store = createChatHistoryStore({
  dynamoClient,
  tableName: ADMIN_TABLE,
  ttlSeconds: CHAT_HISTORY_TTL_SECONDS,
});

/**
 * Get chat history for a user/avatar combination
 */
export async function getChatHistory(
  session: UserSession,
  avatarId?: string
): Promise<AdminChatMessage[]> {
  const raw = await store.getChatHistory(session, avatarId);
  // Sanitize on load: strip orphaned tool results that may have been
  // persisted before sanitization was added at save time.
  return sanitizeMessages(raw);
}

/**
 * Save chat history for a user/avatar combination
 */
export async function saveChatHistory(
  session: UserSession,
  messages: AdminChatMessage[],
  avatarId?: string
): Promise<void> {
  await store.saveChatHistory(session, messages, avatarId);
}

/**
 * Clear chat history for a user/avatar combination
 */
export async function clearChatHistory(
  session: UserSession,
  avatarId?: string
): Promise<void> {
  await store.clearChatHistory(session, avatarId);
}

/**
 * Append a system message to chat history
 * Used for persisting status updates (OAuth success, errors, etc.) that both AI and users should see
 */
export async function appendSystemMessage(
  session: UserSession,
  avatarId: string,
  message: { role: 'assistant' | 'user'; content: string }
): Promise<AdminChatMessage[]> {
  const history = await store.getChatHistory(session, avatarId);
  const newMessage: AdminChatMessage = {
    role: message.role,
    content: message.content,
  };
  const updatedHistory = [...history, newMessage];
  await store.saveChatHistory(session, updatedHistory, avatarId);
  return updatedHistory;
}

export type { ChatHistoryRecord };
