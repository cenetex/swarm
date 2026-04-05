/**
 * Shared types for sticker processing
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

export interface StickerSetManifest {
  name: string;          // e.g., "agent_stickers_by_bot"
  title: string;         // e.g., "Avatar's Stickers"
  createdAt: string;
  lastUpdated: string;
  stickers: StickerMetadata[];
}

export interface ProcessedSticker {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface StickerVariant {
  format: string;      // 'png', 'webp', 'svg'
  scale: number;       // 1, 2, 3, etc.
  buffer: Buffer;
  width: number;
  height: number;
  size: number;        // file size in bytes
  mimeType: string;
}

export interface WebStickerResult {
  variants: StickerVariant[];
}
