/**
 * Telegram Sticker Pack Service
 * Manages sticker packs for agents
 */
import { _getSecretValueInternal } from './secrets.js';
import * as agents from './agents.js';
import * as gallery from './gallery.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface StickerSet {
  name: string;
  title: string;
  sticker_type: string;
  stickers: Array<{
    file_id: string;
    file_unique_id: string;
    type: string;
    width: number;
    height: number;
    is_animated: boolean;
    is_video: boolean;
  }>;
}

/**
 * Get bot token for an agent
 */
async function getBotToken(agentId: string): Promise<string | null> {
  return _getSecretValueInternal(agentId, 'telegram_bot_token', 'default');
}

/**
 * Make a Telegram API call
 */
async function telegramApi<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
  file?: { field: string; data: Buffer; filename: string }
): Promise<TelegramResponse<T>> {
  const url = `${TELEGRAM_API}${botToken}/${method}`;

  let body: BodyInit;
  const headers: Record<string, string> = {};

  if (file) {
    const formData = new FormData();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        formData.append(key, String(value));
      }
    }
    formData.append(file.field, new Blob([file.data]), file.filename);
    body = formData;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params || {});
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  return response.json() as Promise<TelegramResponse<T>>;
}

/**
 * Create a sticker pack for an agent
 */
export async function createStickerPack(
  agentId: string,
  userId: number, // Telegram user ID of the pack owner
  options: {
    name?: string;
    title?: string;
  } = {}
): Promise<{ success: boolean; name?: string; error?: string }> {
  const botToken = await getBotToken(agentId);
  if (!botToken) {
    return { success: false, error: 'No Telegram bot token configured' };
  }

  // Get bot info for the pack name suffix
  const botInfo = await telegramApi<{ username: string }>(botToken, 'getMe');
  if (!botInfo.ok || !botInfo.result) {
    return { success: false, error: 'Failed to get bot info' };
  }

  const agent = await agents.getAgent(agentId);
  if (!agent) {
    return { success: false, error: 'Agent not found' };
  }

  // Generate pack name (must end with _by_<bot_username>)
  const baseName = options.name || agent.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const packName = `${baseName}_by_${botInfo.result.username}`;
  const packTitle = options.title || `${agent.name}'s Stickers`;

  // Get the first sticker from gallery to create the pack
  const stickers = await gallery.getGallery(agentId, { type: 'sticker', limit: 1 });
  if (stickers.length === 0) {
    return { success: false, error: 'No stickers in gallery. Generate a sticker first.' };
  }

  // Download the sticker
  const stickerResponse = await fetch(stickers[0].url);
  if (!stickerResponse.ok) {
    return { success: false, error: 'Failed to download sticker' };
  }
  const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());

  // Create the sticker pack
  const result = await telegramApi(
    botToken,
    'createNewStickerSet',
    {
      user_id: userId,
      name: packName,
      title: packTitle,
      stickers: JSON.stringify([{
        sticker: 'attach://sticker',
        emoji_list: ['😀'],
        format: 'static',
      }]),
    },
    { field: 'sticker', data: stickerBuffer, filename: 'sticker.webp' }
  );

  if (!result.ok) {
    return { success: false, error: result.description || 'Failed to create sticker pack' };
  }

  // Update agent with sticker pack info
  await agents.updateAgent(agentId, {
    stickerPack: {
      name: packName,
      title: packTitle,
      stickerCount: 1,
      createdAt: Date.now(),
    },
  }, { email: 'system', userId: 'system', isAdmin: true, accessToken: '' });

  return { success: true, name: packName };
}

/**
 * Add a sticker to an agent's pack
 */
export async function addStickerToPack(
  agentId: string,
  stickerId: string,
  emoji: string = '😀'
): Promise<{ success: boolean; error?: string }> {
  const botToken = await getBotToken(agentId);
  if (!botToken) {
    return { success: false, error: 'No Telegram bot token configured' };
  }

  const agent = await agents.getAgent(agentId);
  if (!agent?.stickerPack) {
    return { success: false, error: 'No sticker pack created. Create a pack first.' };
  }

  // Get the sticker from gallery
  const sticker = await gallery.getGalleryItem(agentId, stickerId);
  if (!sticker || sticker.type !== 'sticker') {
    return { success: false, error: 'Sticker not found in gallery' };
  }

  // Download the sticker
  const stickerResponse = await fetch(sticker.url);
  if (!stickerResponse.ok) {
    return { success: false, error: 'Failed to download sticker' };
  }
  const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());

  // We need the owner's user_id to add stickers - this is a limitation
  // For now, we'll need to store this when creating the pack
  // This is a simplified version that assumes we have a way to get the user_id

  // Add to pack
  const result = await telegramApi(
    botToken,
    'addStickerToSet',
    {
      // user_id needs to be stored when pack is created
      // For now, this is a placeholder
      name: agent.stickerPack.name,
      sticker: JSON.stringify({
        sticker: 'attach://sticker',
        emoji_list: [emoji],
        format: 'static',
      }),
    },
    { field: 'sticker', data: stickerBuffer, filename: 'sticker.webp' }
  );

  if (!result.ok) {
    return { success: false, error: result.description || 'Failed to add sticker' };
  }

  // Update sticker count
  await agents.updateAgent(agentId, {
    stickerPack: {
      ...agent.stickerPack,
      stickerCount: agent.stickerPack.stickerCount + 1,
    },
  }, { email: 'system', userId: 'system', isAdmin: true, accessToken: '' });

  return { success: true };
}

/**
 * Get sticker pack info
 */
export async function getStickerPack(
  agentId: string
): Promise<StickerSet | null> {
  const botToken = await getBotToken(agentId);
  if (!botToken) {
    return null;
  }

  const agent = await agents.getAgent(agentId);
  if (!agent?.stickerPack) {
    return null;
  }

  const result = await telegramApi<StickerSet>(botToken, 'getStickerSet', {
    name: agent.stickerPack.name,
  });

  return result.ok ? result.result || null : null;
}

/**
 * Send a sticker in a chat
 */
export async function sendSticker(
  agentId: string,
  chatId: number | string,
  stickerId: string,
  replyToMessageId?: number
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  const botToken = await getBotToken(agentId);
  if (!botToken) {
    return { success: false, error: 'No Telegram bot token configured' };
  }

  // Get the sticker from gallery
  const sticker = await gallery.getGalleryItem(agentId, stickerId);
  if (!sticker || sticker.type !== 'sticker') {
    return { success: false, error: 'Sticker not found in gallery' };
  }

  // Download the sticker
  const stickerResponse = await fetch(sticker.url);
  if (!stickerResponse.ok) {
    return { success: false, error: 'Failed to download sticker' };
  }
  const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());

  const result = await telegramApi<{ message_id: number }>(
    botToken,
    'sendSticker',
    {
      chat_id: chatId,
      reply_to_message_id: replyToMessageId,
    },
    { field: 'sticker', data: stickerBuffer, filename: 'sticker.webp' }
  );

  if (!result.ok) {
    return { success: false, error: result.description || 'Failed to send sticker' };
  }

  return { success: true, messageId: result.result?.message_id };
}
