/**
 * Platform Domain
 *
 * External platform integrations: Telegram, Twitter, Discord,
 * MCP adapters, and generic integration configuration.
 */
export * from '../telegram.js';
export * from '../telegram-admin.js';
export * from '../telegram-onboarding.js';
export * from '../integrations.js';
export * from '../onboarding/index.js';
export * from '../onboarding-rollout.js';

// Namespaced re-exports to avoid conflicts
export * as twitterOAuth from '../twitter-oauth.js';
export * as discord from '../discord.js';
export * as twitterFeed from '../twitter-feed.js';

// MCP adapters
export { createMCPServices } from '../mcp-adapter.js';
export { getEnabledToolsets } from '../mcp-config.js';
