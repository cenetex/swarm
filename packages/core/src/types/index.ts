/**
 * Core type definitions for the Swarm framework
 */
import { z } from 'zod';
import type { Platform } from './platform.js';

// =============================================================================
// PLATFORM & CONFIG TYPES (defined in platform.ts to avoid circular deps)
// =============================================================================

export type {
  Platform,
  AvatarConfig,
  PlatformConfigs,
  RaticrossConfig,
  TelegramUserRef,
  TelegramChatRef,
  TelegramConfig,
  DiscordConfig,
  TwitterCommunityConfig,
  AutonomousPostsConfig,
  TwitterConfig,
  WebConfig,
  LLMConfig,
  VoiceConfig,
  MediaConfig,
  SchedulingConfig,
  ScheduledTweet,
  BehaviorConfig,
  SolanaConfig,
  SolanaFeature,
} from './platform.js';

export const PlatformSchema = z.enum(['telegram', 'discord', 'twitter', 'web', 'shared-chat']);

// =============================================================================
// MESSAGE ENVELOPE
// =============================================================================

/**
 * Universal message envelope that normalizes messages across all platforms
 */
export interface SwarmEnvelope {
  // Routing
  avatarId: string;
  platform: Platform;

  // Correlation
  traceId?: string;
  
  // Message identification
  messageId: string;
  conversationId: string; // Channel/chat/thread ID
  timestamp: number;
  
  // Sender info
  sender: SenderInfo;
  
  // Content
  content: MessageContent;
  
  // Context
  replyTo?: string; // Message ID being replied to
  mentions: Mention[];
  
  // Platform-specific raw data
  raw: unknown;
  
  // Processing metadata
  metadata: EnvelopeMetadata;
}

export interface SenderInfo {
  id: string;
  username?: string;
  displayName?: string;
  isBot: boolean;
  
  // Platform-specific
  platform: Platform;
  platformUserId: string;
  
  // Solana integration
  walletAddress?: string;
  tokenBalance?: number;
  nftHoldings?: string[];
}

export interface MessageContent {
  text?: string;
  media?: MediaAttachment[];
  sticker?: StickerInfo;
  command?: CommandInfo;
}

export interface MediaAttachment {
  type: 'photo' | 'video' | 'audio' | 'document' | 'animation';
  url?: string;
  fileId?: string; // Platform file reference
  mimeType?: string;
  size?: number;
}

export interface StickerInfo {
  fileId: string;
  emoji?: string;
  setName?: string;
  isAnimated: boolean;
}

export interface CommandInfo {
  command: string; // Without leading /
  args: string[];
  raw: string;
}

export interface Mention {
  userId: string;
  username?: string;
  offset: number;
  length: number;
}

/**
 * Metadata about a forwarded message (Telegram-specific)
 */
export interface ForwardMetadata {
  /** Type of forward origin */
  originType: 'user' | 'hidden_user' | 'chat' | 'channel' | 'unknown';
  /** User ID of the original sender (if available) */
  originalSenderId?: string;
  /** Username of the original sender (if available) */
  originalSenderUsername?: string;
  /** Display name of the original sender (if available) */
  originalSenderName?: string;
  /** Whether the original sender is a bot */
  originalSenderIsBot?: boolean;
  /** Whether the forward is from BotFather specifically */
  isFromBotFather: boolean;
  /** Original message date (Unix timestamp) */
  originalDate?: number;
  /** Chat ID if forwarded from a channel/group */
  originalChatId?: string;
  /** Chat title if forwarded from a channel/group */
  originalChatTitle?: string;
}

export interface EnvelopeMetadata {
  receivedAt: number;
  processedAt?: number;

  // Processing flags
  shouldRespond?: boolean;
  responseReason?: string;
  priority: 'high' | 'normal' | 'low';

  // Rate limiting
  userCooldownUntil?: number;

  // Idempotency
  idempotencyKey: string;

  // Direct engagement detection (Kyro-style)
  isMention?: boolean;      // Message contains @botUsername
  isReplyToBot?: boolean;   // Message is a reply to bot's message

