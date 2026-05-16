/**
 * Integrations Service
 * Unified configuration and status management for all integrations.
 */
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { UpdateExpressionBuilder } from '@swarm/core';
import type {
  IntegrationType,
  AICapability,
  AIProviderConfig,
  SecretType,
  UserSession,
} from '../../types.js';

// Re-export types for consumers
export type { IntegrationType, AICapability };
import { getAvatar } from '../avatars.js';
import { _getSecretValueInternal, secretExists, storeSecret } from '../secrets.js';
import { getDefaultModel, getModelsForCapability, type ModelInfo } from '../models-registry.js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getDynamoClient } from '../dynamo-client.js';
import { hasSystemOpenRouterApiKey } from '../openrouter-key.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// =============================================================================
// System Replicate Key Detection (env/Secrets Manager)
// =============================================================================

let cachedSystemReplicateKeyAvailable: boolean | null = null;

function parseReplicateApiKeyFromJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate =
      parsed.api_key ||
      parsed.apiKey ||
      parsed.REPLICATE_API_KEY ||
      parsed.REPLICATE_API_TOKEN ||
      parsed.token ||
      parsed.value;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function hasSystemReplicateKeyConfigured(): Promise<boolean> {
  if (cachedSystemReplicateKeyAvailable !== null) return cachedSystemReplicateKeyAvailable;

  const envKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (envKey && envKey.trim()) {
    cachedSystemReplicateKeyAvailable = true;
    return true;
  }

  const arn = process.env.REPLICATE_API_KEY_SECRET_ARN;
  if (!arn) {
    cachedSystemReplicateKeyAvailable = false;
    return false;
  }

  try {
    const client = new SecretsManagerClient({});
    const resp = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    const raw = (resp.SecretString || '').trim();
    const parsed = raw ? parseReplicateApiKeyFromJson(raw) : undefined;
    cachedSystemReplicateKeyAvailable = Boolean(parsed || raw);
    return cachedSystemReplicateKeyAvailable;
  } catch {
    // If we can't read it (missing secret / access denied), treat as not available.
    cachedSystemReplicateKeyAvailable = false;
    return false;
  }
}

// =============================================================================
// Integration Metadata
// =============================================================================

export interface IntegrationMetadata {
  type: IntegrationType;
  name: string;
  description: string;
  icon: string;
  category: 'platform' | 'ai_provider' | 'blockchain';
  requiredSecrets: SecretType[];
  optionalSecrets: SecretType[];
  capabilities: AICapability[];
  configurable: boolean; // Whether it has a configure_integration panel
}

/**
 * Metadata for all supported integrations
 */
export const INTEGRATION_METADATA: Record<IntegrationType, IntegrationMetadata> = {
  // Platform integrations
  telegram: {
    type: 'telegram',
    name: 'Telegram',
    description: 'Connect a Telegram bot to receive and send messages',
    icon: 'telegram',
    category: 'platform',
    requiredSecrets: ['telegram_bot_token'],
    optionalSecrets: ['telegram_webhook_secret'],
    capabilities: [],
    configurable: true,
  },
  twitter: {
    type: 'twitter',
    name: 'X (Twitter)',
    description: 'Connect to X/Twitter via OAuth to post and interact',
    icon: 'twitter',
    category: 'platform',
    requiredSecrets: ['twitter_access_token', 'twitter_access_secret'],
    optionalSecrets: ['twitter_api_key', 'twitter_api_secret', 'twitter_bearer_token'],
    capabilities: [],
    configurable: true, // Uses OAuth flow
  },
  discord: {
    type: 'discord',
    name: 'Discord',
    description: 'Connect a Discord bot to servers and channels',
    icon: 'discord',
    category: 'platform',
    requiredSecrets: ['discord_bot_token'],
    optionalSecrets: ['discord_client_id', 'discord_client_secret', 'discord_webhook_url'],
    capabilities: [],
    configurable: true,
  },
  web: {
    type: 'web',
    name: 'Web Chat',
    description: 'Enable web-based chat interface',
    icon: 'globe',
    category: 'platform',
    requiredSecrets: [],
    optionalSecrets: [],
    capabilities: [],
    configurable: false,
  },

  // AI Provider integrations
  replicate: {
    type: 'replicate',
    name: 'Replicate',
    description: 'AI models for audio and voice generation',
    icon: 'replicate',
    category: 'ai_provider',
    requiredSecrets: ['replicate_api_key'],
    optionalSecrets: [],
    capabilities: ['audio_generation', 'voice_clone', 'text_to_speech'],
    configurable: true,
  },
  openai: {
    type: 'openai',
    name: 'OpenAI',
    description: 'GPT models for LLM, TTS, and transcription',
    icon: 'openai',
    category: 'ai_provider',
    requiredSecrets: ['openai_api_key'],
    optionalSecrets: [],
    capabilities: ['llm', 'text_to_speech', 'transcription'],
    configurable: true,
  },
  anthropic: {
    type: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models for LLM',
    icon: 'anthropic',
    category: 'ai_provider',
    requiredSecrets: ['anthropic_api_key'],
    optionalSecrets: [],
    capabilities: ['llm'],
    configurable: true,
  },
  openrouter: {
    type: 'openrouter',
    name: 'OpenRouter',
    description: 'Access LLM, image, and video models through a unified API',
    icon: 'openrouter',
    category: 'ai_provider',
    requiredSecrets: ['openrouter_api_key'],
    optionalSecrets: [],
    capabilities: ['llm', 'image_generation', 'video_generation'],
    configurable: true,
  },

  // Blockchain integrations
  solana: {
    type: 'solana',
    name: 'Solana',
    description: 'Solana wallet for blockchain transactions',
    icon: 'solana',
    category: 'blockchain',
    requiredSecrets: ['solana_wallet_key'],
    optionalSecrets: ['helius_api_key'],
    capabilities: [],
    configurable: true,
  },
  ethereum: {
    type: 'ethereum',
    name: 'Ethereum',
    description: 'Ethereum wallet for blockchain transactions',
    icon: 'ethereum',
    category: 'blockchain',
    requiredSecrets: ['ethereum_wallet_key'],
    optionalSecrets: [],
    capabilities: [],
    configurable: true,
  },
};

