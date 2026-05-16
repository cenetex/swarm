/**
 * Telegram Sticker Format Processor
 *
 * Produces static sticker PNGs that satisfy Telegram Bot API constraints:
 * one side exactly 512px, the other side <= 512px, transparency preserved,
 * and file size below 512KB.
 */
import type { ProcessedSticker } from '../types.js';
import { removeCheckerboardBackground } from '../core/background-removal.js';

const TELEGRAM_STICKER_SIZE = 512;
const TELEGRAM_MAX_BYTES = 512 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      throw new Error('sharp module not available - Telegram sticker processing is not supported in this environment');
    }
  }
  return sharpModule;
}

export interface TelegramStickerOptions {
  removeBackground?: boolean;
}

export interface TelegramProcessedSticker extends ProcessedSticker {
  size: number;
  contentType: 'image/png';
}

export function generateStickerSetName(baseName: string, botUsername: string): string {
  const suffix = `_by_${botUsername.replace(/^@/, '').toLowerCase()}`;
  const maxBaseLength = 64 - suffix.length;
  const sanitized = baseName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const base = (sanitized || 'stickers').slice(0, Math.max(1, maxBaseLength)).replace(/_+$/g, '');
  return `${base || 'stickers'}${suffix}`;
}

export function selectStickerEmoji(prompt?: string): string {
  if (!prompt) return '🐴';

  const lower = prompt.toLowerCase();
  if (lower.includes('fire') || lower.includes('burn')) return '🔥';
  if (lower.includes('diamond') || lower.includes('hodl')) return '💎';
  if (lower.includes('moon') || lower.includes('pump')) return '🚀';
  if (lower.includes('dump') || lower.includes('crash')) return '📉';
  if (lower.includes('scared') || lower.includes('fear')) return '😰';
  if (lower.includes('happy') || lower.includes('joy')) return '😄';
  if (lower.includes('angry') || lower.includes('rage')) return '😡';
  if (lower.includes('sad') || lower.includes('cry')) return '😢';
  if (lower.includes('laugh') || lower.includes('lol')) return '😂';
  if (lower.includes('love') || lower.includes('heart')) return '❤️';
  if (lower.includes('money') || lower.includes('rich')) return '💰';
  if (lower.includes('dip') || lower.includes('buy')) return '🛒';
  if (lower.includes('win') || lower.includes('profit')) return '🏆';
  if (lower.includes('rekt') || lower.includes('loss')) return '💀';

  return '🐴';
}

export async function processForTelegramSticker(
  imageBuffer: Buffer,
  options: TelegramStickerOptions = { removeBackground: true },
): Promise<TelegramProcessedSticker> {
  const sharp = await getSharp();
  const workingBuffer = options.removeBackground === false
    ? imageBuffer
    : await removeCheckerboardBackground(imageBuffer);

  const metadata = await sharp(workingBuffer).metadata();
  const originalWidth = metadata.width || TELEGRAM_STICKER_SIZE;
  const originalHeight = metadata.height || TELEGRAM_STICKER_SIZE;

  const resize =
    originalWidth >= originalHeight
      ? { width: TELEGRAM_STICKER_SIZE }
      : { height: TELEGRAM_STICKER_SIZE };

  let processedBuffer = await sharp(workingBuffer)
    .ensureAlpha()
    .resize(resize)
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
    })
    .toBuffer();

  if (processedBuffer.length > TELEGRAM_MAX_BYTES) {
    processedBuffer = await sharp(processedBuffer)
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
      })
      .toBuffer();
  }

  const output = await sharp(processedBuffer).metadata();
  const width = output.width || TELEGRAM_STICKER_SIZE;
  const height = output.height || TELEGRAM_STICKER_SIZE;

  if (width > TELEGRAM_STICKER_SIZE || height > TELEGRAM_STICKER_SIZE) {
    throw new Error(`Telegram sticker dimensions too large: ${width}x${height}`);
  }
  if (width !== TELEGRAM_STICKER_SIZE && height !== TELEGRAM_STICKER_SIZE) {
    throw new Error(`Telegram sticker must have one side exactly 512px: ${width}x${height}`);
  }
  if (processedBuffer.length > TELEGRAM_MAX_BYTES) {
    throw new Error(`Telegram sticker exceeds 512KB: ${processedBuffer.length} bytes`);
  }

  return {
    buffer: processedBuffer,
    width,
    height,
    size: processedBuffer.length,
    contentType: 'image/png',
  };
}

export async function fetchAndProcessForTelegramSticker(
  imageUrl: string,
  options?: TelegramStickerOptions,
): Promise<TelegramProcessedSticker> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sticker source image: ${response.status}`);
  }

  return processForTelegramSticker(Buffer.from(await response.arrayBuffer()), options);
}

export async function processImageSourceForTelegramSticker(
  imageSource: string,
  options?: TelegramStickerOptions,
): Promise<TelegramProcessedSticker> {
  const match = imageSource.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return processForTelegramSticker(Buffer.from(match[2], 'base64'), options);
  }

  return fetchAndProcessForTelegramSticker(imageSource, options);
}