  // Telegram-specific context (preserved for channel state)
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // Telegram-specific forward metadata (for detecting BotFather messages, etc.)
  forwardMetadata?: ForwardMetadata;

  // Discord-specific context
  guildId?: string;

  // Platform-specific raw update ID (for deduplication)
  platformUpdateId?: string | number;
}

// =============================================================================
// RESPONSE TYPES
// =============================================================================

export interface SwarmResponse {
  avatarId: string;
  platform: Platform;
  conversationId: string;
  replyToMessageId?: string;
  
  // Response content
  actions: ResponseAction[];
  
  // Metadata
  generatedAt: number;
  llmModel: string;
  tokensUsed: number;
}

export type ResponseAction = 
  | SendMessageAction
  | SendMediaAction
  | SendVoiceAction
  | SendStickerAction
  | ReactAction
  | TakeSelfieAction
  | GenerateVideoAction
  | GenerateImageAction
  | WaitAction
  | IgnoreAction
  | SolanaAction;

export interface SendMessageAction {
  type: 'send_message';
  text: string;
  media?: GeneratedMedia[];
  replyToMessageId?: string;
}

export interface SendMediaAction {
  type: 'send_media';
  mediaType: 'image' | 'video' | 'animation';
  url: string;
  caption?: string;
  replyToMessageId?: string;
}

export interface SendVoiceAction {
  type: 'send_voice';
  url: string;
  caption?: string;
  replyToMessageId?: string;
}

export interface SendStickerAction {
  type: 'send_sticker';
  emoji: string;
  stickerId?: string;
}

export interface ReactAction {
  type: 'react';
  emoji: string;
  messageId: string;
}

export interface TakeSelfieAction {
  type: 'take_selfie';
  prompt: string;
  style?: string;
}

export interface GenerateVideoAction {
  type: 'generate_video';
  prompt: string;
  duration?: number;
}

export interface GenerateImageAction {
  type: 'generate_image';
  prompt: string;
  aspectRatio?: string;
  referenceImageUrls?: string[];
}

export interface WaitAction {
  type: 'wait';
  durationMs: number;
  reason?: string;
}

export interface IgnoreAction {
  type: 'ignore';
  reason: string;
}

export interface SolanaAction {
  type: 'solana';
  operation: 'transfer' | 'mint_nft' | 'verify_balance' | 'airdrop';
  params: Record<string, unknown>;
}

export interface GeneratedMedia {
  type: 'image' | 'video' | 'sticker';
  url: string;
  s3Key?: string;
  prompt: string;
  model: string;
}

// =============================================================================
// QUEUE MESSAGE TYPES
// =============================================================================

export interface MessageQueueItem {
  envelope: SwarmEnvelope;
  enqueuedAt: number;
  attempts: number;
  maxAttempts: number;
}

export interface ResponseQueueItem {
  avatarId: string;
  envelope: SwarmEnvelope;
  enqueuedAt: number;
  priority: 'high' | 'normal' | 'low';
}

export interface MediaQueueItem {
  avatarId: string;
  conversationId: string;
  action: TakeSelfieAction | GenerateVideoAction;
  callbackUrl?: string;
  enqueuedAt: number;
}

// =============================================================================
// STATE TYPES
// =============================================================================

/**
 * Channel state machine states (Kyro-style)
 */
export type ChannelStateMachine = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

/**
 * Response trigger types
 */
export type ResponseTrigger =
  | 'direct_engagement'    // Mention or reply to bot
  | 'engaged_user'         // Follow-up from recently engaged user
  | 'message_threshold'    // N messages accumulated
  | 'conversation_gap'     // Silence after activity
  | 'scheduled'            // Scheduled evaluation
  | 'private_chat'         // Always respond in private
  | 'none';                // No trigger

/**
 * Response decision from evaluateResponseTrigger
 */
export interface ResponseDecision {
  shouldRespond: boolean;
  trigger: ResponseTrigger;
  delay: number;           // Delay in ms before responding (0 = immediate)
  priority: 'high' | 'normal' | 'low';
}

