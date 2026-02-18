/**
 * Lightweight Service Container
 *
 * Centralizes service wiring into a single factory so that:
 * 1. Handler/adapter code doesn't need 30+ direct imports
 * 2. Tests can inject stubs without module-level mocking
 * 3. Service dependencies are explicit and documented
 *
 * This is intentionally NOT a DI framework — just a typed factory
 * function that returns a bag of service references.
 */

// ── Service module imports ─────────────────────────────────────────────────
import * as avatarService from './avatars.js';
import * as secretsService from './secrets.js';
import * as walletsService from './wallets.js';
import * as telegramService from './telegram.js';
import * as discordService from './discord.js';
import * as mediaService from './media.js';
import * as galleryService from './gallery.js';
import * as creditsService from './credits.js';
import * as mediaJobsService from './media-jobs.js';
import * as voiceService from './voice.js';
import * as avatarOwnershipService from './avatar-ownership.js';
import * as nftGateService from './nft-gate.js';
import * as lineageNftService from './lineage-nft.js';
import * as propertyResearchService from './property-research.js';
import * as stickersService from './stickers.js';
import * as avatarObservabilityService from './avatar-observability.js';
import * as memoryService from './memory.js';
import * as memoryMigrationService from './memory-migration.js';
import * as memoryConsolidationService from './memory-consolidation.js';
import * as observabilityService from './observability.js';
import * as chatVotingService from './chat-voting.js';
import * as chatHistoryService from './chat-history.js';
import * as integrationsService from './integrations.js';
import * as tokenLaunchService from './token-launch.js';
import * as entitlementsService from './entitlements.js';
import { diagnoseTelegram, setupTelegramIntegration } from './telegram-admin.js';
import { createWebSearch } from './web-search.js';
import { createMcpAdminServices } from './mcp-config.js';
import { validateReplicateApiKey } from './replicate.js';
import { getModelsForCapability, AVAILABLE_MODELS } from './models-registry.js';
import { createMoltbookServices } from './moltbook.js';
import { createTwitterServices } from './mcp-twitter-adapter.js';
import {
  createStripeCheckoutSession,
  createStripeCustomerPortalSession,
} from './stripe-billing.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Core service references that handlers and adapters depend on.
 *
 * Each property mirrors a service module's public API.  Tests can supply
 * partial overrides via `createServiceContainer({ avatars: mockAvatars })`.
 */
export interface ServiceContainer {
  avatars: typeof avatarService;
  secrets: typeof secretsService;
  wallets: typeof walletsService;
  telegram: typeof telegramService;
  discord: typeof discordService;
  media: typeof mediaService;
  gallery: typeof galleryService;
  credits: typeof creditsService;
  mediaJobs: typeof mediaJobsService;
  voice: typeof voiceService;
  avatarOwnership: typeof avatarOwnershipService;
  nftGate: typeof nftGateService;
  lineageNft: typeof lineageNftService;
  propertyResearch: typeof propertyResearchService;
  stickers: typeof stickersService;
  avatarObservability: typeof avatarObservabilityService;
  memory: typeof memoryService;
  memoryMigration: typeof memoryMigrationService;
  memoryConsolidation: typeof memoryConsolidationService;
  observability: typeof observabilityService;
  chatVoting: typeof chatVotingService;
  chatHistory: typeof chatHistoryService;
  integrations: typeof integrationsService;
  tokenLaunch: typeof tokenLaunchService;
  entitlements: typeof entitlementsService;

  // Factory / helper services that don't follow the module-namespace pattern
  telegramAdmin: {
    diagnoseTelegram: typeof diagnoseTelegram;
    setupTelegramIntegration: typeof setupTelegramIntegration;
  };
  replicate: {
    validateReplicateApiKey: typeof validateReplicateApiKey;
  };
  modelsRegistry: {
    getModelsForCapability: typeof getModelsForCapability;
    AVAILABLE_MODELS: typeof AVAILABLE_MODELS;
  };
  stripe: {
    createStripeCheckoutSession: typeof createStripeCheckoutSession;
    createStripeCustomerPortalSession: typeof createStripeCustomerPortalSession;
  };

  // Factory functions that produce per-avatar/session service bundles
  createWebSearch: typeof createWebSearch;
  createMcpAdminServices: typeof createMcpAdminServices;
  createMoltbookServices: typeof createMoltbookServices;
  createTwitterServices: typeof createTwitterServices;
  createStickerServices: typeof stickersService.createStickerServices;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a service container, optionally overriding individual services.
 *
 * Production usage (singleton):
 * ```ts
 * import { getDefaultContainer } from './service-container.js';
 * const services = getDefaultContainer();
 * ```
 *
 * Test usage (with overrides):
 * ```ts
 * const services = createServiceContainer({
 *   avatars: mockAvatarService,
 *   memory: mockMemoryService,
 * });
 * ```
 */
export function createServiceContainer(
  overrides: Partial<ServiceContainer> = {},
): ServiceContainer {
  return {
    avatars: avatarService,
    secrets: secretsService,
    wallets: walletsService,
    telegram: telegramService,
    discord: discordService,
    media: mediaService,
    gallery: galleryService,
    credits: creditsService,
    mediaJobs: mediaJobsService,
    voice: voiceService,
    avatarOwnership: avatarOwnershipService,
    nftGate: nftGateService,
    lineageNft: lineageNftService,
    propertyResearch: propertyResearchService,
    stickers: stickersService,
    avatarObservability: avatarObservabilityService,
    memory: memoryService,
    memoryMigration: memoryMigrationService,
    memoryConsolidation: memoryConsolidationService,
    observability: observabilityService,
    chatVoting: chatVotingService,
    chatHistory: chatHistoryService,
    integrations: integrationsService,
    tokenLaunch: tokenLaunchService,
    entitlements: entitlementsService,

    telegramAdmin: {
      diagnoseTelegram,
      setupTelegramIntegration,
    },
    replicate: {
      validateReplicateApiKey,
    },
    modelsRegistry: {
      getModelsForCapability,
      AVAILABLE_MODELS,
    },
    stripe: {
      createStripeCheckoutSession,
      createStripeCustomerPortalSession,
    },

    createWebSearch,
    createMcpAdminServices,
    createMoltbookServices,
    createTwitterServices,
    createStickerServices: stickersService.createStickerServices,

    // Apply overrides last so they win
    ...overrides,
  };
}

// ── Default singleton ──────────────────────────────────────────────────────

let _defaultContainer: ServiceContainer | null = null;

/**
 * Return the default (production) service container.
 *
 * Lazily created on first call and cached for the lifetime of the process.
 * Lambda cold-starts will create this once.
 */
export function getDefaultContainer(): ServiceContainer {
  if (!_defaultContainer) {
    _defaultContainer = createServiceContainer();
  }
  return _defaultContainer;
}

/**
 * Replace the default container (for integration tests).
 * Returns the previous container so callers can restore it.
 */
export function _setDefaultContainer(
  container: ServiceContainer | null,
): ServiceContainer | null {
  const prev = _defaultContainer;
  _defaultContainer = container;
  return prev;
}