/**
 * List of integrations that can be configured via configure_integration tool
 */
export const CONFIGURABLE_INTEGRATIONS: IntegrationType[] = Object.values(INTEGRATION_METADATA)
  .filter((m) => m.configurable)
  .map((m) => m.type);

// =============================================================================
// Integration Status
// =============================================================================

export interface IntegrationStatus {
  type: IntegrationType;
  name: string;
  category: 'platform' | 'ai_provider' | 'blockchain';
  status: 'not_configured' | 'configured' | 'error';
  enabled: boolean;
  hasApiKey: boolean;
  hasGlobalKey: boolean;
  useGlobalKey: boolean;
  capabilities: AICapability[];
  models?: Record<string, string>; // For AI providers: current model selections
  statusMessage?: string;
}

/**
 * Get the status of all integrations for an avatar
 */
export async function getAllIntegrationStatuses(avatarId: string): Promise<IntegrationStatus[]> {
  const statuses: IntegrationStatus[] = [];

  for (const type of Object.keys(INTEGRATION_METADATA) as IntegrationType[]) {
    const status = await getIntegrationStatus(avatarId, type);
    statuses.push(status);
  }

  return statuses;
}

/**
 * Get the status of a specific integration for an avatar
 */
export async function getIntegrationStatus(
  avatarId: string,
  integration: IntegrationType
): Promise<IntegrationStatus> {
  const metadata = INTEGRATION_METADATA[integration];
  const avatar = await getAvatar(avatarId);

  // Check secrets
  const secretStatuses = await Promise.all(
    metadata.requiredSecrets.map(async (secretType) => {
      const hasAvatar = await secretExists(avatarId, secretType, 'default');
      const hasGlobal = await secretExists(null, secretType, 'default');
      return { secretType, hasAvatar, hasGlobal };
    })
  );

  const hasApiKey = secretStatuses.some((s) => s.hasAvatar);
  const hasSystemReplicateKey = integration === 'replicate'
    ? await hasSystemReplicateKeyConfigured()
    : false;
  const hasSystemOpenRouterKey = integration === 'openrouter'
    ? await hasSystemOpenRouterApiKey()
    : false;

  const hasGlobalKey = secretStatuses.some((s) => s.hasGlobal) || hasSystemReplicateKey || hasSystemOpenRouterKey;
  const allSecretsConfigured = secretStatuses.every((s) =>
    s.hasAvatar ||
    s.hasGlobal ||
    (hasSystemReplicateKey && s.secretType === 'replicate_api_key') ||
    (hasSystemOpenRouterKey && s.secretType === 'openrouter_api_key')
  );

  // Get integration config from avatar
  const config = avatar?.integrations?.[integration];
  const enabled = config?.enabled ?? false;
  const useGlobalKey = (config as AIProviderConfig)?.useGlobalKey ?? true;

  // Determine status
  let status: 'not_configured' | 'configured' | 'error' = 'not_configured';
  if (allSecretsConfigured || metadata.requiredSecrets.length === 0) {
    status = 'configured';
  }

  // For AI providers, include model selections
  let models: Record<string, string> | undefined;
  if (metadata.category === 'ai_provider') {
    const providerConfig = config as AIProviderConfig | undefined;
    models = {};
    for (const capability of metadata.capabilities) {
      const configuredModel = providerConfig?.models?.[capability];
      const defaultModel = getDefaultModel(capability, integration);
      models[capability] = configuredModel || defaultModel?.id || 'not_set';
    }
  }

  return {
    type: integration,
    name: metadata.name,
    category: metadata.category,
    status,
    enabled,
    hasApiKey,
    hasGlobalKey,
    useGlobalKey,
    capabilities: metadata.capabilities,
    models,
  };
}

