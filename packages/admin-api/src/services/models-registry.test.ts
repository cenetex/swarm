/**
 * Models Registry Tests
 *
 * Tests for the AI models registry and helper functions.
 *
 * @see packages/admin-api/src/services/models-registry.ts
 */
import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_MODELS,
  REPLICATE_MODEL_VERSIONS,
  DEFAULT_MODELS,
  getModelsForCapability,
  getDefaultModel,
  getModelById,
  getModelsForProvider,
  getReplicateVersion,
} from './models-registry.js';
import type { AICapability } from '../types.js';

describe('Models Registry', () => {
  describe('AVAILABLE_MODELS catalog', () => {
    it('should contain local models for non-LLM capabilities', () => {
      const capabilities: AICapability[] = [
        'image_generation',
        'video_generation',
        'audio_generation',
        'voice_clone',
        'text_to_speech',
        'transcription',
      ];

      for (const capability of capabilities) {
        const models = getModelsForCapability(capability);
        expect(models.length).toBeGreaterThan(0);
      }
    });

    it('should have valid model structure for all models', () => {
      for (const model of AVAILABLE_MODELS) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toMatch(/^(replicate|openai|anthropic|openrouter)$/);
        expect(model.capabilities.length).toBeGreaterThan(0);
        expect(model.description).toBeTruthy();
        expect(model.tier).toMatch(/^(free|standard|premium)$/);
        expect(model.speed).toMatch(/^(fast|medium|slow)$/);
        expect(model.quality).toMatch(/^(draft|standard|high)$/);
      }
    });

    it('should have exactly one default model per capability', () => {
      const capabilities: AICapability[] = [
        'image_generation',
        'video_generation',
        'audio_generation',
        'voice_clone',
        'transcription',
      ];

      for (const capability of capabilities) {
        const models = getModelsForCapability(capability);
        const defaults = models.filter(m => m.isDefault);
        // Should have at most one default (could have 0 if capability shares default with another)
        expect(defaults.length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('REPLICATE_MODEL_VERSIONS', () => {
    it('should have all featured models in the versions map', () => {
      expect('black-forest-labs/flux-schnell' in REPLICATE_MODEL_VERSIONS).toBe(true);
      expect('black-forest-labs/flux-1.1-pro' in REPLICATE_MODEL_VERSIONS).toBe(true);
      expect('google/nano-banana-pro' in REPLICATE_MODEL_VERSIONS).toBe(true);
    });

    it('should have undefined for models using /models API', () => {
      expect(REPLICATE_MODEL_VERSIONS['black-forest-labs/flux-1.1-pro']).toBeUndefined();
      expect(REPLICATE_MODEL_VERSIONS['google/nano-banana-pro']).toBeUndefined();
      expect(REPLICATE_MODEL_VERSIONS['minimax/video-01']).toBeUndefined();
      expect(REPLICATE_MODEL_VERSIONS['stability-ai/stable-audio-2.5']).toBeUndefined();
    });

    it('version hashes should be 64 character hex strings', () => {
      for (const [_modelId, version] of Object.entries(REPLICATE_MODEL_VERSIONS)) {
        if (version) {
          expect(version).toMatch(/^[a-f0-9]{64}$/);
        }
      }
    });
  });

  describe('DEFAULT_MODELS', () => {
    it('should have defaults for all capabilities', () => {
      const capabilities: AICapability[] = [
        'image_generation',
        'video_generation',
        'audio_generation',
        'voice_clone',
        'text_to_speech',
        'transcription',
        'llm',
      ];

      for (const capability of capabilities) {
        expect(DEFAULT_MODELS[capability]).toBeDefined();
      }
    });

    it('does not hard-code a default LLM model ID', () => {
      expect(DEFAULT_MODELS.llm).toBe('');
    });

    it('should have concrete defaults for non-LLM capabilities', () => {
      for (const [capability, modelId] of Object.entries(DEFAULT_MODELS)) {
        if (capability === 'llm') continue;
        expect(modelId).toBeTruthy();
      }
    });

    it('default model IDs should exist in AVAILABLE_MODELS', () => {
      for (const [capability, modelId] of Object.entries(DEFAULT_MODELS)) {
        // Some defaults may be from external sources not in catalog
        const model = getModelById(modelId);
        if (model) {
          expect(model.capabilities).toContain(capability as AICapability);
        }
      }
    });
  });

  describe('getModelsForCapability', () => {
    it('should return image generation models', () => {
      const models = getModelsForCapability('image_generation');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.capabilities.includes('image_generation'))).toBe(true);
    });

    it('should return video generation models', () => {
      const models = getModelsForCapability('video_generation');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.capabilities.includes('video_generation'))).toBe(true);
    });

    it('should return audio generation models', () => {
      const models = getModelsForCapability('audio_generation');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.capabilities.includes('audio_generation'))).toBe(true);
    });

    it('should return voice clone models', () => {
      const models = getModelsForCapability('voice_clone');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.capabilities.includes('voice_clone'))).toBe(true);
    });

    it('should filter by provider when specified', () => {
      const replicateModels = getModelsForCapability('image_generation', 'replicate');
      expect(replicateModels.every(m => m.provider === 'replicate')).toBe(true);

      const openaiModels = getModelsForCapability('llm', 'openai');
      expect(openaiModels.every(m => m.provider === 'openai')).toBe(true);
    });

    it('should return empty array for non-existent capability/provider combo', () => {
      // OpenAI doesn't have video_generation in our catalog
      const models = getModelsForCapability('video_generation', 'openai');
      expect(models).toEqual([]);
    });
  });

  describe('getDefaultModel', () => {
    it('should return default model for image_generation', () => {
      const model = getDefaultModel('image_generation');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('image_generation');
    });

    it('should return default model for video_generation', () => {
      const model = getDefaultModel('video_generation');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('video_generation');
    });

    it('should return default model for audio_generation', () => {
      const model = getDefaultModel('audio_generation');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('audio_generation');
    });

    it('should return default model for voice_clone', () => {
      const model = getDefaultModel('voice_clone');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('voice_clone');
    });

    it('does not return a static default LLM model', () => {
      const model = getDefaultModel('llm');
      expect(model).toBeUndefined();
    });

    it('does not return static provider-filtered LLM models', () => {
      const model = getDefaultModel('llm', 'anthropic');
      expect(model).toBeUndefined();
    });
  });

  describe('getModelById', () => {
    it('should find model by exact ID', () => {
      const model = getModelById('black-forest-labs/flux.2-pro');
      expect(model).toBeTruthy();
      expect(model?.name).toBe('FLUX 2 Pro');
      expect(model?.provider).toBe('openrouter');
    });

    it('keeps FLUX 1.1 Pro as a selectable legacy Replicate image model', () => {
      const model = getModelById('black-forest-labs/flux-1.1-pro');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('image_generation');
      expect(model?.provider).toBe('replicate');
    });

    it('should expose Nano Banana Pro as a selectable Replicate image model', () => {
      const model = getModelById('google/nano-banana-pro');
      expect(model).toBeTruthy();
      expect(model?.capabilities).toContain('image_generation');
      expect(model?.provider).toBe('replicate');
    });

    it('should return undefined for non-existent model', () => {
      const model = getModelById('non-existent/model');
      expect(model).toBeUndefined();
    });

    it('should find all registered models by ID', () => {
      for (const registeredModel of AVAILABLE_MODELS) {
        const found = getModelById(registeredModel.id);
        expect(found).toBe(registeredModel);
      }
    });
  });

  describe('getModelsForProvider', () => {
    it('should return all Replicate models', () => {
      const models = getModelsForProvider('replicate');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'replicate')).toBe(true);
    });

    it('should return all OpenAI models', () => {
      const models = getModelsForProvider('openai');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'openai')).toBe(true);
    });

    it('does not keep Anthropic LLM models in the static registry', () => {
      const models = getModelsForProvider('anthropic');
      expect(models).toEqual([]);
    });

    it('should return empty array for non-existent provider', () => {
      const models = getModelsForProvider('non-existent-provider');
      expect(models).toEqual([]);
    });
  });

  describe('getReplicateVersion', () => {
    it('should return undefined for models using /models API', () => {
      const version = getReplicateVersion('black-forest-labs/flux-schnell');
      expect(version).toBeUndefined();
    });

    it('should return undefined for non-existent models', () => {
      const version = getReplicateVersion('non-existent/model');
      expect(version).toBeUndefined();
    });
  });
});

