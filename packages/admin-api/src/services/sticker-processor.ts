/**
 * Sticker Processor Service
 *
 * Handles image processing for Telegram stickers:
 * - Background removal using edge flood-fill algorithm
 * - Resizing to Telegram sticker requirements (512px)
 * - PNG conversion with transparency
 *
 * Ported from solanafirehorse with adaptations for aws-swarm architecture.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

const s3Client = new S3Client({});

/**
 * Telegram sticker requirements:
 * - Static: PNG or WEBP with transparency, one side exactly 512px (other ≤512px)
 * - File size: < 512 KB
 * - Sticker set name must end with "_by_<bot_username>"
 */

// ============================================================================
// Color Analysis Utilities
// ============================================================================

function rgbChroma(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min;
}

function isGrayish(r: number, g: number, b: number, variance: number = 18): boolean {
  return Math.abs(r - g) <= variance && Math.abs(g - b) <= variance && Math.abs(r - b) <= variance;
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ============================================================================
// Background Removal
// ============================================================================

/**
 * Remove background using edge flood fill.
 *
 * Handles both:
 * - Gray checkerboard patterns (fake transparency from AI models)
 * - Solid dark backgrounds (black/near-black)
 *
 * Key idea:
 * - Background pixels are either: low-chroma gray-ish OR very dark (low luma)
 * - The sticker interior is higher-chroma (colored)
 * - The white outline is low-chroma but bright; we preserve it via luma threshold
 * - We also preserve pixels adjacent to colored content (the outline border)
 */
async function removeCheckerboardBackground(imageBuffer: Buffer): Promise<Buffer> {
  const image = sharp(imageBuffer);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);

  console.log('Removing background via edge flood fill (gray + dark)', { width, height, channels });

  const pixelCount = width * height;
  const coloredThreshold = 22; // foreground seed (slightly lower to catch more colors)
  const grayChromaThreshold = 20; // background candidate
  const grayVariance = 25; // increased tolerance for gray detection
  const darkLumaThreshold = 45; // pixels darker than this are background candidates

  // Precompute colored mask (high chroma pixels).
  const isColored = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * channels;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    if (rgbChroma(r, g, b) >= coloredThreshold) {
      isColored[i] = 1;
    }
  }

  // Helper: is this pixel adjacent to colored content?
  const isAdjacentToColored = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (isColored[ny * width + nx] === 1) return true;
      }
    }
    return false;
  };

  // Helper: is this pixel a barrier that should STOP flood fill (white outline)?
  const isBarrierPixel = (r: number, g: number, b: number): boolean => {
    const pixelLuma = luma(r, g, b);
    // Any bright-ish pixel is a barrier (white outline)
    // Lower threshold to catch slightly gray outlines too
    return pixelLuma >= 180;
  };

  // Helper: is this pixel a removable background pixel?
  // This is only used to decide IF we can traverse, not whether to remove
  const isBackgroundPixel = (r: number, g: number, b: number): boolean => {
    const pixelLuma = luma(r, g, b);
    const pixelChroma = rgbChroma(r, g, b);

    // Barrier pixels are NOT background - they stop the flood
    if (isBarrierPixel(r, g, b)) return false;

    // Colored pixels (high chroma) are NOT background
    if (pixelChroma >= coloredThreshold) return false;

    // Dark pixels (black/near-black background) are removable
    if (pixelLuma <= darkLumaThreshold && pixelChroma <= grayChromaThreshold) return true;

    // Gray-ish pixels (checkerboard) are removable
    if (isGrayish(r, g, b, grayVariance) && pixelChroma <= grayChromaThreshold) return true;

    return false;
  };

  // Detect dominant edge color (for non-black/gray colored backgrounds)
  const edgeSamples: Array<[number, number, number]> = [];
  const sampleStep = 5; // Sample every Nth edge pixel
  for (let x = 0; x < width; x += sampleStep) {
    const topIdx = x * channels;
    const bottomIdx = ((height - 1) * width + x) * channels;
    edgeSamples.push([pixels[topIdx], pixels[topIdx + 1], pixels[topIdx + 2]]);
    edgeSamples.push([pixels[bottomIdx], pixels[bottomIdx + 1], pixels[bottomIdx + 2]]);
  }
  for (let y = 0; y < height; y += sampleStep) {
    const leftIdx = (y * width) * channels;
    const rightIdx = (y * width + width - 1) * channels;
    edgeSamples.push([pixels[leftIdx], pixels[leftIdx + 1], pixels[leftIdx + 2]]);
    edgeSamples.push([pixels[rightIdx], pixels[rightIdx + 1], pixels[rightIdx + 2]]);
  }

  // Calculate average edge color
  let sumR = 0, sumG = 0, sumB = 0;
  for (const [r, g, b] of edgeSamples) {
    sumR += r; sumG += g; sumB += b;
  }
  const avgR = sumR / edgeSamples.length;
  const avgG = sumG / edgeSamples.length;
  const avgB = sumB / edgeSamples.length;
  const edgeLuma = luma(avgR, avgG, avgB);

  // Check if edge is uniformly colored (low variance = likely background)
  let variance = 0;
  for (const [r, g, b] of edgeSamples) {
    variance += Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2);
  }
  variance /= edgeSamples.length;
  const isUniformEdge = variance < 800; // Low variance = uniform background color

  console.log('Edge color analysis', {
    avgR: Math.round(avgR), avgG: Math.round(avgG), avgB: Math.round(avgB),
    edgeLuma: Math.round(edgeLuma), variance: Math.round(variance), isUniformEdge
  });

  // Check if pixel matches the detected edge background color
  const colorTolerance = 60; // How close to edge color to be considered background
  const matchesEdgeBackground = (r: number, g: number, b: number): boolean => {
    if (!isUniformEdge) return false;
    // Don't allow traversal through barrier pixels
    if (isBarrierPixel(r, g, b)) return false;
    const dist = Math.abs(r - avgR) + Math.abs(g - avgG) + Math.abs(b - avgB);
    return dist < colorTolerance;
  };

  // Flood fill background from edges.
  const outputPixels = Buffer.from(pixels);
  const visited = new Uint8Array(pixelCount);
  const queue: Array<[number, number]> = [];

  for (let x = 0; x < width; x++) {
    queue.push([x, 0], [x, height - 1]);
  }
  for (let y = 1; y < height - 1; y++) {
    queue.push([0, y], [width - 1, y]);
  }

  let removedCount = 0;
  let barrierHits = 0;

  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    const key = y * width + x;
    if (visited[key] === 1) continue;
    visited[key] = 1;

    const idx = key * channels;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];

    // FIRST CHECK: Is this a barrier pixel (white outline)?
    // If so, STOP flood here completely - do not traverse OR remove
    if (isBarrierPixel(r, g, b)) {
      barrierHits++;
      continue;
    }

    // Check if this is a background pixel (dark/gray OR matches uniform edge color)
    const isRemovableBackground = isBackgroundPixel(r, g, b) || matchesEdgeBackground(r, g, b);
    if (!isRemovableBackground) continue;

    // Additional safety: refuse to flood into pixels adjacent to colored content
    if (isAdjacentToColored(x, y)) continue;

    if (outputPixels[idx + 3] !== 0) {
      outputPixels[idx + 3] = 0;
      removedCount++;
    }

    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nkey = ny * width + nx;
      if (visited[nkey] === 0) queue.push([nx, ny]);
    }
  }

  console.log('Background removal complete', {
    totalPixels: pixelCount,
    removedPixels: removedCount,
    barrierHits,
    coloredThreshold,
    grayChromaThreshold,
    grayVariance,
    darkLumaThreshold,
  });

  // Convert back to PNG
  return sharp(outputPixels, {
    raw: {
      width,
      height,
      channels: channels as 4,
    },
  })
    .png()
    .toBuffer();
}

