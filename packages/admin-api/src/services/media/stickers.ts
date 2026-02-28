/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Sticker Service
 *
 * High-level service for sticker operations that combines:
 * - Image generation (via media service)
 * - Sticker processing (background removal, sizing)
 * - Gallery management (tracking stickers)
 * - Telegram API (sticker pack management)
 */
import * as gallery from './gallery.js';
import * as avatars from '../avatars.js';
import * as media from './media.js';
import { _getSecretValueInternal } from '../secrets.js';
import {
  processImageSourceForSticker,
  uploadStickerToS3,
  generateStickerSetName,
  selectStickerEmoji,
  getStickerSetManifest,
  saveStickerSetManifest,
  type StickerSetManifest,
} from './sticker-processor.js';
import type {
  StickerServices,
  StickerInfo,
  StickerPackInfo,
  GalleryItemForSticker,
} from '@swarm/mcp-server';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || process.env.S3_BUCKET_NAME;

// ============================================================================
// Telegram API Helpers
// ============================================================================

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function getBotToken(avatarId: string): Promise<string | null> {
  return _getSecretValueInternal(avatarId, 'telegram_bot_token', 'default');
}

async function getBotInfo(botToken: string): Promise<{ id: number; username: string } | null> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/getMe`);
  const data = await response.json() as TelegramResponse<{ id: number; username: string }>;
  return data.ok ? data.result || null : null;
}

async function telegramUploadStickerFile(
  botToken: string,
  userId: number,
  stickerBuffer: Buffer
): Promise<{ file_id: string } | null> {
  const formData = new FormData();
  formData.append('user_id', String(userId));
  formData.append('sticker', new Blob([stickerBuffer], { type: 'image/png' }), 'sticker.png');
  formData.append('sticker_format', 'static');

  const response = await fetch(`${TELEGRAM_API}${botToken}/uploadStickerFile`, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json() as TelegramResponse<{ file_id: string }>;
  return data.ok ? data.result || null : null;
}

async function telegramGetStickerSet(
  botToken: string,
  name: string
): Promise<{ name: string; title: string; stickers: Array<{ file_id: string; emoji?: string }> } | null> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/getStickerSet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  const data = await response.json() as TelegramResponse<{
    name: string;
    title: string;
    stickers: Array<{ file_id: string; emoji?: string }>;
  }>;
  return data.ok ? data.result || null : null;
}

async function telegramCreateNewStickerSet(
  botToken: string,
  userId: number,
  name: string,
  title: string,
  stickerFileId: string,
  emoji: string
): Promise<boolean> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/createNewStickerSet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      name,
      title,
      stickers: [{
        sticker: stickerFileId,
        format: 'static',
        emoji_list: [emoji],
      }],
    }),
  });

  const data = await response.json() as TelegramResponse<boolean>;
  return data.ok;
}

async function telegramAddStickerToSet(
  botToken: string,
  userId: number,
  name: string,
  stickerFileId: string,
  emoji: string
): Promise<boolean> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/addStickerToSet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      name,
      sticker: {
        sticker: stickerFileId,
        format: 'static',
        emoji_list: [emoji],
      },
    }),
  });

  const data = await response.json() as TelegramResponse<boolean>;
  return data.ok;
}

// ============================================================================
// Sticker Service Implementation
// ============================================================================

/**
 * Generate a new sticker from a text prompt
 */
export async function generateSticker(
  avatarId: string,
  prompt: string,
  emoji?: string,
  _conversationId?: string
): Promise<{
  success: boolean;
  stickerId?: string;
  stickerUrl?: string;
  emoji?: string;
  packName?: string;
  packUrl?: string;
  error?: string;
}> {
  try {
    const botToken = await getBotToken(avatarId);
    if (!botToken) {
      return { success: false, error: 'No Telegram bot token configured' };
    }

    const botInfo = await getBotInfo(botToken);
    if (!botInfo) {
      return { success: false, error: 'Failed to get bot info' };
    }

    const avatar = await avatars.getAvatar(avatarId);
    if (!avatar) {
      return { success: false, error: 'Avatar not found' };
    }

    // Generate image with sticker-friendly styling
    const stickerPrompt = `${prompt}. STICKER ART: bold clean lines, simplified shapes, flat vibrant colors, cartoon style. BACKGROUND: Must be PURE BLACK (#000000), solid and uniform, no gradients or patterns. OUTLINE: Include a THICK BRIGHT WHITE stroke (3-5px) around the entire subject edge.`;

    let imageResult;
    try {
      imageResult = await media.generateImage({
        prompt: stickerPrompt,
        avatarId,
        platform: 'telegram',
        resolution: '1K',
        aspectRatio: '1:1',
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to generate image' };
    }

    if (!imageResult || !imageResult.url) {
      return { success: false, error: 'Failed to generate image' };
    }

    // Process image for sticker (background removal, sizing)
    const processed = await processImageSourceForSticker(imageResult.url);

    // Determine emoji
    const finalEmoji = emoji || selectStickerEmoji(prompt);

    // Upload processed sticker to S3
    if (!MEDIA_BUCKET) {
      return { success: false, error: 'Media bucket not configured' };
    }

    const { s3Key, id: stickerId, url: stickerUrl } = await uploadStickerToS3(
      processed.buffer,
      MEDIA_BUCKET,
      avatarId,
      { emoji: finalEmoji, prompt }
    );

    // Get or create sticker pack name
    const baseName = avatar.name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_pack';
    const packName = generateStickerSetName(baseName, botInfo.username);

    // Upload to Telegram
    const uploadedFile = await telegramUploadStickerFile(botToken, botInfo.id, processed.buffer);
    if (!uploadedFile) {
      return { success: false, error: 'Failed to upload sticker to Telegram' };
    }

    // Try to get existing pack or create new one
    const existingPack = await telegramGetStickerSet(botToken, packName);
    const fileId = uploadedFile.file_id;

    if (existingPack) {
      // Add to existing pack
      const added = await telegramAddStickerToSet(
        botToken,
        botInfo.id,
        packName,
        uploadedFile.file_id,
        finalEmoji
      );
      if (!added) {
        return { success: false, error: 'Failed to add sticker to pack' };
      }
    } else {
      // Create new pack
      const packTitle = `${avatar.name}'s Stickers`;
      const created = await telegramCreateNewStickerSet(
        botToken,
        botInfo.id,
        packName,
        packTitle,
        uploadedFile.file_id,
        finalEmoji
      );
      if (!created) {
        return { success: false, error: 'Failed to create sticker pack' };
      }
    }

    // Update avatar's sticker pack info
    const currentPack = existingPack || await telegramGetStickerSet(botToken, packName);
    await avatars.updateAvatar(avatarId, {
      stickerPack: {
        name: packName,
        title: `${avatar.name}'s Stickers`,
        stickerCount: currentPack?.stickers?.length || 1,
        createdAt: avatar.stickerPack?.createdAt || Date.now(),
      },
    }, { email: 'system', userId: 'system', isAdmin: true, accessToken: '' });

    // Save to gallery as sticker type
    const galleryItem = {
      id: stickerId,
      type: 'sticker',
      url: stickerUrl,
      s3Key,
      prompt,
      model: 'sticker-processed',
      platform: 'telegram',
      stickerInfo: {
        emoji: finalEmoji,
        setName: packName,
        fileId,
        stickerUrl,
        convertedAt: Date.now(),
      },
    } satisfies Parameters<typeof gallery.addToGallery>[1];

    await gallery.addToGallery(avatarId, galleryItem);

    // Update S3 manifest
    let manifest = await getStickerSetManifest(MEDIA_BUCKET, avatarId, packName);
    if (!manifest) {
      manifest = {
        name: packName,
        title: `${avatar.name}'s Stickers`,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stickers: [],
      };
    }
    manifest.stickers.push({
      id: stickerId,
      emoji: finalEmoji,
      prompt,
      createdAt: new Date().toISOString(),
      setName: packName,
      fileId,
      url: stickerUrl,
    });
    await saveStickerSetManifest(MEDIA_BUCKET, avatarId, manifest);

    return {
      success: true,
      stickerId,
      stickerUrl,
      emoji: finalEmoji,
      packName,
      packUrl: `https://t.me/addstickers/${packName}`,
    };
  } catch (error) {
    console.error('Failed to generate sticker', { error });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Create a sticker from an existing gallery image
 */
export async function createStickerFromGallery(
  avatarId: string,
  galleryItemId: string,
  emoji?: string,
  _conversationId?: string
): Promise<{
  success: boolean;
  stickerId?: string;
  stickerUrl?: string;
  emoji?: string;
  packName?: string;
  packUrl?: string;
  error?: string;
}> {
  try {
    const botToken = await getBotToken(avatarId);
    if (!botToken) {
      return { success: false, error: 'No Telegram bot token configured' };
    }

    const botInfo = await getBotInfo(botToken);
    if (!botInfo) {
      return { success: false, error: 'Failed to get bot info' };
    }

    const avatar = await avatars.getAvatar(avatarId);
    if (!avatar) {
      return { success: false, error: 'Avatar not found' };
    }

    // Get the gallery item
    const item = await gallery.getGalleryItem(avatarId, galleryItemId);
    if (!item) {
      return { success: false, error: 'Gallery item not found' };
    }

    if (item.type !== 'image') {
      return { success: false, error: 'Can only convert images to stickers' };
    }

    if (item.convertedToSticker && item.stickerInfo?.fileId) {
      return {
        success: true,
        stickerId: galleryItemId,
        stickerUrl: item.stickerInfo.stickerUrl,
        emoji: item.stickerInfo.emoji,
        packName: item.stickerInfo.setName,
        packUrl: `https://t.me/addstickers/${item.stickerInfo.setName}`,
      };
    }

    // Process image for sticker
    const processed = await processImageSourceForSticker(item.url);

    // Determine emoji
    const finalEmoji = emoji || selectStickerEmoji(item.prompt);

    // Upload processed sticker to S3
    if (!MEDIA_BUCKET) {
      return { success: false, error: 'Media bucket not configured' };
    }

    const { id: stickerId, url: stickerUrl } = await uploadStickerToS3(
      processed.buffer,
      MEDIA_BUCKET,
      avatarId,
      { emoji: finalEmoji, prompt: item.prompt }
    );

    // Get or create sticker pack name
    const baseName = avatar.name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_pack';
    const packName = generateStickerSetName(baseName, botInfo.username);

    // Upload to Telegram
    const uploadedFile = await telegramUploadStickerFile(botToken, botInfo.id, processed.buffer);
    if (!uploadedFile) {
      return { success: false, error: 'Failed to upload sticker to Telegram' };
    }

    // Try to get existing pack or create new one
    const existingPack = await telegramGetStickerSet(botToken, packName);
    const fileId = uploadedFile.file_id;

    if (existingPack) {
      const added = await telegramAddStickerToSet(
        botToken,
        botInfo.id,
        packName,
        uploadedFile.file_id,
        finalEmoji
      );
      if (!added) {
        return { success: false, error: 'Failed to add sticker to pack' };
      }
    } else {
      const packTitle = `${avatar.name}'s Stickers`;
      const created = await telegramCreateNewStickerSet(
        botToken,
        botInfo.id,
        packName,
        packTitle,
        uploadedFile.file_id,
        finalEmoji
      );
      if (!created) {
        return { success: false, error: 'Failed to create sticker pack' };
      }
    }

    // Update avatar's sticker pack info
    const currentPack = existingPack || await telegramGetStickerSet(botToken, packName);
    await avatars.updateAvatar(avatarId, {
      stickerPack: {
        name: packName,
        title: `${avatar.name}'s Stickers`,
        stickerCount: currentPack?.stickers?.length || 1,
        createdAt: avatar.stickerPack?.createdAt || Date.now(),
      },
    }, { email: 'system', userId: 'system', isAdmin: true, accessToken: '' });

    // Mark original gallery item as converted
    await gallery.markConvertedToSticker(avatarId, galleryItemId, item.sk, {
      emoji: finalEmoji,
      setName: packName,
      fileId,
      stickerUrl,
    });

    // Update S3 manifest
    let manifest = await getStickerSetManifest(MEDIA_BUCKET, avatarId, packName);
    if (!manifest) {
      manifest = {
        name: packName,
        title: `${avatar.name}'s Stickers`,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stickers: [],
      };
    }
    manifest.stickers.push({
      id: stickerId,
      emoji: finalEmoji,
      prompt: item.prompt,
      createdAt: new Date().toISOString(),
      setName: packName,
      fileId,
      url: stickerUrl,
    });
    await saveStickerSetManifest(MEDIA_BUCKET, avatarId, manifest);

    return {
      success: true,
      stickerId,
      stickerUrl,
      emoji: finalEmoji,
      packName,
      packUrl: `https://t.me/addstickers/${packName}`,
    };
  } catch (error) {
    console.error('Failed to create sticker from gallery', { error });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get the avatar's sticker pack info
 */
export async function getStickerPack(avatarId: string): Promise<StickerPackInfo | null> {
  const avatar = await avatars.getAvatar(avatarId);
  if (!avatar?.stickerPack) {
    return null;
  }

  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return null;
  }

  const telegramPack = await telegramGetStickerSet(botToken, avatar.stickerPack.name);

  // Get manifest from S3 for prompt info
  let manifest: StickerSetManifest | null = null;
  if (MEDIA_BUCKET) {
    manifest = await getStickerSetManifest(MEDIA_BUCKET, avatarId, avatar.stickerPack.name);
  }

  const stickers: StickerInfo[] = telegramPack?.stickers?.map((s, i) => {
    const manifestSticker = manifest?.stickers?.[i];
    return {
      id: manifestSticker?.id || `sticker-${i}`,
      emoji: s.emoji || manifestSticker?.emoji || '😀',
      fileId: s.file_id,
      url: manifestSticker?.url,
      prompt: manifestSticker?.prompt,
      createdAt: manifestSticker?.createdAt || new Date().toISOString(),
    };
  }) || [];

  return {
    name: avatar.stickerPack.name,
    title: avatar.stickerPack.title,
    stickerCount: telegramPack?.stickers?.length || avatar.stickerPack.stickerCount,
    stickers,
    telegramUrl: `https://t.me/addstickers/${avatar.stickerPack.name}`,
  };
}

/**
 * Get gallery items that can be converted to stickers
 */
export async function getGalleryForStickers(
  avatarId: string,
  options?: { limit?: number; unconvertedOnly?: boolean }
): Promise<GalleryItemForSticker[]> {
  const items = await gallery.getGallery(avatarId, {
    type: 'image',
    limit: options?.limit || 20,
    notConvertedToSticker: options?.unconvertedOnly ?? true,
  });

  return items.map(item => ({
    id: item.id,
    url: item.url,
    prompt: item.prompt,
    type: item.type,
    convertedToSticker: item.convertedToSticker,
  }));
}

/**
 * Find a sticker by description/emoji
 */
export async function findSticker(
  avatarId: string,
  description: string
): Promise<StickerInfo | null> {
  const pack = await getStickerPack(avatarId);
  if (!pack || pack.stickers.length === 0) {
    return null;
  }

  const lower = description.toLowerCase();

  // Handle special keywords
  if (lower.includes('latest') || lower.includes('last') || lower.includes('recent') || lower.includes('newest')) {
    return pack.stickers[pack.stickers.length - 1];
  }

  if (lower.includes('first') || lower.includes('oldest')) {
    return pack.stickers[0];
  }

  if (lower.includes('random')) {
    return pack.stickers[Math.floor(Math.random() * pack.stickers.length)];
  }

  // Try to match by emoji
  const matchByEmoji = pack.stickers.find(s => s.emoji && lower.includes(s.emoji));
  if (matchByEmoji) {
    return matchByEmoji;
  }

  // Try to match by prompt keywords
  const matchByPrompt = pack.stickers.find(s => {
    if (!s.prompt) return false;
    const promptLower = s.prompt.toLowerCase();
    return lower.split(/\s+/).some(word => promptLower.includes(word));
  });
  if (matchByPrompt) {
    return matchByPrompt;
  }

  // Default to latest
  return pack.stickers[pack.stickers.length - 1];
}

/**
 * Create the StickerServices implementation for MCP
 */
export function createStickerServices(): StickerServices {
  return {
    generateSticker,
    createStickerFromGallery,
    getStickerPack,
    getGalleryForStickers,
    findSticker,
  };
}