export interface ChannelState {
  avatarId: string;
  channelId: string;
  platform: Platform;

  // Recent messages for context
  recentMessages: ContextMessage[];

  // Conversation summary
  summary?: string;
  summaryUpdatedAt?: number;

  // Channel metadata
  lastActivityAt: number;
  messageCount: number;

  // === Kyro-style state machine fields ===

  // State machine
  state?: ChannelStateMachine;
  stateChangedAt?: number;

  // Chat context (Telegram-specific)
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // Response tracking
  lastResponseAt?: number;
  lastResponseMessageId?: string;
  pendingResponseAt?: number;  // Scheduled response time

  // Engagement tracking
  directEngagementAt?: number;  // Last mention/reply timestamp

  // Engaged users tracking: { [userId]: engagedUntil timestamp }
  engagedUsers?: Record<string, number>;

  // TTL for cleanup (DynamoDB TTL in seconds)
  ttl?: number;
}

export interface ContextMessage {
  messageId: string;
  sender: string;
  isBot: boolean;
  content: string;
  timestamp: number;

  // Extended fields for Kyro-style context
  userId?: string;
  username?: string;
  isMention?: boolean;
  isReplyToBot?: boolean;
  replyToMessageId?: string;
}

export interface UserCooldown {
  avatarId: string;
  platform: Platform;
  userId: string;
  cooldownUntil: number;
  reason?: string;
}

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ServiceContainer,
  UsageCredit,
  UsageConfig,
  UsageMeteringService,
  StateService,
  MemoryFact,
  LLMService,
  LLMGenerateParams,
  LLMMessage,
  LLMResponse,
  ToolCall,
  MediaServiceGenerateOptions,
  MediaService,
  SecretsService,
  SolanaService,
  NFTMetadata,
} from './service.js';

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

// Platform Configs
export const TelegramUserRefSchema = z.object({
  userId: z.string(),
  username: z.string().optional(),
  displayName: z.string().optional(),
});

export const TelegramChatRefSchema = z.object({
  chatId: z.string(),
  username: z.string().optional(),
  title: z.string().optional(),
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean(),
  botUsername: z.string(),
  botId: z.number().optional(),
  webhookPath: z.string(),
  allowedChatTypes: z.array(z.enum(['private', 'group', 'supergroup', 'channel'])).optional(),
  allowedChatIds: z.array(z.string()).optional(),
  allowedDmUserIds: z.array(z.string()).optional(),
  allowedDmUsers: z.array(TelegramUserRefSchema).optional(),
  allowedChats: z.array(TelegramChatRefSchema).optional(),
  homeChannelId: z.string().optional(),
  homeChannelUsername: z.string().optional(),
  homeChannelUrl: z.string().optional(),
  coinSymbol: z.string().optional(),
  coinAddress: z.string().optional(),
});

export const DiscordConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['webhook', 'bot', 'hybrid', 'global']),

  // Webhook mode
  webhookUrl: z.string().optional(),
  webhookId: z.string().optional(),
  webhookToken: z.string().optional(),

  // Bot mode
  applicationId: z.string().optional(),
  publicKey: z.string().optional(),

  // Gateway options
  useGateway: z.boolean().optional(),
  intents: z.number().optional(),

  // Behavior
  respondToMentions: z.boolean().optional(),
  respondInDMs: z.boolean().optional(),
  allowedChannels: z.array(z.string()).optional(),
  allowedGuilds: z.array(z.string()).optional(),
  allowedRoleIds: z.array(z.string()).optional(),
});

export const TwitterCommunityConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  postFrequency: z.number().optional(),
});

export const AutonomousPostsConfigSchema = z.object({
  enabled: z.boolean(),
  minIntervalHours: z.number().default(4),
  maxIntervalHours: z.number().default(6),
  imageChance: z.number().min(0).max(1).default(0.3),
  useMemories: z.boolean().default(true),
  topics: z.array(z.string()).optional(),
});

