/**
 * Models Registry & Resolution
 *
 * Catalog of available AI models and fallback chains,
 * plus model selection logic with automatic fallback on errors.
 */
import { logger } from '@swarm/core';
import type { AICapability } from '../types.js';

/**
 * Information about an AI model
 */
export interface ModelInfo {
  id: string;                      // Model identifier (e.g., 'google/nano-banana-pro')
  name: string;                    // Display name
  provider: 'replicate' | 'openai' | 'anthropic' | 'openrouter';
  capabilities: AICapability[];   // What this model can do
  description: string;
  version?: string;               // For Replicate: model version hash
  tier: 'free' | 'standard' | 'premium';
  speed: 'fast' | 'medium' | 'slow';
  quality: 'draft' | 'standard' | 'high';
  isDefault?: boolean;            // Whether this is the default for its capability
}

/**
 * Replicate model versions (required for predictions API)
 * Models using the /models/{owner}/{name}/predictions endpoint don't need versions
 */
export const REPLICATE_MODEL_VERSIONS: Record<string, string | undefined> = {
  // All featured image models use the model endpoint to avoid stale version hashes
  'black-forest-labs/flux-1.1-pro': undefined,
  'black-forest-labs/flux-schnell': undefined,
  'stability-ai/sdxl': undefined,
  'ideogram-ai/ideogram-v2': undefined,
  'recraft-ai/recraft-v3': undefined,
  // Video, audio, and voice models
  'minimax/video-01': undefined,
  'stability-ai/stable-audio-2.5': undefined,
  'lucataco/xtts-v2': undefined,
};

/**
 * Available models registry
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  // ==========================================================================
  // IMAGE GENERATION
  // ==========================================================================
  {
    id: 'black-forest-labs/flux-1.1-pro',
    name: 'FLUX 1.1 Pro',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Best quality, fast image generation. Latest FLUX model with superior detail.',
    version: REPLICATE_MODEL_VERSIONS['black-forest-labs/flux-1.1-pro'],
    tier: 'premium',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'black-forest-labs/flux-schnell',
    name: 'FLUX Schnell',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Fastest image generation with good quality. Ideal for quick iterations.',
    version: REPLICATE_MODEL_VERSIONS['black-forest-labs/flux-schnell'],
    tier: 'standard',
    speed: 'fast',
    quality: 'standard',
  },
  {
    id: 'stability-ai/sdxl',
    name: 'Stable Diffusion XL',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Widely-used stable diffusion model. Reliable and versatile.',
    version: REPLICATE_MODEL_VERSIONS['stability-ai/sdxl'],
    tier: 'standard',
    speed: 'medium',
    quality: 'standard',
  },
  {
    id: 'ideogram-ai/ideogram-v2',
    name: 'Ideogram v2',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Excellent for text rendering in images and design-focused prompts.',
    version: REPLICATE_MODEL_VERSIONS['ideogram-ai/ideogram-v2'],
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
  },
  {
    id: 'recraft-ai/recraft-v3',
    name: 'Recraft v3',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Specialized for vector, design, and illustration styles.',
    version: REPLICATE_MODEL_VERSIONS['recraft-ai/recraft-v3'],
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
  },

  // ==========================================================================
  // VIDEO GENERATION
  // ==========================================================================
  {
    id: 'minimax/video-01',
    name: 'Minimax Video',
    provider: 'replicate',
    capabilities: ['video_generation'],
    description: 'Text-to-video and image-to-video generation. Creates short video clips.',
    tier: 'premium',
    speed: 'slow',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'luma/ray',
    name: 'Luma Ray',
    provider: 'replicate',
    capabilities: ['video_generation'],
    description: 'High-quality video generation with good motion.',
    tier: 'premium',
    speed: 'slow',
    quality: 'high',
  },

  // ==========================================================================
  // AUDIO GENERATION
  // ==========================================================================
  {
    id: 'stability-ai/stable-audio-2.5',
    name: 'Stable Audio 2.5',
    provider: 'replicate',
    capabilities: ['audio_generation'],
    description: 'Generate music, sound effects, and abstract audio from text prompts.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },

  // ==========================================================================
  // VOICE CLONE / TTS
  // ==========================================================================
  {
    id: 'lucataco/xtts-v2',
    name: 'XTTS v2',
    provider: 'replicate',
    capabilities: ['voice_clone', 'text_to_speech'],
    description: 'Voice cloning and text-to-speech from a reference audio sample.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'gpt-4o-mini-tts',
    name: 'GPT-4o Mini TTS',
    provider: 'openai',
    capabilities: ['text_to_speech'],
    description: 'OpenAI text-to-speech with multiple voice options.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },

  // ==========================================================================
  // TRANSCRIPTION
  // ==========================================================================
  {
    id: 'whisper-1',
    name: 'Whisper',
    provider: 'openai',
    capabilities: ['transcription'],
    description: 'Speech-to-text transcription with high accuracy.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'openai/whisper',
    name: 'Whisper (Replicate)',
    provider: 'replicate',
    capabilities: ['transcription'],
    description: 'Whisper model running on Replicate infrastructure.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
  },

  // ==========================================================================
  // LLM (for reference, typically configured separately)
  // ==========================================================================
  {
    id: 'anthropic/claude-3-5-sonnet-latest',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    capabilities: ['llm'],
    description: 'Fast, intelligent model for most tasks.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'anthropic/claude-3-opus-latest',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    capabilities: ['llm'],
    description: 'Most capable model for complex reasoning.',
    tier: 'premium',
    speed: 'medium',
    quality: 'high',
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['llm'],
    description: 'OpenAI multimodal model.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
];

/**
 * Get models for a specific capability
 */