// =============================================================================
// Integration Configuration
// =============================================================================

export interface ConfigureIntegrationParams {
  avatarId: string;
  integration: IntegrationType;
  enabled?: boolean;
  useGlobalKey?: boolean;
  models?: Record<string, string>;
  settings?: Record<string, unknown>;
  secrets?: Partial<Record<SecretType, string>>;
  session: UserSession;
}

/**
 * Configure an integration for an avatar
 */
export async function configureIntegration(params: ConfigureIntegrationParams): Promise<void> {
  const { avatarId, integration, secrets, session } = params;
  const metadata = INTEGRATION_METADATA[integration];

  // Store any provided secrets
  if (secrets) {
    for (const [secretType, value] of Object.entries(secrets)) {
      if (value) {
        await storeSecret(avatarId, secretType as SecretType, 'default', value, session);
      }
    }
  }

  const now = Date.now();
  const builder = new UpdateExpressionBuilder()
    .set(`integrations.${integration}.enabled`, params.enabled ?? true)
    .set('updatedAt', now)
    .set('updatedBy', session.email);

  if (metadata.category === 'ai_provider') {
    if (typeof params.useGlobalKey === 'boolean') {
      builder.set(`integrations.${integration}.useGlobalKey`, params.useGlobalKey);
    }

    if (params.models) {
      builder.set(`integrations.${integration}.models`, params.models);
    }
  }

  if (params.settings) {
    for (const [key, value] of Object.entries(params.settings)) {
      // Only support safe, simple keys for now.
      if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) continue;
      builder.set(`integrations.${integration}.${key}`, value);
    }
  }

  const update = builder.build();

  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      ...update,
    })
  );
}

/**
 * Enable or disable an integration
 */
export async function setIntegrationEnabled(
  avatarId: string,
  integration: IntegrationType,
  enabled: boolean,
  session: UserSession
): Promise<void> {
  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      UpdateExpression: 'SET integrations.#integration.enabled = :enabled, updatedAt = :now, updatedBy = :by',
      ExpressionAttributeNames: {
        '#integration': integration,
      },
      ExpressionAttributeValues: {
        ':enabled': enabled,
        ':now': Date.now(),
        ':by': session.email,
      },
    })
  );
}

/**
 * Set model preference for a capability
 */
export async function setModelPreference(
  avatarId: string,
  integration: IntegrationType,
  capability: AICapability,
  modelId: string,
  session: UserSession
): Promise<void> {
  const avatar = await getAvatar(avatarId);
  const existingConfig = avatar?.integrations?.[integration] as AIProviderConfig | undefined;
  const nextConfig = mergeModelPreferenceConfig(existingConfig, capability, modelId);

  const update = new UpdateExpressionBuilder()
    .set(`integrations.${integration}`, nextConfig)
    .set('updatedAt', Date.now())
    .set('updatedBy', session.email)
    .build();

  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      ...update,
    })
  );
}

export function mergeModelPreferenceConfig(
  existingConfig: AIProviderConfig | undefined,
  capability: AICapability,
  modelId: string
): AIProviderConfig {
  return {
    enabled: existingConfig?.enabled ?? false,
    useGlobalKey: existingConfig?.useGlobalKey ?? false,
    ...existingConfig,
    models: {
      ...existingConfig?.models,
      [capability]: modelId,
    },
  };
}

// =============================================================================
// Integration Testing
// =============================================================================

export interface TestResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Test connection for an integration
 */
