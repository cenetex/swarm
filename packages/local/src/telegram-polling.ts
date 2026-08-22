/**
 * Local Telegram Bot Polling Service
 *
 * Polls getUpdates, maintains per-chat conversation history
 * via the chat-history store, and routes through processChat.
 */
import { Bot } from "grammy";
import type { UserSession } from "@swarm/admin-api";

type LocalChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

export interface TelegramPollingDeps {
  getToken: () => Promise<string | null>;
  processMessage: (text: string, history: LocalChatMessage[], session: UserSession, avatarId: string) => Promise<{response:string;history:LocalChatMessage[]}>;
  getAvatarId: () => Promise<string | null>;
  loadHistory: (session: UserSession, avatarId: string) => Promise<LocalChatMessage[]>;
  saveHistory: (session: UserSession, avatarId: string, history: LocalChatMessage[]) => Promise<void>;
}

const HISTORY_CACHE_MAX_ENTRIES = 200;

export function startTelegramPolling(deps: TelegramPollingDeps): () => void {
  let bot: Bot | null = null;
  let running = true;
  let lastUpdateId = 0;
  const historyCache = new Map<string, LocalChatMessage[]>();

  function sessionFor(chatId: string): UserSession {
    return { email: `tg-${chatId}@local.swarm`, userId: `tg-${chatId}`, isAdmin: false, accessToken: 'local-telegram' };
  }

  async function getHistory(chatId: string, avatarId: string) {
    if (historyCache.has(chatId)) return historyCache.get(chatId)!;
    try { const h = await deps.loadHistory(sessionFor(chatId), avatarId); historyCache.set(chatId, h); if (historyCache.size > HISTORY_CACHE_MAX_ENTRIES) { const oldest = historyCache.keys().next().value; if (oldest) historyCache.delete(oldest); } return h; }
    catch { return []; }
  }

  async function poll() {
    while (running) {
      try {
        const token = await deps.getToken();
        if (!token) { await sleep(10000); continue; }
        if (!bot || bot.token !== token) bot = new Bot(token);

        const updates = await bot.api.getUpdates({ offset: lastUpdateId + 1, timeout: 30, allowed_updates: ["message"] });
        for (const u of updates) {
          lastUpdateId = u.update_id;
          const msg = u.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          try {
            const avatarId = await deps.getAvatarId();
            if (!avatarId) { await bot.api.sendMessage(chatId, "No avatar yet. Create one in the app."); continue; }
            const session = sessionFor(chatId);
            const history = await getHistory(chatId, avatarId);
            const result = await deps.processMessage(msg.text, history, session, avatarId);
            historyCache.set(chatId, result.history);
            if (historyCache.size > HISTORY_CACHE_MAX_ENTRIES) { const oldest = historyCache.keys().next().value; if (oldest) historyCache.delete(oldest); }
            deps.saveHistory(session, avatarId, result.history).catch(() => {});
            if (result.response) await bot.api.sendMessage(chatId, result.response.slice(0, 4096));
          } catch (err) {
            console.error("[local] Telegram msg error:", err);
            try { await bot.api.sendMessage(chatId, "Sorry, something went wrong."); } catch {
              // Ignore secondary notification failures while polling continues.
            }
          }
        }
      } catch (err) {
        console.error("[local] Telegram poll error:", err);
        await sleep(5000);
      }
    }
  }

  poll();
  return () => { running = false; };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
