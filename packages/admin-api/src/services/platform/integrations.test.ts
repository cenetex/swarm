/**
 * Integrations Service Tests
 *
 * Tests for the unified integration configuration and status management.
 *
 * @see packages/admin-api/src/services/integrations.ts
 */
import { describe, it, expect } from 'vitest';
import {
  INTEGRATION_METADATA,
  CONFIGURABLE_INTEGRATIONS,
  getAvailableModelsForIntegration,
  mergeModelPreferenceConfig,
} from './integrations.js';
import type { IntegrationType, AICapability } from '../../types.js';

describe('Integration Metadata', () => {
  describe('INTEGRATION_METADATA structure', () => {
    it('should have metadata for all integration types', () => {
      const expectedTypes: IntegrationType[] = [
        'telegram',
        'twitter',
        'discord',
        'web',
        'replicate',
        'openai',
        'anthropic',
        'openrouter',
        'solana',
        'ethereum',
      ];

      for (const type of expectedTypes) {
        expect(INTEGRATION_METADATA[type]).toBeTruthy();
        expect(INTEGRATION_METADATA[type].type).toBe(type);
      }
    });

    it('should have valid structure for all integrations', () => {
      for (const [type, metadata] of Object.entries(INTEGRATION_METADATA)) {
        expect(metadata.type).toBe(type);
        expect(metadata.name).toBeTruthy();
        expect(metadata.description).toBeTruthy();
        expect(metadata.icon).toBeTruthy();
        expect(metadata.category).toMatch(/^(platform|ai_provider|blockchain)$/);
        expect(Array.isArray(metadata.requiredSecrets)).toBe(true);
        expect(Array.isArray(metadata.optionalSecrets)).toBe(true);
        expect(Array.isArray(metadata.capabilities)).toBe(true);
        expect(typeof metadata.configurable).toBe('boolean');
      }
    });
  });

  describe('Platform integrations', () => {
    it('should have correct metadata for Telegram', () => {
      const telegram = INTEGRATION_METADATA.telegram;
      expect(telegram.name).toBe('Telegram');
      expect(telegram.category).toBe('platform');
      expect(telegram.requiredSecrets).toContain('telegram_bot_token');
      expect(telegram.configurable).toBe(true);
    });

    it('should have correct metadata for Twitter', () => {
      const twitter = INTEGRATION_METADATA.twitter;
      expect(twitter.name).toBe('X (Twitter)');
      expect(twitter.category).toBe('platform');
      expect(twitter.requiredSecrets).toContain('twitter_access_token');
      expect(twitter.configurable).toBe(true);
    });

    it('should have correct metadata for Discord', () => {
      const discord = INTEGRATION_METADATA.discord;
      expect(discord.name).toBe('Discord');
      expect(discord.category).toBe('platform');
      expect(discord.requiredSecrets).toContain('discord_bot_token');
      expect(discord.configurable).toBe(true);
    });

    it('should have correct metadata for Web', () => {
      const web = INTEGRATION_METADATA.web;
      expect(web.name).toBe('Web Chat');
      expect(web.category).toBe('platform');
      expect(web.requiredSecrets).toHaveLength(0);
      expect(web.configurable).toBe(false);
    });
  });

  describe('AI provider integrations', () => {
    it('should have correct metadata for Replicate', () => {
      const replicate = INTEGRATION_METADATA.replicate;
      expect(replicate.name).toBe('Replicate');
      expect(replicate.category).toBe('ai_provider');
      expect(replicate.requiredSecrets).toContain('replicate_api_key');
      expect(replicate.capabilities).toContain('audio_generation');
      expect(replicate.capabilities).toContain('voice_clone');
      expect(replicate.capabilities).toContain('text_to_speech');
      expect(replicate.configurable).toBe(true);
    });

    it('should have correct metadata for OpenAI', () => {
      const openai = INTEGRATION_METADATA.openai;
      expect(openai.name).toBe('OpenAI');
      expect(openai.category).toBe('ai_provider');
      expect(openai.requiredSecrets).toContain('openai_api_key');
      expect(openai.capabilities).toContain('llm');
      expect(openai.capabilities).toContain('text_to_speech');
      expect(openai.capabilities).toContain('transcription');
      expect(openai.configurable).toBe(true);
    });

    it('should have correct metadata for Anthropic', () => {
      const anthropic = INTEGRATION_METADATA.anthropic;
      expect(anthropic.name).toBe('Anthropic');
      expect(anthropic.category).toBe('ai_provider');
      expect(anthropic.requiredSecrets).toContain('anthropic_api_key');
      expect(anthropic.capabilities).toContain('llm');
      expect(anthropic.configurable).toBe(true);
    });

    it('should have correct metadata for OpenRouter', () => {
      const openrouter = INTEGRATION_METADATA.openrouter;
      expect(openrouter.name).toBe('OpenRouter');
      expect(openrouter.category).toBe('ai_provider');
      expect(openrouter.requiredSecrets).toContain('openrouter_api_key');
      expect(openrouter.capabilities).toContain('llm');
      expect(openrouter.capabilities).toContain('image_generation');
      expect(openrouter.capabilities).toContain('video_generation');
      expect(openrouter.configurable).toBe(true);
    });
  });

  describe('Blockchain integrations', () => {
    it('should have correct metadata for Solana', () => {
      const solana = INTEGRATION_METADATA.solana;
      expect(solana.name).toBe('Solana');
      expect(solana.category).toBe('blockchain');
      expect(solana.requiredSecrets).toContain('solana_wallet_key');
      expect(solana.configurable).toBe(true);
    });

    it('should have correct metadata for Ethereum', () => {
      const ethereum = INTEGRATION_METADATA.ethereum;
      expect(ethereum.name).toBe('Ethereum');
      expect(ethereum.category).toBe('blockchain');
      expect(ethereum.requiredSecrets).toContain('ethereum_wallet_key');
      expect(ethereum.configurable).toBe(true);
    });
  });
});

