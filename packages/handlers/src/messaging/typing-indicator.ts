export type TypingSender = () => Promise<void>;

export function createTypingSender(
  platform: string,
  secrets: Record<string, string>,
  conversationId: string,
): TypingSender | undefined {
  if (platform === 'telegram') {
    return createTelegramTypingSender(secrets, conversationId);
  }
  if (platform === 'discord') {
    return createDiscordTypingSender(secrets, conversationId);
  }
  return undefined;
}

/**
 * Lightweight Telegram typing indicator via raw HTTP (no Grammy dependency).
 * The indicator expires quickly, so callers should refresh it while processing.
 */
export function createTelegramTypingSender(
  secrets: Record<string, string>,
  chatId: string,
): TypingSender | undefined {
  const botToken = secrets.TELEGRAM_BOT_TOKEN || secrets.telegram_bot_token;
  if (!botToken) return undefined;

  return async () => {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });
    } catch { /* non-critical */ }
  };
}

/**
 * Discord native typing indicator. Discord accepts repeated POSTs to keep the
 * channel typing affordance alive while longer LLM/tool work is in progress.
 */
export function createDiscordTypingSender(
  secrets: Record<string, string>,
  channelId: string,
): TypingSender | undefined {
  const botToken = secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token;
  if (!botToken) return undefined;

  return async () => {
    try {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      });
    } catch { /* non-critical */ }
  };
}
