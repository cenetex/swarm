/**
 * Media Service Types
 * Interfaces for dependency injection to keep core decoupled from specific implementations
 */

/**
 * AI capabilities that can have configured models
 */
export type AICapability =
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'
  | 'voice_clone'
  | 'text_to_speech'
  | 'transcription'
  | 'llm';

/**
 * Default models by capability
 */
export const DEFAULT_MODELS: Record<AICapability, string> = {
  image_generation: 'black-forest-labs/flux-1.1-pro',
  video_generation: 'minimax/video-01',
  audio_generation: 'stability-ai/stable-audio-2.5',
  // F5-TTS is a material quality upgrade over XTTS-v2 (Coqui is defunct).
  // Override via VOICE_TTS_MODEL env var if you need the legacy model back.
  voice_clone: 'x-lance/f5-tts',
  text_to_speech: 'x-lance/f5-tts',
  transcription: 'whisper-1',
  llm: 'anthropic/claude-3-5-sonnet-latest',
};

/**
 * Result of model resolution
 */
export interface ResolvedModel {
  model: string;
  provider: 'replicate' | 'openai' | 'openrouter' | 'anthropic';
  version?: string;
}

/**
 * Result of API key resolution
 * Note: For trial source, trialCreditsAvailable shows credits BEFORE consumption.
 * The caller must call consumeTrialCredit after successful operation.
 */
export interface ResolvedApiKey {
  key: string;
  source: 'avatar' | 'system' | 'trial';
  /** Credits available (before consumption). Only present for trial source. */
  trialCreditsAvailable?: number;
}

/**
 * Gallery item to save
 */
export interface GalleryItemInput {
  id: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  s3Key: string;
  prompt: string;
  model: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Saved gallery item
 */
export interface GalleryItemOutput extends GalleryItemInput {
  avatarId: string;
  createdAt: number;
}

/**
 * Credit check result
 */
export interface CreditCheckResult {
  allowed: boolean;
  reason?: string;
  remaining?: number;
}

/**
 * Optional services that can be injected into MediaService for enhanced functionality
 */
export interface MediaServiceDependencies {
  /**
   * Resolve the model for a capability from avatar config
   * If not provided, uses config passed to generateImage()
   */
  resolveModel?: (avatarId: string, capability: AICapability) => Promise<ResolvedModel>;

  /**
   * Resolve API key with fallback chain (avatar -> system -> trial)
   * If not provided, uses secrets passed to constructor
   */
  resolveApiKey?: (avatarId: string, provider: string) => Promise<ResolvedApiKey>;

  /**
   * Check if avatar has credits for operation
   * If not provided, always allows
   */
  checkCredits?: (avatarId: string, operation: string) => Promise<CreditCheckResult>;

  /**
   * Consume credits after successful operation (rate limiting)
   * If not provided, no-op
   */
  consumeCredits?: (avatarId: string, operation: string) => Promise<void>;

  /**
   * Consume a trial credit after successful operation
   * Only called when resolveApiKey returned source='trial'
   * If not provided, no-op
   */
  consumeTrialCredit?: (avatarId: string) => Promise<{ remaining: number }>;

  /**
   * Save generated media to gallery
   * If not provided, no gallery integration
   */
  saveToGallery?: (avatarId: string, item: GalleryItemInput) => Promise<GalleryItemOutput>;

  /**
   * Validate and clean Replicate input parameters against the model's schema.
   * Strips unsupported params, corrects invalid enum values.
   * If not provided, input is sent as-is (backward compat).
   */
  validateReplicateInput?: (
    modelId: string,
    input: Record<string, unknown>,
    apiKey: string,
  ) => Promise<{ cleanedInput: Record<string, unknown>; adjustments: string[] }>;
}

/**
 * Extended options for image generation
 */
export interface GenerateImageOptions {
  avatarId?: string;
  platform?: string;
  aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9';
  resolution?: '1K' | '2K' | '4K';
  referenceImageUrls?: string[];
  saveToGallery?: boolean;
  checkCredits?: boolean;
}