export const TwitterConfigSchema = z.object({
  enabled: z.boolean(),
  username: z.string(),
  features: z.array(z.enum(['scheduled_tweets', 'mention_replies', 'dm_responses', 'autonomous_posts', 'community_posts'])),
  charLimit: z.number().optional(),
  verifiedType: z.string().optional(),
  communities: z.array(TwitterCommunityConfigSchema).optional(),
  autonomousPosts: AutonomousPostsConfigSchema.optional(),
  simulation: z.object({
    enabled: z.boolean(),
    feedVisibility: z.enum(['self', 'linked']),
    autoApprove: z.boolean(),
  }).optional(),
});

export const WebConfigSchema = z.object({
  enabled: z.boolean(),
  corsOrigins: z.array(z.string()),
  rateLimit: z.object({
    windowMs: z.number(),
    maxRequests: z.number(),
  }),
  tokenGated: z.object({
    enabled: z.boolean(),
    tokenMint: z.string(),
    minBalance: z.number(),
  }).optional(),
});

export const PlatformConfigsSchema = z.object({
  telegram: TelegramConfigSchema.optional(),
  discord: DiscordConfigSchema.optional(),
  twitter: TwitterConfigSchema.optional(),
  web: WebConfigSchema.optional(),
});

export const LLMConfigSchema = z.object({
  provider: z.enum(['bedrock', 'openrouter', 'anthropic']),
  model: z.string(),
  fallbackModel: z.string().optional(),
  temperature: z.number(),
  maxTokens: z.number(),
});

export const VoiceConfigSchema = z.object({
  enabled: z.boolean(),
  defaultVoiceId: z.string().optional(),
  ttsProvider: z.enum(['voice-clone']).optional(),
  speed: z.number().optional(),
  pitch: z.number().optional(),
  format: z.enum(['ogg', 'mp3', 'wav']).optional(),
  referenceUrl: z.string().optional(),
});

export const MediaConfigSchema = z.object({
  image: z.object({
    provider: z.enum(['openrouter', 'replicate', 'dalle']),
    model: z.string(),
  }),
  video: z.object({
    provider: z.literal('replicate'),
    model: z.string(),
  }).optional(),
});

export const ScheduledTweetSchema = z.object({
  cron: z.string(),
  template: z.string(),
  enabled: z.boolean(),
});

export const SchedulingConfigSchema = z.object({
  tweets: z.array(ScheduledTweetSchema).optional(),
  mentionCheck: z.object({ cron: z.string() }).optional(),
  maintenance: z.object({ cron: z.string() }).optional(),
});

export const BehaviorConfigSchema = z.object({
  responseDelayMs: z.tuple([z.number(), z.number()]),
  typingIndicator: z.boolean(),
  ignoreBots: z.boolean(),
  cooldownMinutes: z.number(),
  maxContextMessages: z.number(),
});

export const SolanaFeatureSchema = z.enum([
  'token_gating',
  'nft_generation',
  'token_transfers',
  'balance_queries',
  'wallet_verification',
]);

export const SolanaConfigSchema = z.object({
  enabled: z.boolean(),
  network: z.enum(['mainnet-beta', 'devnet', 'testnet']),
  rpcUrl: z.string(),
  tokenMint: z.string().optional(),
  walletSecretName: z.string(),
  features: z.array(SolanaFeatureSchema),
});

export const AvatarConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  persona: z.string(),
  platforms: PlatformConfigsSchema,
  llm: LLMConfigSchema,
  media: MediaConfigSchema,
  scheduling: SchedulingConfigSchema,
  behavior: BehaviorConfigSchema,
  voice: VoiceConfigSchema.optional(),
  solana: SolanaConfigSchema.optional(),
  tools: z.array(z.string()),
  secrets: z.array(z.string()),
});

// Message Envelope Schemas
export const MediaAttachmentSchema = z.object({
  type: z.enum(['photo', 'video', 'audio', 'document', 'animation']),
  url: z.string().optional(),
  fileId: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

export const StickerInfoSchema = z.object({
  fileId: z.string(),
  emoji: z.string().optional(),
  setName: z.string().optional(),
  isAnimated: z.boolean(),
});

export const CommandInfoSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  raw: z.string(),
});