describe('CONFIGURABLE_INTEGRATIONS', () => {
  it('should include all configurable integrations', () => {
    const configurable = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.configurable)
      .map((m) => m.type);

    expect(CONFIGURABLE_INTEGRATIONS.sort()).toEqual(configurable.sort());
  });

  it('should not include web (not configurable)', () => {
    expect(CONFIGURABLE_INTEGRATIONS).not.toContain('web');
  });

  it('should include telegram, twitter, discord', () => {
    expect(CONFIGURABLE_INTEGRATIONS).toContain('telegram');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('twitter');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('discord');
  });

  it('should include AI providers', () => {
    expect(CONFIGURABLE_INTEGRATIONS).toContain('replicate');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('openai');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('anthropic');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('openrouter');
  });

  it('should include blockchain integrations', () => {
    expect(CONFIGURABLE_INTEGRATIONS).toContain('solana');
    expect(CONFIGURABLE_INTEGRATIONS).toContain('ethereum');
  });
});

describe('getAvailableModelsForIntegration', () => {
  it('should return models for Replicate capabilities', () => {
    const models = getAvailableModelsForIntegration('replicate');

    expect(models.audio_generation).toBeTruthy();
    expect(models.voice_clone).toBeTruthy();
    expect(models.text_to_speech).toBeTruthy();

    // Should have at least one model per capability
    expect(models.audio_generation.length).toBeGreaterThan(0);
    expect(models.voice_clone.length).toBeGreaterThan(0);
  });

  it('should return media models for OpenRouter capabilities', () => {
    const models = getAvailableModelsForIntegration('openrouter');

    expect(models.llm).toEqual([]);
    expect(models.image_generation).toBeTruthy();
    expect(models.video_generation).toBeTruthy();
    expect(models.image_generation.length).toBeGreaterThan(0);
    expect(models.video_generation.length).toBeGreaterThan(0);
  });

  it('should not return static LLM models for OpenAI capabilities', () => {
    const models = getAvailableModelsForIntegration('openai');

    expect(models.llm).toEqual([]);
    expect(models.text_to_speech).toBeTruthy();
    expect(models.transcription).toBeTruthy();
  });

  it('should not return static LLM models for Anthropic capabilities', () => {
    const models = getAvailableModelsForIntegration('anthropic');

    expect(models.llm).toEqual([]);
  });

  it('should only return models for that provider', () => {
    const replicateModels = getAvailableModelsForIntegration('replicate');
    const openaiModels = getAvailableModelsForIntegration('openai');

    // Replicate models should all be from replicate
    for (const models of Object.values(replicateModels)) {
      for (const model of models) {
        expect(model.provider).toBe('replicate');
      }
    }

    // OpenAI models should all be from openai
    for (const models of Object.values(openaiModels)) {
      for (const model of models) {
        expect(model.provider).toBe('openai');
      }
    }
  });

  it('should return empty arrays for platform integrations (no AI capabilities)', () => {
    const telegramModels = getAvailableModelsForIntegration('telegram');
    expect(Object.keys(telegramModels)).toHaveLength(0);

    const twitterModels = getAvailableModelsForIntegration('twitter');
    expect(Object.keys(twitterModels)).toHaveLength(0);
  });
});

