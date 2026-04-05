/**
 * Format-specific sticker processors
 *
 * Exports Telegram and web format processors
 */

export {
  processForTelegram,
  generateStickerSetName,
} from './telegram.js';

export {
  processForWeb,
} from './web.js';
