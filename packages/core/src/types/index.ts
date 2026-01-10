/**
 * Core type definitions for the Swarm framework
 */
import { z } from 'zod';

// =============================================================================
// PLATFORM TYPES
// =============================================================================

export type Platform = 'telegram' | 'discord' | 'twitter' | 'web';

export const PlatformSchema = z.enum(['telegram', 'discord', 'twitter', 'web']);

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  version: string;
  persona: string; // Path or content of persona markdown
  
  platforms: PlatformConfigs;
  llm: LLMConfig;
  media: MediaConfig;
  scheduling: SchedulingConfig;
  behavior: BehaviorConfig;
  solana?: SolanaConfig;
  tools: string[];
  secrets: string[];
}

export interface PlatformConfigs {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  twitter?: TwitterConfig;
  web?: WebConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botUsername: string;
  webhookPath: string;
  allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
}

export interface DiscordConfig {
  enabled: boolean;
  applicationId: string;
  publicKey: string;
  useGateway: boolean; // ECS Fargate for persistent connection
}

export interface TwitterConfig {
  enabled: boolean;
  username: string;
  features: ('scheduled_tweets' | 'mention_replies' | 'dm_responses')[];
}

export interface WebConfig {
  enabled: boolean;
  corsOrigins: string[];
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  tokenGated?: {
    enabled: boolean;
    tokenMint: string;
    minBalance: number;
  };
}

export interface LLMConfig {
  provider: 'bedrock' | 'openrouter' | 'anthropic';
  model: string;
  fallbackModel?: string;
  temperature: number;
  maxTokens: number;
}

export interface MediaConfig {
  image: {
    provider: 'openrouter' | 'replicate' | 'dalle';
    model: string;
  };
  video?: {
    provider: 'replicate';
    model: string;
  };
}

export interface SchedulingConfig {
  tweets?: ScheduledTweet[];
  mentionCheck?: {
    cron: string;
  };
  maintenance?: {
    cron: string;
  };
}

export interface ScheduledTweet {
  cron: string;
  template: string;
  enabled: boolean;
}

export interface BehaviorConfig {
  responseDelayMs: [number, number]; // [min, max] random delay
  typingIndicator: boolean;
  ignoreBots: boolean;
  cooldownMinutes: number;
  maxContextMessages: number;
}

export interface SolanaConfig {
  enabled: boolean;
  network: 'mainnet-beta' | 'devnet' | 'testnet';
  rpcUrl: string;
  tokenMint?: string; // Agent's token if applicable
  walletSecretName: string;
  features: SolanaFeature[];
}

export type SolanaFeature = 
  | 'token_gating'
  | 'nft_generation'
  | 'token_transfers'
  | 'balance_queries'
  | 'wallet_verification';

// =============================================================================
// MESSAGE ENVELOPE
// =============================================================================

/**
 * Universal message envelope that normalizes messages across all platforms
 */
export interface SwarmEnvelope {
  // Routing
  agentId: string;
  platform: Platform;
  
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

  // Platform-specific raw update ID (for deduplication)
  platformUpdateId?: string | number;
}

// =============================================================================
// RESPONSE TYPES
// =============================================================================

export interface SwarmResponse {
  agentId: string;
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
  | SendStickerAction
  | ReactAction
  | TakeSelfieAction
  | GenerateVideoAction
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
  agentId: string;
  envelope: SwarmEnvelope;
  enqueuedAt: number;
  priority: 'high' | 'normal' | 'low';
}

export interface MediaQueueItem {
  agentId: string;
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
  agentId: string;
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
  agentId: string;
  platform: Platform;
  userId: string;
  cooldownUntil: number;
  reason?: string;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  agentId: string;
  envelope: SwarmEnvelope;
  services: ServiceContainer;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ServiceContainer {
  state: StateService;
  llm: LLMService;
  media: MediaService;
  secrets: SecretsService;
  solana?: SolanaService;
}

// Service interfaces (implemented in services/)
export interface StateService {
  getChannelState(agentId: string, channelId: string): Promise<ChannelState | null>;
  updateChannelState(state: ChannelState): Promise<void>;
  getUserCooldown(agentId: string, platform: Platform, userId: string): Promise<UserCooldown | null>;
  setUserCooldown(cooldown: UserCooldown): Promise<void>;
}

export interface LLMService {
  generateResponse(params: LLMGenerateParams): Promise<LLMResponse>;
}

export interface LLMGenerateParams {
  agentId: string;
  systemPrompt: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  config: LLMConfig;
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  model: string;
  tokensUsed: number;
  finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface MediaService {
  generateImage(prompt: string, config: MediaConfig['image']): Promise<GeneratedMedia>;
  generateVideo(prompt: string, config: NonNullable<MediaConfig['video']>): Promise<GeneratedMedia>;
  uploadToS3(buffer: Buffer, key: string, contentType: string): Promise<string>;
}

export interface SecretsService {
  getSecret(name: string): Promise<string>;
  getSecretJson<T = Record<string, string>>(name: string): Promise<T>;
}

export interface SolanaService {
  getBalance(walletAddress: string, tokenMint?: string): Promise<number>;
  verifyTokenHolder(walletAddress: string, tokenMint: string, minBalance: number): Promise<boolean>;
  transfer(to: string, amount: number, tokenMint?: string): Promise<string>; // Returns tx signature
  mintNFT(metadata: NFTMetadata, recipient: string): Promise<string>;
}

export interface NFTMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
}
