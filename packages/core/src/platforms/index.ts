/**
 * Platform adapters for the Swarm framework
 */
export { PlatformAdapter, PlatformRegistry } from './base.js';
export { TelegramAdapter } from './telegram.js';
export { TwitterAdapter, type TwitterCredentials } from './twitter.js';
export { WebAdapter, type WebChatMessage, type WebChatResponse } from './web.js';