describe('Integration Status Logic', () => {
  /**
   * Tests for the IntegrationStatus interface and status determination logic
   */

  interface MockSecretStatus {
    secretType: string;
    hasAvatar: boolean;
    hasGlobal: boolean;
  }

  function determineStatus(
    secretStatuses: MockSecretStatus[],
    requiredSecretsCount: number
  ): 'not_configured' | 'configured' | 'error' {
    const allSecretsConfigured = secretStatuses.every((s) => s.hasAvatar || s.hasGlobal);
    if (allSecretsConfigured || requiredSecretsCount === 0) {
      return 'configured';
    }
    return 'not_configured';
  }

  it('should return configured when all required secrets exist', () => {
    const secretStatuses: MockSecretStatus[] = [
      { secretType: 'replicate_api_key', hasAvatar: true, hasGlobal: false },
    ];

    const status = determineStatus(secretStatuses, 1);
    expect(status).toBe('configured');
  });

  it('should return configured when global secrets exist', () => {
    const secretStatuses: MockSecretStatus[] = [
      { secretType: 'replicate_api_key', hasAvatar: false, hasGlobal: true },
    ];

    const status = determineStatus(secretStatuses, 1);
    expect(status).toBe('configured');
  });

  it('should return not_configured when required secrets missing', () => {
    const secretStatuses: MockSecretStatus[] = [
      { secretType: 'replicate_api_key', hasAvatar: false, hasGlobal: false },
    ];

    const status = determineStatus(secretStatuses, 1);
    expect(status).toBe('not_configured');
  });

  it('should return configured when no secrets required', () => {
    const status = determineStatus([], 0);
    expect(status).toBe('configured');
  });

  it('should handle mixed secret availability', () => {
    const secretStatuses: MockSecretStatus[] = [
      { secretType: 'twitter_access_token', hasAvatar: true, hasGlobal: false },
      { secretType: 'twitter_access_secret', hasAvatar: false, hasGlobal: false },
    ];

    const status = determineStatus(secretStatuses, 2);
    expect(status).toBe('not_configured');
  });
});

describe('Model Selection Logic', () => {
  /**
   * Tests for the getConfiguredModel function logic
   */

  interface MockAIProviderConfig {
    enabled: boolean;
    useGlobalKey: boolean;
    models?: Record<string, string>;
  }

  interface MockAvatar {
    integrations?: Record<string, MockAIProviderConfig>;
  }

  function getConfiguredModel(
    avatar: MockAvatar | null,
    capability: AICapability,
    defaultModelId: string
  ): string {
    const config = avatar?.integrations?.replicate;
    const configuredModel = config?.models?.[capability];

    if (configuredModel) {
      return configuredModel;
    }

    return defaultModelId;
  }

  it('should return configured model when set', () => {
    const avatar: MockAvatar = {
      integrations: {
        replicate: {
          enabled: true,
          useGlobalKey: false,
          models: {
            image_generation: 'custom/model',
          },
        },
      },
    };

    const model = getConfiguredModel(avatar, 'image_generation', 'default/model');
    expect(model).toBe('custom/model');
  });

  it('should return default when no config', () => {
    const avatar: MockAvatar = {};
    const model = getConfiguredModel(avatar, 'image_generation', 'default/model');
    expect(model).toBe('default/model');
  });

  it('should return default when avatar is null', () => {
    const model = getConfiguredModel(null, 'image_generation', 'default/model');
    expect(model).toBe('default/model');
  });

  it('should return default when capability not in models', () => {
    const avatar: MockAvatar = {
      integrations: {
        replicate: {
          enabled: true,
          useGlobalKey: true,
          models: {
            video_generation: 'custom/video',
          },
        },
      },
    };

    const model = getConfiguredModel(avatar, 'image_generation', 'default/image');
    expect(model).toBe('default/image');
  });
});

