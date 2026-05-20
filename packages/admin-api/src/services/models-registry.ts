/**
 * Models Registry & Resolution
 *
 * Catalog of available AI models and fallback chains,
 * plus model selection logic with automatic fallback on errors.
 */
import { isUsableOpenRouterModelId, logger } from '@swarm/core';
import type { AICapability } from '../types.js';

/**
 * Information about an AI model
 */
export interface ModelInfo {
  id: string;                      // Model identifier
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
  'x-lance/f5-tts': undefined,
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
    id: 'x-lance/f5-tts',
    name: 'F5-TTS',
    provider: 'replicate',
    capabilities: ['voice_clone', 'text_to_speech'],
    description: 'SOTA open-source voice cloning. Better quality than XTTS-v2; drop-in replacement.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'lucataco/xtts-v2',
    name: 'XTTS v2 (legacy)',
    provider: 'replicate',
    capabilities: ['voice_clone', 'text_to_speech'],
    description: 'Legacy Coqui TTS clone model. Kept for rollback; prefer F5-TTS for new avatars.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
    isDefault: false,
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

  // LLM models are intentionally not curated here. Runtime chat paths resolve
  // them from OpenRouter's live /models catalog before sending a request.
];

export function isRetiredReplicateMediaModel(model: Pick<ModelInfo, 'provider' | 'capabilities'>): boolean {
  return model.provider === 'replicate' && (
    model.capabilities.includes('image_generation') ||
    model.capabilities.includes('video_generation')
  );
}

/**
 * Get models for a specific capability
 */
export function getModelsForCapability(
  capability: AICapability,
  provider?: string
): ModelInfo[] {
  return AVAILABLE_MODELS.filter(
    (model) =>
      !isRetiredReplicateMediaModel(model) &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OPENROUTER_CATALOG_PROVIDER_PREFIXES = new Set([
  'anthropic',
  'deepseek',
  'google',
  'meta-llama',
  'mistralai',
  'moonshotai',
  'openai',
  'openrouter',
  'qwen',
  'x-ai',
  'z-ai',
]);

function isKnownFallbackModel(id: string): boolean {
  if (id in LLM_FALLBACK_CHAINS) return true;
  if (DEFAULT_FALLBACK_CHAIN.includes(id)) return true;
  return Object.values(LLM_FALLBACK_CHAINS).some((fallbacks) => fallbacks.includes(id));
}

/**
 * Accepts catalog-shaped OpenRouter model IDs that are not curated in the
 * local registry yet. Runtime OpenRouter fallback routing handles stale or
 * unavailable IDs instead of silently replacing valid catalog choices.
 */
export function isOpenRouterCatalogModelId(value: string): boolean {
  if (!isUsableOpenRouterModelId(value)) return false;
  const [provider] = value.split('/');
  if (!provider) return false;
  return OPENROUTER_CATALOG_PROVIDER_PREFIXES.has(provider);
}

export function getValidModelId(value: unknown): string | undefined {
  const normalized = normalizeModel(value);
  if (!normalized) return undefined;
  if (getModelById(normalized)) return normalized;
  if (isKnownFallbackModel(normalized)) return normalized;
  if (isOpenRouterCatalogModelId(normalized)) {
    logger.info('Using OpenRouter catalog model outside local registry', { model: normalized });
    return normalized;
  }
  logger.warn('Unknown LLM model configured, falling back to default', { model: normalized });
  return undefined;
}

/**
 * Get all models for a provider
 */
export function getModelsForProvider(provider: string): ModelInfo[] {
  return AVAILABLE_MODELS.filter((m) => m.provider === provider && !isRetiredReplicateMediaModel(m));
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
  image_generation: '',
  video_generation: '',
  audio_generation: 'stability-ai/stable-audio-2.5',
  voice_clone: 'x-lance/f5-tts',
  text_to_speech: 'x-lance/f5-tts',
  transcription: 'whisper-1',
  llm: '',
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
export const LLM_FALLBACK_CHAINS: Record<string, string[]> = {};

/** Runtime fallback chains come from OpenRouter's live catalog. */
export const DEFAULT_FALLBACK_CHAIN: string[] = [];

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
  if (msg.includes('not found') || msg.includes('unknown model')) return true;
  if (msg.includes('invalid model') || msg.includes('unsupported model')) return true;
  if (msg.includes('no endpoints found')) return true;
  if (msg.includes('does not support')) return true;

  // Service unavailable
  if (msg.includes('500') || msg.includes('504')) return true;
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
  return Array.from(new Set([primaryModel, ...getFallbackModels(primaryModel)]));
}

export interface OpenRouterFallbackRoutingOptions {
  /** Require providers to support every parameter in the request, e.g. tools. */
  requireParameters?: boolean;
  /** Live OpenRouter catalog fallback models. */
  fallbackModels?: string[];
}

export function withOpenRouterFallbackRouting(
  body: Record<string, unknown>,
  primaryModel: string,
  options: OpenRouterFallbackRoutingOptions = {}
): Record<string, unknown> {
  const modelChain = Array.from(new Set([primaryModel, ...(options.fallbackModels ?? getFallbackModels(primaryModel))]));
  const provider = isRecord(body.provider) ? { ...body.provider } : {};

  return {
    ...body,
    model: primaryModel,
    ...(modelChain.length > 1 ? { models: modelChain, route: 'fallback' } : {}),
    provider: {
      ...provider,
      allow_fallbacks: true,
      ...(options.requireParameters ? { require_parameters: true } : {}),
    },
  };
}

// ============================================================================
// MODEL ALIASES (stale → current ID mapping)
// ============================================================================

/**
 * Maps stale or shorthand model IDs to their current canonical IDs.
 * Applied during normalizeModel() so stored config values resolve without
 * triggering "Unknown LLM model" warnings.
 */
export const MODEL_ALIASES: Record<string, string> = {};

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
    getValidModelId(params.defaultModel) ??
    DEFAULT_MODELS.llm
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
  /** Live OpenRouter catalog fallback models. */
  fallbackModels?: string[];
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
    fallbackModels,
  } = options;

  const modelChain = Array.from(new Set([primaryModel, ...(fallbackModels ?? getFallbackModels(primaryModel))]));
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
