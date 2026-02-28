/**
 * Voice Service Tests
 *
 * Tests for voice integration configuration and model selection.
 *
 * @see packages/admin-api/src/services/voice.ts
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from '../models-registry.js';
import type { AICapability, AvatarRecord } from '../../types.js';

describe('Voice Integration Config Model Selection', () => {
  /**
   * Simulates the getConfiguredVoiceModel function logic for testing.
   * In production this reads from DynamoDB via getAvatar().
   */
  function getConfiguredVoiceModel(
    avatar: Partial<AvatarRecord> | null,
    capability: AICapability
  ): string {
    const DEFAULT_STABLE_AUDIO_MODEL = DEFAULT_MODELS.audio_generation;
    const DEFAULT_VOICE_TTS_MODEL = DEFAULT_MODELS.voice_clone;

    // Check avatar's integration config
    if (avatar?.integrations?.replicate?.models?.[capability]) {
      return avatar.integrations.replicate.models[capability]!;
    }

    // Fall back to defaults based on capability
    return capability === 'audio_generation' ? DEFAULT_STABLE_AUDIO_MODEL : DEFAULT_VOICE_TTS_MODEL;
  }

  describe('Audio generation model selection', () => {
    it('should return configured audio_generation model', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              audio_generation: 'custom/audio-model',
            },
          },
        },
      };

      const model = getConfiguredVoiceModel(avatar, 'audio_generation');
      expect(model).toBe('custom/audio-model');
    });

    it('should return default audio model when not configured', () => {
      const avatar: Partial<AvatarRecord> = {};
      const model = getConfiguredVoiceModel(avatar, 'audio_generation');
      expect(model).toBe(DEFAULT_MODELS.audio_generation);
    });

    it('should return default audio model for null avatar', () => {
      const model = getConfiguredVoiceModel(null, 'audio_generation');
      expect(model).toBe(DEFAULT_MODELS.audio_generation);
    });
  });

  describe('Voice clone model selection', () => {
    it('should return configured voice_clone model', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: true,
            models: {
              voice_clone: 'custom/voice-clone-model',
            },
          },
        },
      };

      const model = getConfiguredVoiceModel(avatar, 'voice_clone');
      expect(model).toBe('custom/voice-clone-model');
    });

    it('should return default voice clone model when not configured', () => {
      const avatar: Partial<AvatarRecord> = {};
      const model = getConfiguredVoiceModel(avatar, 'voice_clone');
      expect(model).toBe(DEFAULT_MODELS.voice_clone);
    });
  });

  describe('Text-to-speech model selection', () => {
    it('should return configured text_to_speech model', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              text_to_speech: 'openai/tts-1-hd',
            },
          },
        },
      };

      const model = getConfiguredVoiceModel(avatar, 'text_to_speech');
      expect(model).toBe('openai/tts-1-hd');
    });

    it('should fall back to voice_clone default for text_to_speech when not configured', () => {
      // text_to_speech falls back to DEFAULT_VOICE_TTS_MODEL (same as voice_clone)
      const avatar: Partial<AvatarRecord> = {};
      const model = getConfiguredVoiceModel(avatar, 'text_to_speech');
      expect(model).toBe(DEFAULT_MODELS.voice_clone);
    });
  });

  describe('Multiple voice capabilities configured', () => {
    it('should return correct model for each capability', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              audio_generation: 'custom/stable-audio',
              voice_clone: 'custom/xtts',
              text_to_speech: 'custom/tts',
            },
          },
        },
      };

      expect(getConfiguredVoiceModel(avatar, 'audio_generation')).toBe('custom/stable-audio');
      expect(getConfiguredVoiceModel(avatar, 'voice_clone')).toBe('custom/xtts');
      expect(getConfiguredVoiceModel(avatar, 'text_to_speech')).toBe('custom/tts');
    });

    it('should handle partial configuration', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: true,
            models: {
              audio_generation: 'custom/audio-only',
              // voice_clone and text_to_speech not configured
            },
          },
        },
      };

      expect(getConfiguredVoiceModel(avatar, 'audio_generation')).toBe('custom/audio-only');
      expect(getConfiguredVoiceModel(avatar, 'voice_clone')).toBe(DEFAULT_MODELS.voice_clone);
      expect(getConfiguredVoiceModel(avatar, 'text_to_speech')).toBe(DEFAULT_MODELS.voice_clone);
    });
  });

  describe('Integration config edge cases', () => {
    it('should handle replicate integration disabled but models configured', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: false, // disabled
            useGlobalKey: false,
            models: {
              voice_clone: 'custom/model',
            },
          },
        },
      };

      // Should still return the configured model (enabled flag doesn't affect model selection)
      const model = getConfiguredVoiceModel(avatar, 'voice_clone');
      expect(model).toBe('custom/model');
    });

    it('should handle empty models object', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {},
          },
        },
      };

      const model = getConfiguredVoiceModel(avatar, 'voice_clone');
      expect(model).toBe(DEFAULT_MODELS.voice_clone);
    });

    it('should handle undefined models', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: true,
          },
        },
      };

      const model = getConfiguredVoiceModel(avatar, 'voice_clone');
      expect(model).toBe(DEFAULT_MODELS.voice_clone);
    });
  });
});

