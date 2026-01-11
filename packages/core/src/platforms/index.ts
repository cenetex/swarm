/**
 * Platform adapters for the Swarm framework
 */
export { PlatformAdapter, PlatformRegistry } from './base.js';
export {
  TelegramAdapter,
  // Shared Telegram envelope builder utilities
  buildTelegramEnvelope,
  envelopeToBufferedMessage,
  type TelegramEnvelopeConfig,
  type BufferedMessageCompat,
} from './telegram.js';
export { TwitterAdapter, type TwitterCredentials } from './twitter.js';
export { WebAdapter, type WebChatMessage, type WebChatResponse } from './web.js';
export {
  DiscordAdapter,
  buildDiscordEnvelope,
  type DiscordCredentials,
  type DiscordMessage,
  type DiscordInteraction,
  type DiscordWebhookPayload,
} from './discord.js';