export function getModelsForCapability(
  capability: AICapability,
  provider?: string
): ModelInfo[] {
  return AVAILABLE_MODELS.filter(
    (model) =>
      model.capabilities.includes(capability) &&
      (!provider || model.provider === provider)
  );
}

/**
 * Get the default model for a capability
 */
export function getDefaultModel(
  capability: AICapability,
  provider?: string
): ModelInfo | undefined {
  const models = getModelsForCapability(capability, provider);
  return models.find((m) => m.isDefault) || models[0];
}

/**
 * Get model by ID
 */
export function getModelById(id: string): ModelInfo | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

export function getValidModelId(value: unknown): string | undefined {
  const normalized = normalizeModel(value);
  if (!normalized) return undefined;
  if (getModelById(normalized)) return normalized;
  logger.warn('Unknown LLM model configured, falling back to default', { model: normalized });
  return undefined;
}

/**
 * Get all models for a provider
 */
export function getModelsForProvider(provider: string): ModelInfo[] {
  return AVAILABLE_MODELS.filter((m) => m.provider === provider);
}

/**
 * Get the Replicate version hash for a model (if applicable)
 */
export function getReplicateVersion(modelId: string): string | undefined {
  return REPLICATE_MODEL_VERSIONS[modelId];
}

/**
 * Default model IDs by capability
 */
export const DEFAULT_MODELS: Record<AICapability, string> = {
  image_generation: 'black-forest-labs/flux-1.1-pro',
  video_generation: 'minimax/video-01',
  audio_generation: 'stability-ai/stable-audio-2.5',
  voice_clone: 'lucataco/xtts-v2',
  text_to_speech: 'lucataco/xtts-v2',
  transcription: 'whisper-1',
  llm: 'anthropic/claude-3-5-sonnet-latest',
};

// ============================================================================
// MODEL FALLBACK SYSTEM
// ============================================================================

/**
 * Fallback chains for LLM models.
 * When a model fails, try the next model in the chain.
 * Models are tried in order until one succeeds.
 *
 * Strategy:
 * - Premium models fall back to fast/cheap models
 * - Same-provider fallbacks preferred (API key reuse)
 * - DeepSeek as universal cheap fallback
 *
 * @see https://openrouter.ai/models for current model availability
 */
