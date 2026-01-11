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
export { createJobTools, type JobServices, type JobInfo, type CreditServices as JobCreditServices, type CreditStatus } from './jobs.js';
export { createReferenceImageTools, type ReferenceImageServices, type ReferenceImage, type ReferenceImageCategory } from './reference.js';
export { createDiagnosticsTools, type IssueSeverity, type IssueCategory } from './diagnostics.js';
export { createTelegramTools, type TelegramServices, type TelegramUserProfile, type TelegramPhoto, type ChatModificationProposal } from './telegram.js';

import { createMediaTools, type CreditServices as MediaCreditServices } from './media.js';
import { createGalleryTools } from './gallery.js';
import { createWalletTools } from './wallet.js';
import { createModelTools } from './models.js';
import { createProfileTools } from './profile.js';
import { createSecretTools } from './secrets.js';
import { createJobTools, type CreditServices as JobCreditServices } from './jobs.js';
import { createReferenceImageTools } from './reference.js';
import { createDiagnosticsTools } from './diagnostics.js';
import { createTelegramTools } from './telegram.js';
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
  telegram?: import('./telegram.js').TelegramServices;
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
  registry.registerAll(createJobTools(services.jobs, services.jobCredits));
  registry.registerAll(createReferenceImageTools(services.reference));
  registry.registerAll(createDiagnosticsTools());
  if (services.telegram) {
    registry.registerAll(createTelegramTools(services.telegram));
  }
}
