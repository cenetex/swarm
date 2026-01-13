/**
 * Secret management tools
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

import { SecretTypeSchema } from './schemas.js';
import type { UserSession } from '../types.js';

/**
 * Request a secret from the user (manual - shows secure input in UI)
 */
export const requestSecret = tool({
  name: 'request_secret',
  description: 'Request a secret value from the user. This will display a secure input field in the UI. Use this to collect API keys, tokens, and other sensitive credentials.',
  inputSchema: z.object({
    secretType: SecretTypeSchema.describe('Type of secret being requested'),
    label: z.string().describe('Human-readable label for the input field'),
    instructions: z.string().optional().describe('Brief instructions on how to get this secret'),
  }),
  execute: false, // Manual - needs user interaction
});

/**
 * Store a secret after user provides it
 */
export const storeSecret = (
  agentId: string,
  session: UserSession,
  storeSecretFn: (
    agentId: string,
    secretType: string,
    name: string,
    value: string,
    session: UserSession,
    description?: string
  ) => Promise<void>,
  validateToken?: (value: string) => Promise<{ valid: boolean; username?: string; error?: string }>
) => tool({
  name: 'store_secret',
  description: 'Store a secret value securely. Use after receiving a secret from request_secret.',
  inputSchema: z.object({
    secretType: SecretTypeSchema.describe('Type of secret'),
    value: z.string().describe('The secret value to store'),
  }),
  execute: async ({ secretType, value }) => {
    // Validate Telegram tokens before storing
    if (secretType === 'telegram_bot_token' && validateToken) {
      const validation = await validateToken(value);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || 'Invalid Telegram bot token',
        };
      }
    }

    await storeSecretFn(
      agentId,
      secretType,
      'default',
      value,
      session,
      `${secretType} for agent ${agentId}`
    );

    return {
      success: true,
      message: `${secretType} stored securely`,
    };
  },
});
