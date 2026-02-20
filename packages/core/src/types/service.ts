/**
 * Service interfaces - tool definitions, service container, LLM, media, secrets, solana
 */
import type { z } from 'zod';
import type { Platform } from './platform.js';
import type { LLMConfig, MediaConfig } from './platform.js';
import type { SwarmEnvelope } from './envelope.js';
import type { GeneratedMedia } from './response.js';
import type { ChannelState, UserCooldown } from './state.js';

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
  avatarId: string;
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
  usage: UsageMeteringService;
  secrets: SecretsService;
  solana?: SolanaService;
}

// =============================================================================
// USAGE METERING TYPES
// =============================================================================

export interface UsageCredit {
  credits: number;
  lastRecharge: number;
}

export interface UsageConfig {
  maxCredits: number;
  rechargeAmount: number;
  rechargeIntervalMs: number;
}

export interface UsageMeteringService {
  canUseTool(avatarId: string, toolId: string, config: UsageConfig): Promise<boolean>;
  consumeCredit(avatarId: string, toolId: string, config: UsageConfig): Promise<{ allowed: boolean; remaining: number }>;
  getCredits(avatarId: string, toolId: string, config: UsageConfig): Promise<UsageCredit>;
}

// Service interfaces (implemented in services/)
export interface StateService {
  getChannelState(avatarId: string, channelId: string): Promise<ChannelState | null>;
  updateChannelState(state: ChannelState): Promise<void>;
  getUserCooldown(avatarId: string, platform: Platform, userId: string): Promise<UserCooldown | null>;
  setUserCooldown(cooldown: UserCooldown): Promise<void>;

  // Memory/facts storage
  saveFact(avatarId: string, fact: MemoryFact): Promise<void>;
  getFacts(avatarId: string, query: string, userId?: string): Promise<MemoryFact[]>;

  // Twitter reply deduplication
  checkAndSetTweetReply?(avatarId: string, tweetId: string): Promise<boolean>;
  hasRepliedToTweet?(avatarId: string, tweetId: string): Promise<boolean>;

  // Platform heartbeat timing
  getLastHeartbeat(avatarId: string, platform: string): Promise<number>;
  setLastHeartbeat(avatarId: string, platform: string, timestamp: number): Promise<void>;
}

/**
 * A fact stored in avatar memory
 */
export interface MemoryFact {
  fact: string;
  about?: string;
  userId?: string;
  timestamp: number;
}

export interface LLMService {
  generateResponse(params: LLMGenerateParams): Promise<LLMResponse>;
}

export interface LLMGenerateParams {
  avatarId: string;
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

export interface MediaServiceGenerateOptions {
  avatarId?: string;
  platform?: string;
  aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9';
  saveToGallery?: boolean;
  checkCredits?: boolean;
  referenceImageUrls?: string[];
}

export interface MediaService {
  generateImage(prompt: string, config: MediaConfig['image'], options?: MediaServiceGenerateOptions): Promise<GeneratedMedia>;
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