describe('Model Preference Merge', () => {
  it('creates a config when none exists yet', () => {
    expect(
      mergeModelPreferenceConfig(undefined, 'image_generation', 'owner/model')
    ).toEqual({
      enabled: false,
      useGlobalKey: false,
      models: {
        image_generation: 'owner/model',
      },
    });
  });

  it('preserves existing settings and merges models', () => {
    expect(
      mergeModelPreferenceConfig(
        {
          enabled: true,
          useGlobalKey: true,
          webhookUrl: 'https://example.com/hook',
          models: {
            video_generation: 'video/model',
          },
        },
        'image_generation',
        'image/model'
      )
    ).toEqual({
      enabled: true,
      useGlobalKey: true,
      webhookUrl: 'https://example.com/hook',
      models: {
        video_generation: 'video/model',
        image_generation: 'image/model',
      },
    });
  });
});

describe('Integration Categories', () => {
  it('should correctly categorize platform integrations', () => {
    const platforms = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.category === 'platform');

    expect(platforms.map((p) => p.type)).toEqual(
      expect.arrayContaining(['telegram', 'twitter', 'discord', 'web'])
    );
  });

  it('should correctly categorize AI provider integrations', () => {
    const aiProviders = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.category === 'ai_provider');

    expect(aiProviders.map((p) => p.type)).toEqual(
      expect.arrayContaining(['replicate', 'openai', 'anthropic', 'openrouter'])
    );
  });

  it('should correctly categorize blockchain integrations', () => {
    const blockchain = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.category === 'blockchain');

    expect(blockchain.map((p) => p.type)).toEqual(
      expect.arrayContaining(['solana', 'ethereum'])
    );
  });
});

describe('Capability Distribution', () => {
  it('should have image_generation on OpenRouter', () => {
    const providers = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('image_generation'));

    expect(providers.map((p) => p.type)).toEqual(['openrouter']);
  });

  it('should have video_generation only on OpenRouter', () => {
    const providers = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('video_generation'));

    expect(providers.map((p) => p.type)).toEqual(['openrouter']);
  });

  it('should have llm on multiple providers', () => {
    const providers = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('llm'));

    expect(providers.length).toBeGreaterThan(1);
    expect(providers.map((p) => p.type)).toContain('openai');
    expect(providers.map((p) => p.type)).toContain('anthropic');
    expect(providers.map((p) => p.type)).toContain('openrouter');
  });

  it('should have transcription on OpenAI', () => {
    const providers = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('transcription'));

    expect(providers.map((p) => p.type)).toContain('openai');
  });

  it('should have voice_clone and audio_generation on Replicate', () => {
    const voiceCloneProviders = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('voice_clone'));
    const audioGenProviders = Object.values(INTEGRATION_METADATA)
      .filter((m) => m.capabilities.includes('audio_generation'));

    expect(voiceCloneProviders.map((p) => p.type)).toContain('replicate');
    expect(audioGenProviders.map((p) => p.type)).toContain('replicate');
  });
});

describe('Secret Types', () => {
  it('should use correct secret types for each integration', () => {
    expect(INTEGRATION_METADATA.telegram.requiredSecrets).toContain('telegram_bot_token');
    expect(INTEGRATION_METADATA.twitter.requiredSecrets).toContain('twitter_access_token');
    expect(INTEGRATION_METADATA.discord.requiredSecrets).toContain('discord_bot_token');
    expect(INTEGRATION_METADATA.replicate.requiredSecrets).toContain('replicate_api_key');
    expect(INTEGRATION_METADATA.openai.requiredSecrets).toContain('openai_api_key');
    expect(INTEGRATION_METADATA.anthropic.requiredSecrets).toContain('anthropic_api_key');
    expect(INTEGRATION_METADATA.openrouter.requiredSecrets).toContain('openrouter_api_key');
    expect(INTEGRATION_METADATA.solana.requiredSecrets).toContain('solana_wallet_key');
    expect(INTEGRATION_METADATA.ethereum.requiredSecrets).toContain('ethereum_wallet_key');
  });

  it('should have optional secrets where appropriate', () => {
    expect(INTEGRATION_METADATA.telegram.optionalSecrets).toContain('telegram_webhook_secret');
    expect(INTEGRATION_METADATA.discord.optionalSecrets).toContain('discord_webhook_url');
    expect(INTEGRATION_METADATA.solana.optionalSecrets).toContain('helius_api_key');
  });
});
