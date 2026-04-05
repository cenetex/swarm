/**
 * Sticker Engine Types
 *
 * Core types for sticker processing across all formats
 */

/**
 * Metadata for a processed sticker
 */
export interface StickerMetadata {
  id: string;
  emoji: string;
  prompt?: string;
  createdAt: string;
  setName?: string;
  fileId?: string; // Telegram file_id after upload
  url?: string;    // S3/CDN URL
}

/**
 * Manifest for a sticker set (collection of stickers)
 */
export interface StickerSetManifest {
  name: string;          // e.g., "agent_stickers_by_bot"
  title: string;         // e.g., "Avatar's Stickers"
  createdAt: string;
  lastUpdated: string;
  stickers: StickerMetadata[];
}

/**
 * Result of processing an image buffer into a sticker
 */
export interface ProcessedSticker {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Options for processing images for Telegram format
 */
export interface TelegramProcessOptions {
  removeBackground?: boolean;
  quality?: number;
}

/**
 * Options for processing images for web format
 */
export interface WebProcessOptions {
  removeBackground?: boolean;
  width?: number;
  height?: number;
  format?: 'png' | 'webp' | 'svg';
  quality?: number;
}

/**
 * S3 upload result
 */
export interface S3UploadResult {
  s3Key: string;
  id: string;
  url: string;
}