export const MessageContentSchema = z.object({
  text: z.string().optional(),
  media: z.array(MediaAttachmentSchema).optional(),
  sticker: StickerInfoSchema.optional(),
  command: CommandInfoSchema.optional(),
});

export const MentionSchema = z.object({
  userId: z.string(),
  username: z.string().optional(),
  offset: z.number(),
  length: z.number(),
});

export const SenderInfoSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  isBot: z.boolean(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  walletAddress: z.string().optional(),
  tokenBalance: z.number().optional(),
  nftHoldings: z.array(z.string()).optional(),
});

export const ForwardMetadataSchema = z.object({
  originType: z.enum(['user', 'hidden_user', 'chat', 'channel', 'unknown']),
  originalSenderId: z.string().optional(),
  originalSenderUsername: z.string().optional(),
  originalSenderName: z.string().optional(),
  originalSenderIsBot: z.boolean().optional(),
  isFromBotFather: z.boolean(),
  originalDate: z.number().optional(),
  originalChatId: z.string().optional(),
  originalChatTitle: z.string().optional(),
});

export const EnvelopeMetadataSchema = z.object({
  receivedAt: z.number(),
  processedAt: z.number().optional(),
  shouldRespond: z.boolean().optional(),
  responseReason: z.string().optional(),
  priority: z.enum(['high', 'normal', 'low']),
  userCooldownUntil: z.number().optional(),
  idempotencyKey: z.string(),
  isMention: z.boolean().optional(),
  isReplyToBot: z.boolean().optional(),
  chatType: z.enum(['private', 'group', 'supergroup', 'channel']).optional(),
  chatTitle: z.string().optional(),
  forwardMetadata: ForwardMetadataSchema.optional(),
  guildId: z.string().optional(),
  platformUpdateId: z.union([z.string(), z.number()]).optional(),
});

export const SwarmEnvelopeSchema = z.object({
  avatarId: z.string(),
  platform: PlatformSchema,
  traceId: z.string().optional(),
  messageId: z.string(),
  conversationId: z.string(),
  timestamp: z.number(),
  sender: SenderInfoSchema,
  content: MessageContentSchema,
  replyTo: z.string().optional(),
  mentions: z.array(MentionSchema),
  raw: z.unknown(),
  metadata: EnvelopeMetadataSchema,
});

// Response Action Schemas
export const GeneratedMediaSchema = z.object({
  type: z.enum(['image', 'video', 'sticker']),
  url: z.string(),
  s3Key: z.string().optional(),
  prompt: z.string(),
  model: z.string(),
});

export const SendMessageActionSchema = z.object({
  type: z.literal('send_message'),
  text: z.string(),
  media: z.array(GeneratedMediaSchema).optional(),
  replyToMessageId: z.string().optional(),
});

export const SendMediaActionSchema = z.object({
  type: z.literal('send_media'),
  mediaType: z.enum(['image', 'video', 'animation']),
  url: z.string(),
  caption: z.string().optional(),
  replyToMessageId: z.string().optional(),
});

export const SendVoiceActionSchema = z.object({
  type: z.literal('send_voice'),
  url: z.string(),
  caption: z.string().optional(),
  replyToMessageId: z.string().optional(),
});

export const SendStickerActionSchema = z.object({
  type: z.literal('send_sticker'),
  emoji: z.string(),
  stickerId: z.string().optional(),
});

export const ReactActionSchema = z.object({
  type: z.literal('react'),
  emoji: z.string(),
  messageId: z.string(),
});

export const TakeSelfieActionSchema = z.object({
  type: z.literal('take_selfie'),
  prompt: z.string(),
  style: z.string().optional(),
});

export const GenerateVideoActionSchema = z.object({
  type: z.literal('generate_video'),
  prompt: z.string(),
  duration: z.number().optional(),
});

