/**
 * Sticker Processor Service
 *
 * Re-exports from @swarm/sticker-engine with convenience functions for
 * processing image URLs and data URLs.
 */

import { processForTelegram } from '@swarm/sticker-engine';

export * from '@swarm/sticker-engine';

function parseDataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

/**
 * Process an image URL into a sticker-ready buffer using Telegram format
 */
export async function fetchAndProcessForSticker(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get('content-type') || 'image/png';

  return processForTelegram(buffer, mimeType);
}

/**
 * Process either a URL or a base64 data URL into a sticker-ready buffer.
 * Useful when an AI image model returns a data URL.
 */
export async function processImageSourceForSticker(imageSource: string) {
  if (imageSource.startsWith('data:')) {
    const parsed = parseDataUrlToBuffer(imageSource);
    if (!parsed) throw new Error('Invalid image data URL');
    return processForTelegram(parsed.buffer, parsed.mimeType);
  }

  return fetchAndProcessForSticker(imageSource);
}