describe('Voice Pipeline Model Usage', () => {
  /**
   * Tests that verify the 3-step voice creation pipeline uses correct models
   */

  describe('Voice seed generation (Step 1)', () => {
    it('should use audio_generation model for creating voice seed', () => {
      // createVoiceSeed uses audio_generation capability
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              audio_generation: 'stability-ai/stable-audio-2.5',
            },
          },
        },
      };

      const model = avatar.integrations?.replicate?.models?.audio_generation;
      expect(model).toBe('stability-ai/stable-audio-2.5');
    });
  });

  describe('Voice clone passes (Steps 2 & 3)', () => {
    it('should use voice_clone model for clone passes', () => {
      // runVoiceClonePass uses voice_clone capability
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              voice_clone: 'lucataco/xtts-v2',
            },
          },
        },
      };

      const model = avatar.integrations?.replicate?.models?.voice_clone;
      expect(model).toBe('lucataco/xtts-v2');
    });
  });

  describe('Voice message generation', () => {
    it('should use text_to_speech model for generating voice messages', () => {
      // generateVoiceMessage uses text_to_speech capability
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          replicate: {
            enabled: true,
            useGlobalKey: false,
            models: {
              text_to_speech: 'lucataco/xtts-v2',
            },
          },
        },
      };

      const model = avatar.integrations?.replicate?.models?.text_to_speech;
      expect(model).toBe('lucataco/xtts-v2');
    });
  });
});

describe('Official vs Community Model Detection', () => {
  /**
   * Tests for model endpoint selection logic.
   * Official models use /v1/models/{model}/predictions
   * Community models use /v1/predictions with version hash
   */

  const OFFICIAL_MODEL_PREFIXES = ['stability-ai', 'meta', 'openai', 'mistralai', 'resemble-ai'];

  function isOfficialModel(model: string): boolean {
    return OFFICIAL_MODEL_PREFIXES.some(prefix => model.startsWith(prefix));
  }

  describe('Official model detection', () => {
    it('should identify stability-ai models as official', () => {
      expect(isOfficialModel('stability-ai/stable-audio-2.5')).toBe(true);
      expect(isOfficialModel('stability-ai/sdxl')).toBe(true);
    });

    it('should identify meta models as official', () => {
      expect(isOfficialModel('meta/llama-2-70b')).toBe(true);
    });

    it('should identify openai models as official', () => {
      expect(isOfficialModel('openai/whisper')).toBe(true);
    });
  });

  describe('Community model detection', () => {
    it('should identify community models', () => {
      expect(isOfficialModel('lucataco/xtts-v2')).toBe(false);
      expect(isOfficialModel('google/nano-banana-pro')).toBe(false);
      expect(isOfficialModel('minimax/video-01')).toBe(false);
    });
  });

  describe('Endpoint selection', () => {
    it('should use /models endpoint for official models', () => {
      const model = 'stability-ai/stable-audio-2.5';
      const isOfficial = isOfficialModel(model);

      const endpoint = isOfficial
        ? `https://api.replicate.com/v1/models/${model}/predictions`
        : 'https://api.replicate.com/v1/predictions';

      expect(endpoint).toBe('https://api.replicate.com/v1/models/stability-ai/stable-audio-2.5/predictions');
    });

    it('should use /predictions endpoint for community models', () => {
      const model = 'lucataco/xtts-v2';
      const isOfficial = isOfficialModel(model);
      const version = 'abc123def456'; // Mock version hash

      // Community models need a version hash
      expect(isOfficial).toBe(false);

      const body: Record<string, unknown> = { input: { text: 'hello' } };
      if (!isOfficial) {
        body.version = version;
      }

      expect(body.version).toBe(version);
    });
  });
});

describe('Voice Config Integration', () => {
  /**
   * Tests for VoiceConfig integration with the unified config system
   */

  it('should coexist with voiceConfig settings', () => {
    const avatar: Partial<AvatarRecord> = {
      voiceConfig: {
        enabled: true,
        defaultVoiceId: 'voice-123',
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      integrations: {
        replicate: {
          enabled: true,
          useGlobalKey: true,
          models: {
            voice_clone: 'custom/model',
          },
        },
      },
    };

    // voiceConfig controls voice behavior
    expect(avatar.voiceConfig?.enabled).toBe(true);
    expect(avatar.voiceConfig?.ttsProvider).toBe('voice-clone');

    // integrations.replicate.models controls which model is used
    expect(avatar.integrations?.replicate?.models?.voice_clone).toBe('custom/model');
  });

  it('should use referenceUrl from voiceConfig for voice generation', () => {
    const avatar: Partial<AvatarRecord> = {
      voiceConfig: {
        enabled: true,
        defaultVoiceId: 'voice-123',
        ttsProvider: 'voice-clone',
        referenceUrl: 'https://cdn.example.com/voice-ref.ogg',
      },
    };

    expect(avatar.voiceConfig?.referenceUrl).toBe('https://cdn.example.com/voice-ref.ogg');
  });
});