export const GenerateImageActionSchema = z.object({
  type: z.literal('generate_image'),
  prompt: z.string(),
  aspectRatio: z.string().optional(),
  referenceImageUrls: z.array(z.string()).optional(),
});

export const WaitActionSchema = z.object({
  type: z.literal('wait'),
  durationMs: z.number(),
  reason: z.string().optional(),
});

export const IgnoreActionSchema = z.object({
  type: z.literal('ignore'),
  reason: z.string(),
});

export const SolanaActionSchema = z.object({
  type: z.literal('solana'),
  operation: z.enum(['transfer', 'mint_nft', 'verify_balance', 'airdrop']),
  params: z.record(z.string(), z.unknown()),
});

export const ResponseActionSchema = z.discriminatedUnion('type', [
  SendMessageActionSchema,
  SendMediaActionSchema,
  SendVoiceActionSchema,
  SendStickerActionSchema,
  ReactActionSchema,
  TakeSelfieActionSchema,
  GenerateVideoActionSchema,
  GenerateImageActionSchema,
  WaitActionSchema,
  IgnoreActionSchema,
  SolanaActionSchema,
]);

export const SwarmResponseSchema = z.object({
  avatarId: z.string(),
  platform: PlatformSchema,
  conversationId: z.string(),
  replyToMessageId: z.string().optional(),
  actions: z.array(ResponseActionSchema),
  generatedAt: z.number(),
  llmModel: z.string(),
  tokensUsed: z.number(),
});

// Queue Message Schemas
export const MessageQueueItemSchema = z.object({
  envelope: SwarmEnvelopeSchema,
  enqueuedAt: z.number(),
  attempts: z.number(),
  maxAttempts: z.number(),
});

export const ResponseQueueItemSchema = z.object({
  avatarId: z.string(),
  envelope: SwarmEnvelopeSchema,
  enqueuedAt: z.number(),
  priority: z.enum(['high', 'normal', 'low']),
});

export const MediaQueueItemSchema = z.object({
  avatarId: z.string(),
  conversationId: z.string(),
  action: z.union([TakeSelfieActionSchema, GenerateVideoActionSchema, GenerateImageActionSchema]),
  callbackUrl: z.string().optional(),
  enqueuedAt: z.number(),
});

// State Schemas
export const ChannelStateMachineSchema = z.enum(['IDLE', 'ACTIVE', 'COOLDOWN']);

export const ResponseTriggerSchema = z.enum([
  'direct_engagement',
  'engaged_user',
  'message_threshold',
  'conversation_gap',
  'scheduled',
  'private_chat',
  'none',
]);

export const ResponseDecisionSchema = z.object({
  shouldRespond: z.boolean(),
  trigger: ResponseTriggerSchema,
  delay: z.number(),
  priority: z.enum(['high', 'normal', 'low']),
});

export const ContextMessageSchema = z.object({
  messageId: z.string(),
  sender: z.string(),
  isBot: z.boolean(),
  content: z.string(),
  timestamp: z.number(),
  userId: z.string().optional(),
  username: z.string().optional(),
  isMention: z.boolean().optional(),
  isReplyToBot: z.boolean().optional(),
  replyToMessageId: z.string().optional(),
});

export const ChannelStateSchema = z.object({
  avatarId: z.string(),
  channelId: z.string(),
  platform: PlatformSchema,
  recentMessages: z.array(ContextMessageSchema),
  summary: z.string().optional(),
  summaryUpdatedAt: z.number().optional(),
  lastActivityAt: z.number(),
  messageCount: z.number(),
  state: ChannelStateMachineSchema.optional(),
  stateChangedAt: z.number().optional(),
  chatType: z.enum(['private', 'group', 'supergroup', 'channel']).optional(),
  chatTitle: z.string().optional(),
  lastResponseAt: z.number().optional(),
  lastResponseMessageId: z.string().optional(),
  pendingResponseAt: z.number().optional(),
  directEngagementAt: z.number().optional(),
  engagedUsers: z.record(z.string(), z.number()).optional(),
  ttl: z.number().optional(),
});

