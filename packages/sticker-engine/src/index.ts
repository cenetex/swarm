/**
 * Sticker Engine
 *
 * Unified sticker processing engine for Telegram and web formats
 * Handles image processing, background removal, resizing, and S3 storage
 */

// Core types
export type {
  StickerMetadata,
  StickerSetManifest,
  ProcessedSticker,
  TelegramProcessOptions,
  WebProcessOptions,
  S3UploadResult,
} from './types.js';

// Core processing
export {
  rgbChroma,
  isGrayish,
  luma,
  removeCheckerboardBackground,
} from './core/index.js';

// Format processors
export {
  processForTelegram,
  generateStickerSetName,
} from './formats/telegram.js';

export {
  processForWeb,
} from './formats/web.js';

// Emoji selection
export {
  selectStickerEmoji,
} from './emoji.js';

// S3 storage
export {
  uploadStickerToS3,
  getStickerSetManifest,
  saveStickerSetManifest,
} from './s3-storage.js';