export const LLM_FALLBACK_CHAINS: Record<string, string[]> = {
  // -------------------------------------------------------------------------
  // Claude 4.x models (2026)
  // -------------------------------------------------------------------------
  'anthropic/claude-sonnet-4.5': ['anthropic/claude-sonnet-4', 'deepseek/deepseek-r1'],
  'anthropic/claude-sonnet-4': ['anthropic/claude-3-5-sonnet-latest', 'deepseek/deepseek-r1'],
  'anthropic/claude-opus-4.5': ['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4'],

  // -------------------------------------------------------------------------
  // Claude 3.x models (legacy but still used)
  // -------------------------------------------------------------------------
  'anthropic/claude-3-5-sonnet-latest': ['anthropic/claude-3-5-haiku-latest', 'deepseek/deepseek-r1'],
  'anthropic/claude-3-opus-latest': ['anthropic/claude-3-5-sonnet-latest', 'anthropic/claude-sonnet-4'],
  'anthropic/claude-3-5-haiku-latest': ['deepseek/deepseek-r1', 'openai/gpt-4o-mini'],
  'anthropic/claude-haiku-4': ['anthropic/claude-3-5-haiku-latest', 'deepseek/deepseek-r1'],

  // -------------------------------------------------------------------------
  // OpenAI models
  // -------------------------------------------------------------------------
  'openai/gpt-5.1': ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
  'openai/gpt-4o': ['openai/gpt-4o-mini', 'deepseek/deepseek-r1'],
  'openai/gpt-4o-mini': ['deepseek/deepseek-r1', 'anthropic/claude-3-5-haiku-latest'],
  'openai/gpt-4-turbo': ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],

  // -------------------------------------------------------------------------
  // DeepSeek models (cheap, fast, good fallback)
  // -------------------------------------------------------------------------
  'deepseek/deepseek-r1': ['deepseek/deepseek-v3.2', 'anthropic/claude-3-5-haiku-latest'],
  'deepseek/deepseek-v3.2': ['deepseek/deepseek-r1', 'openai/gpt-4o-mini'],

  // -------------------------------------------------------------------------
  // Other models that may have availability issues
  // -------------------------------------------------------------------------
  'minimax/minimax-01': ['anthropic/claude-3-5-haiku-latest', 'deepseek/deepseek-r1'],
  'minimax/minimax-m2-her': ['anthropic/claude-3-5-haiku-latest', 'deepseek/deepseek-r1'],
  'x-ai/grok-4': ['anthropic/claude-sonnet-4', 'deepseek/deepseek-r1'],
  'google/gemini-3-pro-preview': ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
};

/** Default fallback chain when model not in registry */
export const DEFAULT_FALLBACK_CHAIN: string[] = [
  'deepseek/deepseek-r1',        // Fast, cheap, reliable
  'anthropic/claude-3-5-haiku-latest',  // Claude fallback
];

/**
 * Get fallback models for a given primary model
 */
export function getFallbackModels(primaryModel: string): string[] {
  return LLM_FALLBACK_CHAINS[primaryModel] ?? DEFAULT_FALLBACK_CHAIN;
}

/**
 * Errors that should trigger a model fallback
 */
export function isFallbackTriggerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();

  // Rate limiting
  if (msg.includes('429') || msg.includes('rate limit')) return true;

  // Model unavailable
  if (msg.includes('model not found') || msg.includes('model_not_found')) return true;
  if (msg.includes('no endpoints found')) return true;
  if (msg.includes('does not support')) return true;

  // Service unavailable
  if (msg.includes('503') || msg.includes('service unavailable')) return true;
  if (msg.includes('502') || msg.includes('bad gateway')) return true;

  // Timeout (might be overloaded)
  if (msg.includes('timeout') || msg.includes('timed out')) return true;

  // Capacity issues
  if (msg.includes('overloaded') || msg.includes('capacity')) return true;

  return false;
}

/**
 * Get the complete model chain (primary + fallbacks) for resolution
 */