export const UserCooldownSchema = z.object({
  avatarId: z.string(),
  platform: PlatformSchema,
  userId: z.string(),
  cooldownUntil: z.number(),
  reason: z.string().optional(),
});

// LLM Schemas
export const LLMMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const LLMResponseSchema = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  model: z.string(),
  tokensUsed: z.number(),
  finishReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'error']),
});

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export const NFTMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  image: z.string(),
  attributes: z.array(z.object({
    trait_type: z.string(),
    value: z.union([z.string(), z.number()]),
  })).optional(),
});

// =============================================================================
// SCHEMA VALIDATION HELPERS
// =============================================================================

/**
 * Parse and validate JSON with a Zod schema, returning a Result type
 */
export function safeParseJson<T>(
  json: string,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: z.ZodError } {
  try {
    const parsed = JSON.parse(json);
    return schema.safeParse(parsed);
  } catch {
    return {
      success: false,
      error: new z.ZodError([{
        code: 'custom',
        message: 'Invalid JSON',
        path: [],
      }]),
    };
  }
}

/**
 * Parse JSON with a Zod schema, throwing on error
 */
export function parseJson<T>(json: string, schema: z.ZodSchema<T>): T {
  const parsed = JSON.parse(json);
  return schema.parse(parsed);
}

// =============================================================================
// SHARED ROOM TYPES (re-exported from shared-room.ts)
// =============================================================================

export type {
  SharedRoomState,
  SharedRoomMessage,
  SharedRoomSenderType,
  AvatarRoomOverlay,
} from './shared-room.js';

// =============================================================================
// CONTINUATION TYPES (re-exported from continuation.ts)
// =============================================================================

export * from './continuation.js';

// =============================================================================
// CONTENT STORE TYPES (re-exported from content-store.ts)
// =============================================================================

export * from './content-store.js';

// =============================================================================
// LONG-FORM CONTENT TYPES (re-exported from long-form.ts)
// =============================================================================

export * from './long-form.js';

// =============================================================================
// TURN ARBITER TYPES (cross-platform turn arbitration)
// =============================================================================

export * from './turn-arbiter.js';

// =============================================================================
// ROOM EVENT TYPES (canonical room-scoped event primitives)
// =============================================================================

export * from './room-event.js';

// =============================================================================
// PROACTIVE PARTICIPATION TYPES
// =============================================================================

export * from './proactive.js';

// =============================================================================
// ADMIN BRIDGE TYPES (shared between admin-api and handlers)
// =============================================================================

export * from './admin-bridge.js';

// =============================================================================
// IDENTITY LINK TYPES
// =============================================================================

// =============================================================================
// RATICROSS PROTOCOL TYPES (inter-agent bridge)
// =============================================================================

export {
  RATICROSS_PROTOCOL_VERSION,
} from './raticross.js';

export type {
  RaticrossActor,
  RaticrossEnvelopeType,
  RaticrossPriority,
  RaticrossEnvelope,
  RaticrossContext,
  RaticrossMeta,
  RaticrossHealthRequest,
  RaticrossHealthResponse,
  RaticrossBridgeConfig,
  RaticrossSendResult,
} from './raticross.js';

// =============================================================================
// IDENTITY LINK TYPES
// =============================================================================

export type {
  IdentityLinkStatus,
  ConsentRevocationResult,
  IdentityLink,
  IdentityLinkAuditAction,
  IdentityLinkAuditEvent,
  IdentityLinkService,
} from './identity-link.js';

// =============================================================================
// CONSTITUTIONAL TYPES (swarm governance layer)
// =============================================================================

export type {
  TransitionKind,
  TransitionStatus,
  TransitionMeta,
  EnvelopeRef,
  StorageMutationMeta,
  TransitionBase,
  TransitionProposal,
  AcceptedTransition,
  TransitionRecord,
  DecisionRecord,
  InvariantCheck,
  InvariantCheckResult,
  PolicyRule,
  PolicyScope,
  PolicyContext,
  PolicyCheckResult,
  TransitionLedger,
  AppendResult,
} from './constitution.js';
