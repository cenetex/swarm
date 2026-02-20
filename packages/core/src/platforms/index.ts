/**
 * Platform adapters for the Swarm framework
 */
export { PlatformAdapter, PlatformRegistry } from './base.js';
export {
  TelegramAdapter,
  // Shared Telegram envelope builder utilities
  buildTelegramEnvelope,
  envelopeToBufferedMessage,
  extractForwardMetadata,
  // BotFather constants
  BOTFATHER_USER_ID,
  BOTFATHER_USERNAME,
  type TelegramEnvelopeConfig,
  type BufferedMessageCompat,
} from './telegram.js';
// ForwardMetadata is exported from types/index.ts to avoid duplicate exports
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

export {
  ensureTwitterImageWithinLimit,
  TWITTER_MAX_IMAGE_BYTES,
  TWITTER_TARGET_IMAGE_BYTES,
} from './twitter-media.js';

// Discord rate limiter
export {
  DiscordRateLimiter,
  extractRouteKey,
  type RateLimitBucket,
  type DiscordRateLimiterOptions,
  type RateLimitedResult,
} from './discord-rate-limiter.js';

// Discord gateway utilities (intent validation, close codes, reconnect)
export {
  DiscordIntent,
  REQUIRED_BOT_INTENTS,
  RECOMMENDED_BOT_INTENTS,
  validateIntents,
  logIntentValidation,
  interpretCloseCode,
  logGatewayClose,
  computeReconnectDelay,
  type IntentValidationResult,
  type CloseCodeInfo,
} from './discord-gateway-utils.js';
