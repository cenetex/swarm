/**
 * Telegram Sticker Format Handler
 *
 * Process images for Telegram stickers with requirements:
 * - Static: PNG with transparency, one side exactly 512px (other ≤512px)
 * - File size: < 512 KB
 * - Sticker set name must end with "_by_<bot_username>"
 * - Background removal required (AI models produce black/checkerboard backgrounds)
 */

import { removeCheckerboardBackground } from '../core/background-removal.js';
import type { ProcessedSticker, TelegramProcessOptions } from '../types.js';

let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    try {
      sharpModule = await import('sharp');
    } catch {
      throw new Error('sharp module not available - image processing is not supported in this environment');
    }
  }
  return sharpModule.default;
}

/**
 * Process an image buffer for Telegram stickers:
 * - Remove checkerboard/grid background pattern (fake transparency)
 * - Preserve bright white outline (sticker edge)
 * - Resize so one dimension is exactly 512px (maintaining aspect ratio)
 * - Convert to PNG with true transparency
 * - Ensure file size is under 512KB
 *
 * @param imageBuffer - Image buffer to process
 * @param mimeType - MIME type of the image (default: 'image/png')
 * @param options - Processing options (removeBackground: boolean - default: true)
 * @returns ProcessedSticker with buffer, width, and height
 * @throws Error if sharp is unavailable or processing fails
 */
export async function processForTelegram(
  imageBuffer: Buffer,
  mimeType: string = 'image/png',
  options: TelegramProcessOptions = { removeBackground: true }
): Promise<ProcessedSticker> {
  const sharp = await getSharp();

  let workingBuffer = imageBuffer;

  // Step 1: Remove checkerboard background if requested
  if (options.removeBackground) {
    console.log('Attempting to remove checkerboard background...');
    workingBuffer = await removeCheckerboardBackground(imageBuffer);
  }

  // Get image metadata
  const metadata = await sharp(workingBuffer).metadata();
  const originalWidth = metadata.width || 512;
  const originalHeight = metadata.height || 512;

  console.log('Processing image for Telegram sticker', {
    originalSize: imageBuffer.length,
    afterBgRemoval: workingBuffer.length,
    originalWidth,
    originalHeight,
    format: metadata.format,
  });

  // Calculate new dimensions - one side must be exactly 512px
  let newWidth: number;
  let newHeight: number;

  if (originalWidth >= originalHeight) {
    // Landscape or square - width becomes 512
    newWidth = 512;
    newHeight = Math.round((originalHeight / originalWidth) * 512);
  } else {
    // Portrait - height becomes 512
    newHeight = 512;
    newWidth = Math.round((originalWidth / originalHeight) * 512);
  }

  // Ensure dimensions don't exceed 512
  newWidth = Math.min(newWidth, 512);
  newHeight = Math.min(newHeight, 512);

  // Resize and convert to PNG with transparency
  let processedBuffer = await sharp(workingBuffer)
    .resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
    })
    .toBuffer();

  // If file is too large (>512KB), reduce quality progressively
  let quality = 100;
  while (processedBuffer.length > 512 * 1024 && quality > 10) {
    quality -= 10;
    processedBuffer = await sharp(workingBuffer)
      .resize(newWidth, newHeight, {
        fit: 'inside',
        withoutEnlargement: false,
      })
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        quality,
      })
      .toBuffer();
  }

  console.log('Sticker processed for Telegram', {
    newSize: processedBuffer.length,
    newWidth,
    newHeight,
    quality,
  });

  return {
    buffer: processedBuffer,
    width: newWidth,
    height: newHeight,
  };
}

/**
 * Generate the sticker set name based on bot username
 * Telegram requires: lowercase, underscores, must end with _by_<bot_username>
 *
 * @param baseName - Base name for the sticker set
 * @param botUsername - Telegram bot username (with or without @)
 * @returns Properly formatted sticker set name
 */
export function generateStickerSetName(
  baseName: string,
  botUsername: string
): string {
  // Telegram requires: lowercase, underscores, must end with _by_<bot_username>
  const sanitized = baseName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // Bot username without @ if present
  const cleanBotUsername = botUsername.replace('@', '').toLowerCase();

  return `${sanitized}_by_${cleanBotUsername}`;
}