// ============================================================================
// Sticker Processing
// ============================================================================

export interface StickerMetadata {
  id: string;
  emoji: string;
  prompt?: string;
  createdAt: string;
  setName?: string;
  fileId?: string; // Telegram file_id after upload
  url?: string;    // S3/CDN URL
}

export interface StickerSetManifest {
  name: string;          // e.g., "agent_stickers_by_bot"
  title: string;         // e.g., "Agent's Stickers"
  createdAt: string;
  lastUpdated: string;
  stickers: StickerMetadata[];
}

export interface ProcessedSticker {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Process an image buffer for Telegram stickers:
 * - Remove checkerboard/grid background pattern (fake transparency)
 * - Preserve bright white outline (sticker edge)
 * - Resize so one dimension is exactly 512px (maintaining aspect ratio)
 * - Convert to PNG with true transparency
 * - Ensure file size is under 512KB
 */
export async function processImageForSticker(
  imageBuffer: Buffer,
  _mimeType: string = 'image/png',
  options: { removeBackground?: boolean } = { removeBackground: true }
): Promise<ProcessedSticker> {
  try {
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

    console.log('Processing image for sticker', {
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

    console.log('Sticker processed', {
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
  } catch (error) {
    console.error('Error processing image with sharp', { error });

    // Fallback: try to detect image dimensions from PNG header
    let width = 512;
    let height = 512;

    if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) {
      // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian)
      width = imageBuffer.readUInt32BE(16);
      height = imageBuffer.readUInt32BE(20);
    }

    // Return as-is with detected dimensions
    return {
      buffer: imageBuffer,
      width: Math.min(width, 512),
      height: Math.min(height, 512),
    };
  }
}

function parseDataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

/**
 * Process an image URL into a sticker-ready buffer
 */
export async function fetchAndProcessForSticker(
  imageUrl: string
): Promise<ProcessedSticker> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get('content-type') || 'image/png';

  return processImageForSticker(buffer, mimeType);
}

/**
 * Process either a URL or a base64 data URL into a sticker-ready buffer.
 * Useful when an AI image model returns a data URL.
 */
export async function processImageSourceForSticker(
  imageSource: string
): Promise<ProcessedSticker> {
  if (imageSource.startsWith('data:')) {
    const parsed = parseDataUrlToBuffer(imageSource);
    if (!parsed) throw new Error('Invalid image data URL');
    return processImageForSticker(parsed.buffer, parsed.mimeType);
  }

  return fetchAndProcessForSticker(imageSource);
}

// ============================================================================
// S3 Storage
// ============================================================================

/**
 * Upload a processed sticker to S3 for storage
 */
export async function uploadStickerToS3(
  buffer: Buffer,
  bucketName: string,
  agentId: string,
  metadata: {
    emoji: string;
    prompt?: string;
    setName?: string;
  }
): Promise<{ s3Key: string; id: string; url: string }> {
  const datePrefix = new Date().toISOString().split('T')[0];
  const id = randomUUID();
  const s3Key = `stickers/${agentId}/${datePrefix}/${id}.png`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: buffer,
    ContentType: 'image/png',
    Metadata: {
      // S3 metadata headers only allow ASCII - encode emoji
      emoji: encodeURIComponent(metadata.emoji),
      prompt: metadata.prompt ? encodeURIComponent(metadata.prompt.slice(0, 500)) : '',
      setName: metadata.setName || '',
    },
  }));

