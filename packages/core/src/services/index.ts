/**
 * Services barrel export
 */
export { BedrockLLMService, OpenRouterLLMService, createLLMService } from './llm/index.js';
export {
  SwarmMediaService,
  createMediaService,
  createMediaServiceWithDeps,
  type GeneratedMediaExtended,
} from './media/index.js';
export {
  createMediaDependencies,
  createMediaDependenciesWithValidation,
  createModelResolver,
  createApiKeyResolver,
  createTrialCreditConsumer,
  createCreditChecker,
  createCreditConsumer,
  createGallerySaver,
  createReplicateInputValidator,
  type ResolverConfig,
} from './media/resolvers.js';
export {
  DEFAULT_MODELS,
  type AICapability,
  type MediaServiceDependencies,
  type GenerateImageOptions,
  type ResolvedModel,
  type ResolvedApiKey,
  type CreditCheckResult,
  type GalleryItemInput,
  type GalleryItemOutput,
} from './media/types.js';
export { SwarmSolanaService, createSolanaService } from './solana/index.js';
export { DynamoDBStateService, createStateService, CHANNEL_CONFIG, getLastHeartbeat, setLastHeartbeat } from './state.js';
export { AWSSecretsService, createSecretsService } from './secrets.js';
export { ActivityService, createActivityService, type ActivityEvent } from './activity.js';
export { DynamoDBUsageMeteringService, createUsageMeteringService } from './usage.js';
export {
  DynamoDBPresenceService,
  createPresenceService,
  PRESENCE_CONFIG,
  type PresenceService,
  type PlatformConnection,
  type ChannelInfo,
  type ChannelDetail,
  type RateLimitStatus,
} from './presence.js';
export {
  OpenRouterChannelSummaryService,
  SimpleChannelSummaryService,
  createChannelSummaryService,
  SUMMARY_CONFIG,
  type ChannelSummaryService,
} from './channel-summary.js';
export {
  DynamoDBContentStoreService,
  createContentStoreService,
  type ContentStoreService,
} from './content-store.js';
export {
  enqueuePost,
  isPostQueueConfigured,
  getPostQueueUrl,
} from './post-queue.js';
export {
  enqueueMediaJob,
  isMediaQueueConfigured,
  getMediaQueueUrl,
  type MediaQueueMessage,
} from './media-queue.js';
export {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitState,
} from './circuit-breaker.js';
export {
  createLegacyBrainService,
  type BrainService,
  type BrainMemoryFact,
  type BrainRememberResult,
  type BrainRecallResult,
} from './brain.js';
export {
  createCanonicalMemoryClient,
  _setDynamoClient as _setCanonicalDynamoClient,
  type CanonicalMemoryModule,
} from './brain/canonical-memory.js';
export {
  normalizeTier,
  toLegacyTier,
  getTierPolicy,
  computeRetentionScore,
  recommendTier,
  evaluateTierTransitions,
  computeTierTtl,
  estimateStorageCost,
  estimateCostSavings,
  recordAccess,
  fetchAccessMetrics,
  planTierMigration,
  applyTierTransitions,
  TIER_POLICIES,
  LEGACY_TIER_MAP,
  DURABLE_TO_LEGACY_MAP,
  _setDynamoClient as _setTierDynamoClient,
  type DurableMemoryTier,
  type LegacyMemoryTier,
  type AnyMemoryTier,
  type TierPolicy,
  type AccessMetrics,
  type TierTransition,
  type TierMigrationResult,
  type TierEvaluationOptions,
} from './brain/memory-tiers.js';
export {
  appendMessage,
  getRecentMessages,
  updateOverlay,
  getOverlay,
  getRoomState,
  _setDynamoClient as _setSharedRoomDynamoClient,
  MESSAGE_TTL_DAYS,
  OVERLAY_TTL_DAYS,
} from './shared-room.js';
export {
  createSqsOffloadService,
  createSqsOffloadServiceFromEnv,
  SQS_OFFLOAD_CONSTANTS,
  type SqsOffloadService,
  type SqsOffloadConfig,
  type OffloadResult,
  type OffloadedMessageRef,
} from './sqs-offload.js';
export {
  chunkContent,
  reassembleChunks,
  storeDraft,
  getDocument,
  markChunkSent,
  exportDocument,
  _setDynamoClient as _setLongFormDynamoClient,
} from './long-form.js';
export {
  IdentityLinkServiceImpl,
  createIdentityLinkService,
  _setIdentityLinkDynamoClient,
} from './identity-link.js';
export {
  selectPrimaryResponder,
  DEFAULT_TURN_ARBITER_CONFIG,
  type TurnCandidate,
  type TurnMessage,
  type TurnArbiterConfig,
  type TurnDecision,
} from './turn-arbiter.js';
export {
  generateRoomKey,
  parseRoomKey,
  type ParsedRoomKey,
} from './room-key.js';
export {
  DefaultRoomCoordinator,
  roomEventToTurnMessage,
  mapWinReason,
} from './room-coordinator.js';
export {
  evaluateProactive,
  calculateBotDensity,
  recordProactiveMessage,
  getAvatarBudgetUsed,
  _resetBudgets as _resetProactiveBudgets,
  DEFAULT_PROACTIVE_CONFIG,
} from './proactive-scheduler.js';
export {
  GitHubAppTokenProvider,
  createAppJwt,
  _setSecretsClient as _setGitHubAppSecretsClient,
  type GitHubTokenProvider,
  type GitHubAppCredentials,
} from './github-app-token.js';
export {
  createRaticrossBridgeClient,
  type RaticrossBridgeClient,
} from './raticross-client.js';
export {
  getIssue as getGitHubIssue,
  listIssues as listGitHubIssues,
  listAvatarIssues as listGitHubAvatarIssues,
  getRecentReleases as getGitHubRecentReleases,
  getDeploymentStatus as getGitHubDeploymentStatus,
  clearGitHubCache,
  type GitHubIssue,
  type GitHubRelease,
  type GitHubClientConfig,
  type GitHubIssueFilters,
} from './github-client.js';
