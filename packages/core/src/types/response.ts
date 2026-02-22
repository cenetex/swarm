/**
 * Response types - actions the avatar can take
 */
import type { Platform } from './platform.js';

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
