/**
 * Secrets Management Tools
 * 
 * Tools for storing API keys and credentials securely.
 */
import { z } from 'zod';
import { defineTool, defineManualTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

// Be flexible with secret types - actual implementations may have more types
export type SecretType = string;

export interface SecretInfo {
  secretType: string;
  name: string;
  description?: string;
  lastUpdated?: number;
  // Never return the actual value!
}

export interface SecretServices {
  listSecrets: (avatarId: string) => Promise<SecretInfo[]>;
  
  storeSecret: (
    avatarId: string,
    secretType: string,
    name: string,
    value: string,
    description?: string
  ) => Promise<void>;
  
  validateTelegramToken?: (token: string) => Promise<{
    valid: boolean;
    botInfo?: { username?: string };
    error?: string;
  }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createSecretTools = (services: SecretServices) => [
  defineTool({
    name: 'get_my_secrets',
    description: 'List my stored secrets and API keys (values are hidden).',
    category: 'secrets',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const secrets = await services.listSecrets(context.avatarId);

      return {
        success: true,
        data: secrets.map(s => ({
          type: s.secretType,
          name: s.name,
          description: s.description,
          configured: true,
        })),
      };
    },
  }),

  defineTool({
    name: 'store_secret',
    description: 'Store an API key or credential securely. The value is encrypted.',
    category: 'secrets',
    platforms: ['admin-ui', 'api'], // Not exposed to Telegram for security
    inputSchema: z.object({
      secretType: z.enum([
        'telegram_bot_token',
        'telegram_webhook_secret',
        'twitter_api_key',
        'twitter_api_secret',
        'twitter_access_token',
        'twitter_access_secret',
        'replicate_api_key',
        'openai_api_key',
        'anthropic_api_key',
        'helius_api_key',
        'discord_bot_token',
        'custom',
      ]).describe('The type of secret'),
      name: z.string().describe('A name for this secret'),
      value: z.string().describe('The secret value to store'),
      description: z.string().optional().describe('Optional description'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      // Special handling for Telegram tokens
      if (input.secretType === 'telegram_bot_token' && services.validateTelegramToken) {
        const validation = await services.validateTelegramToken(input.value);
        if (!validation.valid) {
          return { success: false, error: `Invalid Telegram token: ${validation.error}` };
        }
      }

      await services.storeSecret(
        context.avatarId,
        input.secretType as SecretType,
        input.name,
        input.value,
        input.description
      );

      return {
        success: true,
        data: {
          message: `Secret "${input.name}" stored securely`,
          type: input.secretType,
        },
      };
    },
  }),

  // Manual tool for UI-based secret input
  defineManualTool({
    name: 'request_secret',
    description: 'Request a secret from the user via secure input field. For integration credentials (Telegram/Twitter/Discord/Replicate voice/OpenAI/Anthropic), prefer configure_integration. Do not request OpenRouter API keys from users; OpenRouter is server-managed.',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      secretType: z.enum([
        'helius_api_key',
        'custom',
      ]).describe('The type of secret needed'),
      reason: z.string().optional().describe('Why this secret is needed'),
    }),
  }),
];

export default createSecretTools;