  console.log('Uploaded sticker to S3', { s3Key, id });

  const cdnUrl = process.env.CDN_URL || `https://${bucketName}.s3.amazonaws.com`;
  const url = `${cdnUrl}/${s3Key}`;

  return { s3Key, id, url };
}

/**
 * Get or create the sticker set manifest from S3
 */
export async function getStickerSetManifest(
  bucketName: string,
  agentId: string,
  setName: string
): Promise<StickerSetManifest | null> {
  const manifestKey = `stickers/${agentId}/manifests/${setName}.json`;

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: manifestKey,
    }));

    const bodyStr = await response.Body?.transformToString();
    if (bodyStr) {
      return JSON.parse(bodyStr) as StickerSetManifest;
    }
  } catch (error: any) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }

  return null;
}

/**
 * Save/update the sticker set manifest to S3
 */
export async function saveStickerSetManifest(
  bucketName: string,
  agentId: string,
  manifest: StickerSetManifest
): Promise<void> {
  const manifestKey = `stickers/${agentId}/manifests/${manifest.name}.json`;

  manifest.lastUpdated = new Date().toISOString();

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));

  console.log('Saved sticker set manifest', { setName: manifest.name, stickerCount: manifest.stickers.length });
}

// ============================================================================
// Sticker Set Naming
// ============================================================================

/**
 * Generate the sticker set name based on bot username
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

/**
 * Select an appropriate emoji for a sticker based on its content/prompt
 */
export function selectStickerEmoji(prompt?: string): string {
  if (!prompt) return '😀';

  const lower = prompt.toLowerCase();

  // Fire/crypto themes
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
  if (lower.includes('party') || lower.includes('celebrat')) return '🎉';
  if (lower.includes('cool') || lower.includes('chill')) return '😎';
  if (lower.includes('think') || lower.includes('wonder')) return '🤔';
  if (lower.includes('wave') || lower.includes('hello') || lower.includes('hi')) return '👋';
  if (lower.includes('thumb') || lower.includes('good') || lower.includes('nice')) return '👍';

  // Default
  return '😀';
}