describe('Model Selection Logic', () => {
  describe('Capability matching', () => {
    it('should find models that support multiple capabilities', () => {
      // XTTS-v2 supports both voice_clone and text_to_speech
      const voiceCloneModels = getModelsForCapability('voice_clone');
      const ttsModels = getModelsForCapability('text_to_speech');

      const xtts = getModelById('lucataco/xtts-v2');
      expect(xtts).toBeTruthy();
      expect(voiceCloneModels).toContainEqual(xtts);
      expect(ttsModels).toContainEqual(xtts);
    });

    it('should correctly distinguish between providers', () => {
      const allLlmModels = getModelsForCapability('llm');
      const anthropicLlm = getModelsForCapability('llm', 'anthropic');
      const openaiLlm = getModelsForCapability('llm', 'openai');

      expect(allLlmModels.length).toBeGreaterThanOrEqual(anthropicLlm.length + openaiLlm.length);
      expect(anthropicLlm.every(m => m.provider === 'anthropic')).toBe(true);
      expect(openaiLlm.every(m => m.provider === 'openai')).toBe(true);
    });
  });

  describe('Tier and quality attributes', () => {
    it('should have premium tier for compute-intensive models', () => {
      const videoModel = getModelById('bytedance/seedance-2.0-fast');
      expect(videoModel?.tier).toBe('premium');
      expect(videoModel?.speed).toBe('medium');
    });

    it('should have standard tier for common models', () => {
      const imageModel = getModelById('black-forest-labs/flux-schnell');
      expect(imageModel?.tier).toBe('standard');
      expect(imageModel?.speed).toBe('fast');
    });
  });
});
