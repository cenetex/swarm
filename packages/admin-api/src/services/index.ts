export * from './secrets.js';
export * from './wallets.js';
export * from './avatars.js';
export * from './avatar-ownership.js';
export * from './nft-gate.js';
export * from './lineage-nft.js';
export * from './config-sync.js';
export * from './gallery.js';
export * from './media-jobs.js';
export * from './credits.js';
export * from './entitlements.js';
export * from './onboarding/index.js';
export * from './activation-readiness.js';
export * from './onboarding-rollout.js';
// Energy service types that don't conflict with credits.js wrappers
export type { EnergyStatus, EnergyConfig, ConsumeEnergyResult, EnergyEvent, EnergyCostType, EnergyServiceDeps } from './energy.js';
export { getOwnerWallet, getOwnerWallets, getTokenBalance, getOwnerTokenBalance, clearBalanceCache } from './wallet-balance.js';
export * from './media.js';
export * from './telegram-stickers.js';
export * from './telegram.js';
export * from './telegram-onboarding.js';
export * from './sticker-processor.js';
// Export stickers service with explicit names to avoid conflicts with media.ts
export {
  createStickerServices,
  generateSticker as generateStickerFromPrompt,
  createStickerFromGallery,
  getStickerPack as getStickerPackInfo,
  getGalleryForStickers,
  findSticker,
} from './stickers.js';
export * from './chat-voting.js';
export * from './memory.js';
export * as twitterOAuth from './twitter-oauth.js';
export * as discord from './discord.js';
export * as propertyResearch from './property-research.js';
// Token launch service
export * as tokenLaunch from './token-launch.js';
// Stripe billing service
export {
  createStripeCheckoutSession,
  createStripeCustomerPortalSession,
  retrieveStripeSubscription,
} from './stripe-billing.js';

// RATI burn stats and tier system
export * as burnStats from './burn-stats.js';

// Avatar ascension (Orb + RATI burn to mint Ascension NFT)
export * as avatarAscend from './avatar-ascend.js';

// Prompt building is now in @swarm/core
// Re-export for backward compatibility
export { buildDynamicSystemPrompt, type ToolCategory, type ProcessorAvatarConfig } from '@swarm/core';

// Usage history service
export * from './usage-history.js';

// GTM funnel events and reporting
export * from './funnel-events.js';
export * from './funnel-emitter.js';
export * from './funnel-report.js';

// Service container (lightweight DI)
export {
  createServiceContainer,
  getDefaultContainer,
  _setDefaultContainer,
  type ServiceContainer,
} from './service-container.js';
