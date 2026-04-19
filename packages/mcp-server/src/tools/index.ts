/**
 * Tools Index
 * 
 * Re-exports all tool factories for easy registration.
 */
export { createMediaTools, type MediaServices, type CreditServices as MediaCreditServices } from './media.js';
export { createGalleryTools, type GalleryServices, type GalleryItem } from './gallery.js';
export { createWalletTools, type WalletServices, type WalletInfo } from './wallet.js';
export { createModelTools, type ModelServices, type ModelInfo } from './models.js';
export { createMediaModelTools, type MediaModelServices, type ReplicateModelSearchResult } from './media-models.js';
export { createProfileTools, type ProfileServices } from './profile.js';
export { createSecretTools, type SecretServices, type SecretType, type SecretInfo } from './secrets.js';
export {
  createAdminTools,
  type AdminToolServices,
  type ToggleableFeature,
  type ConfigurableIntegration,
  type IntegrationStatus,
  type ModelInfo as AdminModelInfo,
  type TestConnectionResult,
  type AvatarStatus,
  CONFIGURABLE_INTEGRATIONS,
  AI_CAPABILITIES,
  AVATAR_STATUSES,
} from './admin.js';
export { createJobTools, type JobServices, type JobInfo, type CreditServices as JobCreditServices, type CreditStatus, type EnergyStatus } from './jobs.js';
export { createReferenceImageTools, type ReferenceImageServices, type ReferenceImage, type ReferenceImageCategory } from './reference.js';
export { createDiagnosticsTools, type IssueSeverity, type IssueCategory, type DiagnosticsServices } from './diagnostics.js';
export { createTelegramTools, type TelegramServices, type TelegramUserProfile, type TelegramPhoto, type ChatModificationProposal } from './telegram.js';
export { createTwitterTools, type TwitterServices, type TwitterConnectionStatus, type Tweet, type ContentStorePost, type ModerationConfig } from './twitter.js';
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
  type UnclaimedAvatar,
  type InhabitResult,
  type AbandonResult,
  type BurnVerification,
  type LineageMetadata,
  type MintPreparation,
  type LineageCollection,
  type AvatarInhabitationStatus,
  type ClaimableNFT,
  type ClaimNFTResult,
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
export {
  createClaudeCodeTools,
  type ClaudeCodeServices,
  type ClaudeCodeJob,
  type ClaudeCodeJobStatus,
} from './claude-code.js';
export {
  createMcpAdminTools,
  type McpAdminServices,
  type McpConfig,
  type ExternalMcpServer,
} from './mcp-admin.js';
export {
  createPresenceTools,
  type PresenceServices,
  type PlatformStatus,
  type ChannelOverview,
  type RateLimitInfo,
} from './presence.js';
export {
  createObservabilityTools,
  type ObservabilityServices,
  type SystemStatusResult,
  type AvatarActivityResult,
} from './observability.js';
export {
  createTokenLaunchTools,
  type TokenLaunchServices,
  type TokenLaunchInfo,
  type TokenLaunchConfig,
  type TokenLaunchResult,
  type TokenLaunchPreflightResult,
} from './token-launch.js';
export {
  createBillingTools,
  type BillingServices,
  type BillingEntitlement,
  type BillingUsage,
} from './billing.js';
export {
  createGitHubIssueTools,
  type GitHubIssueServices,
} from './github-issues.js';
export {
  createDesignPartnerTools,
  type DesignPartnerServices,
  type DesignPartnerInviteInfo,
  type DesignPartnerInfo,
  type DesignPartnerMeta as DesignPartnerMetaInfo,
} from './design-partner.js';
export {
  createBlogTools,
  type BlogServices,
} from './blog.js';
export {
  createSignalStationTools,
  type SignalStationServices,
  type StationState,
  type CommandResult,
  type ChannelMessage,
  type ChannelReadResponse,
  type ChannelPostResponse,
} from './signal-station.js';

import { createMediaTools, type CreditServices as MediaCreditServices } from './media.js';
import { createGalleryTools } from './gallery.js';
import { createWalletTools } from './wallet.js';
import { createModelTools } from './models.js';
import { createMediaModelTools } from './media-models.js';
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
import { createClaudeCodeTools } from './claude-code.js';
import { createMcpAdminTools } from './mcp-admin.js';
import { createPresenceTools } from './presence.js';
import { createObservabilityTools } from './observability.js';
import { createTokenLaunchTools } from './token-launch.js';
import { createBillingTools } from './billing.js';
import { createGitHubIssueTools } from './github-issues.js';
import { createDesignPartnerTools } from './design-partner.js';
import { createBlogTools } from './blog.js';
import { createSignalStationTools } from './signal-station.js';
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
  claudeCode?: import('./claude-code.js').ClaudeCodeServices;
  diagnostics?: import('./diagnostics.js').DiagnosticsServices;
  mcpAdmin?: import('./mcp-admin.js').McpAdminServices;
  // Unified integrations configuration service
  integrations?: import('./admin.js').AdminToolServices['integrations'];
  // Avatar status management
  avatar?: import('./admin.js').AdminToolServices['avatar'];
  // Cross-platform presence
  presence?: import('./presence.js').PresenceServices;
  observability?: import('./observability.js').ObservabilityServices;
  // Token launch
  tokenLaunch?: import('./token-launch.js').TokenLaunchServices;
  // Billing / Stripe subscriptions
  billing?: import('./billing.js').BillingServices;
  // Media model discovery & configuration (Replicate)
  mediaModels?: import('./media-models.js').MediaModelServices;
  // GitHub issue tracking (read-only)
  githubIssues?: import('./github-issues.js').GitHubIssueServices;
  // Design partner invite management (admin-only)
  designPartner?: import('./design-partner.js').DesignPartnerServices;
  // Blog posting
  blog?: import('./blog.js').BlogServices;
  // Signal space mining station governance
  signalStation?: import('./signal-station.js').SignalStationServices;
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
  registry.registerAll(createAdminTools({ twitter: services.twitter, integrations: services.integrations, avatar: services.avatar }));
  registry.registerAll(createJobTools(services.jobs, services.jobCredits));
  registry.registerAll(createReferenceImageTools(services.reference));
  registry.registerAll(createDiagnosticsTools(services.diagnostics));
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
  if (services.claudeCode) {
    registry.registerAll(createClaudeCodeTools(services.claudeCode));
  }
  if (services.mcpAdmin) {
    registry.registerAll(createMcpAdminTools(services.mcpAdmin));
  }
  if (services.presence) {
    registry.registerAll(createPresenceTools(services.presence));
  }
  if (services.observability) {
    registry.registerAll(createObservabilityTools(services.observability));
  }
  if (services.tokenLaunch) {
    registry.registerAll(createTokenLaunchTools(services.tokenLaunch));
  }
  if (services.billing) {
    registry.registerAll(createBillingTools(services.billing));
  }
  if (services.mediaModels) {
    registry.registerAll(createMediaModelTools(services.mediaModels));
  }
  if (services.githubIssues) {
    registry.registerAll(createGitHubIssueTools(services.githubIssues));
  }
  if (services.designPartner) {
    registry.registerAll(createDesignPartnerTools(services.designPartner));
  }
  if (services.blog) {
    registry.registerAll(createBlogTools(services.blog));
  } else {
    // Blog tools can run without a service (uses core publishBlogPost directly)
    registry.registerAll(createBlogTools({}));
  }
  if (services.signalStation) {
    registry.registerAll(createSignalStationTools(services.signalStation));
  }
}