export function getModelChain(primaryModel: string): string[] {
  return [primaryModel, ...getFallbackModels(primaryModel)];
}

// ============================================================================
// MODEL ALIASES (stale → current ID mapping)
// ============================================================================

/**
 * Maps stale or shorthand model IDs to their current canonical IDs.
 * Applied during normalizeModel() so stored config values resolve without
 * triggering "Unknown LLM model" warnings.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude 3.x shorthand (missing -latest suffix)
  'anthropic/claude-3-5-sonnet': 'anthropic/claude-3-5-sonnet-latest',
  'anthropic/claude-3-opus': 'anthropic/claude-3-opus-latest',
  // Claude 3.x dated snapshots → latest
  'anthropic/claude-3-5-sonnet-20241022': 'anthropic/claude-3-5-sonnet-latest',
  'anthropic/claude-3-5-sonnet-20240620': 'anthropic/claude-3-5-sonnet-latest',
  'anthropic/claude-3-opus-20240229': 'anthropic/claude-3-opus-latest',
};

// ============================================================================
// MODEL RESOLUTION
// ============================================================================

export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

export function resolveChatModel(params: {
  requestModel: unknown;
  avatarModel: unknown;
  defaultModel: string;
}): string {
  return (
    getValidModelId(params.requestModel) ??
    getValidModelId(params.avatarModel) ??
    params.defaultModel
  );
}

// ============================================================================
// FALLBACK EXECUTION
// ============================================================================

export interface ModelExecutionResult<T> {
  result: T;
  model: string;
  attemptedModels: string[];
  usedFallback: boolean;
}

export interface ModelExecutionOptions {
  /** Primary model to use */
  primaryModel: string;
  /** Avatar ID for logging */
  avatarId?: string;
  /** Maximum number of fallback attempts (default: 2) */
  maxFallbackAttempts?: number;
}

/**
 * Execute an LLM operation with automatic fallback on errors.
 */
export async function executeWithFallback<T>(
  execute: (model: string) => Promise<T>,
  options: ModelExecutionOptions
): Promise<ModelExecutionResult<T>> {
  const {
    primaryModel,
    avatarId = 'unknown',
    maxFallbackAttempts = 2,
  } = options;

  const modelChain = getModelChain(primaryModel);
  const modelsToTry = modelChain.slice(0, 1 + maxFallbackAttempts);
  const attemptedModels: string[] = [];
  let lastError: Error | undefined;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    attemptedModels.push(model);

    try {
      const result = await execute(model);

      if (i > 0) {
        logger.info('LLM fallback succeeded', {
          event: 'llm_fallback_success',
          avatarId,
          primaryModel,
          fallbackModel: model,
          attemptNumber: i + 1,
          attemptedModels,
        });
      }

      return {
        result,
        model,
        attemptedModels,
        usedFallback: i > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isFallbackTriggerError(error)) {
        logger.warn('LLM error (not retrying with fallback)', {
          event: 'llm_error_no_fallback',
          avatarId,
          model,
          error: lastError.message,
        });
        throw error;
      }

      logger.warn('LLM error triggering fallback', {
        event: 'llm_fallback_triggered',
        avatarId,
        failedModel: model,
        error: lastError.message,
        nextModel: modelsToTry[i + 1] ?? 'none',
        attemptNumber: i + 1,
      });
    }
  }

  logger.error('All LLM fallback models exhausted', {
    event: 'llm_fallback_exhausted',
    avatarId,
    primaryModel,
    attemptedModels,
    lastError: lastError?.message,
  });

  throw lastError ?? new Error('All fallback models failed');
}

/**
 * Get info about the fallback chain for a model (for UI display)
 */
export function getFallbackInfo(model: string): {
  primary: string;
  fallbacks: string[];
  totalOptions: number;
} {
  const fallbacks = getFallbackModels(model);
  return {
    primary: model,
    fallbacks,
    totalOptions: 1 + fallbacks.length,
  };
}
