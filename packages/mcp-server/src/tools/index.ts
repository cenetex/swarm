/**
 * Tools Index
 * 
 * Re-exports all tool factories for easy registration.
 */
export { createMediaTools, type MediaServices, type CreditServices as MediaCreditServices } from './media.js';
export { createGalleryTools, type GalleryServices, type GalleryItem } from './gallery.js';
export { createWalletTools, type WalletServices, type WalletInfo } from './wallet.js';
export { createModelTools, type ModelServices, type ModelInfo } from './models.js';
export { createProfileTools, type ProfileServices } from './profile.js';
export { createSecretTools, type SecretServices, type SecretType, type SecretInfo } from './secrets.js';
export { createAdminTools, type AdminToolServices, type ToggleableFeature } from './admin.js';
export { createJobTools, type JobServices, type JobInfo, type CreditServices as JobCreditServices, type CreditStatus, type EnergyStatus } from './jobs.js';
export { createReferenceImageTools, type ReferenceImageServices, type ReferenceImage, type ReferenceImageCategory } from './reference.js';
export { createDiagnosticsTools, type IssueSeverity, type IssueCategory } from './diagnostics.js';
export { createTelegramTools, type TelegramServices, type TelegramUserProfile, type TelegramPhoto, type ChatModificationProposal } from './telegram.js';
export { createTwitterTools, type TwitterServices, type TwitterConnectionStatus, type Tweet } from './twitter.js';
export { createVoiceTools, type VoiceServices, type VoiceTranscription, type VoiceMessage } from './voice.js';
export {
  createDiscordTools,
  type DiscordServices,
  type DiscordConnectionStatus,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMessageInfo,
} from './discord.js';
export { createMemoryTools, type MemoryServices, type MemoryFact } from './memory.js';
export {
  createNFTTools,
  type NFTServices,
  type GateStatus,
  type InhabitationInfo,
  type UnclaimedAgent,
  type InhabitResult,
  type AbandonResult,
  type BurnVerification,
  type LineageMetadata,
  type MintPreparation,
  type LineageCollection,
  type AgentInhabitationStatus,
} from './nft.js';
export {
  createPropertyTools,
  buildPropertyContext,
  type PropertyServices,
  type PropertyAddress,
  type PropertyResearchJob,
  type ResearchProgress,
} from './property.js';
export {
  createStickerTools,
  type StickerServices,
  type StickerInfo,
  type StickerPackInfo,
  type GalleryItemForSticker,
} from './stickers.js';

import { createMediaTools, type CreditServices as MediaCreditServices } from './media.js';
import { createGalleryTools } from './gallery.js';
import { createWalletTools } from './wallet.js';
import { createModelTools } from './models.js';
import { createProfileTools } from './profile.js';
import { createSecretTools } from './secrets.js';
import { createAdminTools } from './admin.js';
import { createJobTools, type CreditServices as JobCreditServices } from './jobs.js';
import { createReferenceImageTools } from './reference.js';
import { createDiagnosticsTools } from './diagnostics.js';
import { createTelegramTools } from './telegram.js';
import { createTwitterTools } from './twitter.js';
import { createVoiceTools } from './voice.js';
import { createDiscordTools } from './discord.js';
import { createMemoryTools } from './memory.js';
import { createNFTTools } from './nft.js';
import { createPropertyTools } from './property.js';
import { createStickerTools } from './stickers.js';
import type { ToolRegistry } from '../registry.js';

/**
 * Unified service interface for all tools
 */
export interface AllServices {
  media: import('./media.js').MediaServices;
  mediaCredits: MediaCreditServices;
  jobCredits: JobCreditServices;
  gallery: import('./gallery.js').GalleryServices;
  wallets: import('./wallet.js').WalletServices;
  models: import('./models.js').ModelServices;
  profile: import('./profile.js').ProfileServices;
  secrets: import('./secrets.js').SecretServices;
  jobs: import('./jobs.js').JobServices;
  reference: import('./reference.js').ReferenceImageServices;
  voice?: import('./voice.js').VoiceServices;
  memory?: import('./memory.js').MemoryServices;
  telegram?: import('./telegram.js').TelegramServices;
  twitter?: import('./twitter.js').TwitterServices;
  discord?: import('./discord.js').DiscordServices;
  nft?: import('./nft.js').NFTServices;
  property?: import('./property.js').PropertyServices;
  stickers?: import('./stickers.js').StickerServices;
}

/**
 * Register all tools with a registry
 */
export function registerAllTools(
  registry: ToolRegistry,
  services: AllServices
): void {
  registry.registerAll(createMediaTools(services.media, services.mediaCredits));
  registry.registerAll(createGalleryTools(services.gallery));
  registry.registerAll(createWalletTools(services.wallets));
  registry.registerAll(createModelTools(services.models));
  registry.registerAll(createProfileTools(services.profile));
  registry.registerAll(createSecretTools(services.secrets));
  registry.registerAll(createAdminTools({ twitter: services.twitter }));
  registry.registerAll(createJobTools(services.jobs, services.jobCredits));
  registry.registerAll(createReferenceImageTools(services.reference));
  registry.registerAll(createDiagnosticsTools());
  if (services.voice) {
    registry.registerAll(createVoiceTools(services.voice));
  }
  if (services.memory) {
    registry.registerAll(createMemoryTools(services.memory));
  }
  if (services.telegram) {
    registry.registerAll(createTelegramTools(services.telegram));
  }
  if (services.twitter) {
    registry.registerAll(createTwitterTools(services.twitter));
  }
  if (services.discord) {
    registry.registerAll(createDiscordTools(services.discord));
  }
  if (services.nft) {
    registry.registerAll(createNFTTools(services.nft));
  }
  if (services.property) {
    registry.registerAll(createPropertyTools(services.property));
  }
  if (services.stickers) {
    registry.registerAll(createStickerTools(services.stickers));
  }
}