export async function testIntegrationConnection(
  avatarId: string,
  integration: IntegrationType
): Promise<TestResult> {
  const metadata = INTEGRATION_METADATA[integration];

  switch (integration) {
    case 'replicate':
      return testReplicateConnection(avatarId);
    case 'openai':
      return testOpenAIConnection(avatarId);
    case 'anthropic':
      return testAnthropicConnection(avatarId);
    case 'telegram':
      return testTelegramConnection(avatarId);
    case 'twitter':
      return testTwitterConnection(avatarId);
    case 'discord':
      return testDiscordConnection(avatarId);
    default:
      return { success: false, message: `Testing not implemented for ${metadata.name}` };
  }
}

async function testReplicateConnection(avatarId: string): Promise<TestResult> {
  try {
    const apiKey = await getApiKey(avatarId, 'replicate_api_key');
    if (!apiKey) {
      return { success: false, message: 'No API key configured' };
    }

    const response = await fetch('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (response.ok) {
      const data = (await response.json()) as { username: string };
      return {
        success: true,
        message: `Connected as ${data.username}`,
        details: { username: data.username },
      };
    } else {
      return {
        success: false,
        message: `API error: ${response.status} ${response.statusText}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function testOpenAIConnection(avatarId: string): Promise<TestResult> {
  try {
    const apiKey = await getApiKey(avatarId, 'openai_api_key');
    if (!apiKey) {
      return { success: false, message: 'No API key configured' };
    }

    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (response.ok) {
      return { success: true, message: 'Connected to OpenAI' };
    } else {
      return {
        success: false,
        message: `API error: ${response.status} ${response.statusText}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function testAnthropicConnection(avatarId: string): Promise<TestResult> {
  try {
    const apiKey = await getApiKey(avatarId, 'anthropic_api_key');
    if (!apiKey) {
      return { success: false, message: 'No API key configured' };
    }

    // Anthropic doesn't have a simple test endpoint, so we just verify the key format
    if (apiKey.startsWith('sk-ant-')) {
      return { success: true, message: 'API key format valid' };
    } else {
      return { success: false, message: 'Invalid API key format' };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function testTelegramConnection(avatarId: string): Promise<TestResult> {
  try {
    const token = await getApiKey(avatarId, 'telegram_bot_token');
    if (!token) {
      return { success: false, message: 'No bot token configured' };
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (response.ok) {
      const data = (await response.json()) as { result: { username: string } };
      return {
        success: true,
        message: `Connected as @${data.result.username}`,
        details: { username: data.result.username },
      };
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function testTwitterConnection(avatarId: string): Promise<TestResult> {
  // Twitter uses OAuth, checking if tokens exist
  const accessToken = await getApiKey(avatarId, 'twitter_access_token');
  if (!accessToken) {
    return { success: false, message: 'Not connected - use OAuth to connect' };
  }
  return { success: true, message: 'OAuth tokens configured' };
}

async function testDiscordConnection(avatarId: string): Promise<TestResult> {
  try {
    const token = await getApiKey(avatarId, 'discord_bot_token');
    if (!token) {
      return { success: false, message: 'No bot token configured' };
    }

    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });

    if (response.ok) {
      const data = (await response.json()) as { username: string; discriminator: string };
      return {
        success: true,
        message: `Connected as ${data.username}#${data.discriminator}`,
        details: { username: data.username },
      };
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get API key for an integration (avatar-specific or global fallback)
 */
export async function getApiKey(avatarId: string, secretType: SecretType): Promise<string | null> {
  // Check avatar-specific first
  const avatarKey = await _getSecretValueInternal(avatarId, secretType, 'default');
  if (avatarKey) return avatarKey;

  // Fall back to global
  return _getSecretValueInternal(null, secretType, 'default');
}

/**
 * Get the configured model for a capability, with fallback to defaults
 */
export async function getConfiguredModel(
  avatarId: string,
  capability: AICapability,
  provider: IntegrationType
): Promise<string> {
  const avatar = await getAvatar(avatarId);
  const config = avatar?.integrations?.[provider] as AIProviderConfig | undefined;
  const configuredModel = config?.models?.[capability];

  if (configuredModel) {
    return configuredModel;
  }

  // Fall back to default
  const defaultModel = getDefaultModel(capability, provider);
  return defaultModel?.id || '';
}

/**
 * Get available models for display in configuration UI
 */
export function getAvailableModelsForIntegration(
  integration: IntegrationType
): Record<AICapability, ModelInfo[]> {
  const metadata = INTEGRATION_METADATA[integration];
  const result: Record<string, ModelInfo[]> = {};

  for (const capability of metadata.capabilities) {
    result[capability] = getModelsForCapability(capability, integration);
  }

  return result as Record<AICapability, ModelInfo[]>;
}
