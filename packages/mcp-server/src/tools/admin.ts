/**
 * Admin-only tools for configuration flows and UI prompts.
 */
import { z } from 'zod';
import { defineManualTool, defineTool, type ToolResult } from '../registry.js';
import type { TwitterServices } from './twitter.js';

export const TOGGLEABLE_FEATURES = ['media', 'voice', 'twitter', 'telegram', 'discord'] as const;
export type ToggleableFeature = typeof TOGGLEABLE_FEATURES[number];

export interface AdminToolServices {
  twitter?: Pick<TwitterServices, 'getConnectionStatus'>;
}

export function createAdminTools(services: AdminToolServices) {
  return [
    defineManualTool({
      name: 'request_feature_toggle',
      description: 'Show the user a toggle switch to enable or disable a feature (media, voice, Twitter, Telegram, Discord).',
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        feature: z.enum(TOGGLEABLE_FEATURES).describe('The feature to toggle'),
        currentState: z.boolean().optional().describe('Current enabled state (computed server-side)'),
        label: z.string().describe('Human-readable label for the feature (e.g., "Media Generation")'),
        description: z.string().optional().describe('Optional description of what this feature does'),
      }),
    }),

    defineManualTool({
      name: 'request_twitter_connection',
      description: 'Prompt the admin to connect an X/Twitter account via OAuth.',
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        message: z.string().optional().describe('Optional message explaining why connection is needed'),
      }),
    }),

    defineTool({
      name: 'get_twitter_connection_status',
      description: 'Check if an X/Twitter account is connected to this agent.',
      category: 'readonly',
      toolset: 'twitter',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => {
        if (!services.twitter) {
          return { success: false, error: 'Twitter service is not configured.' };
        }

        const status = await services.twitter.getConnectionStatus();
        if (status.connected) {
          return {
            success: true,
            data: {
              connected: true,
              username: status.username,
              message: `Connected to @${status.username}`,
            },
          };
        }

        return {
          success: true,
          data: {
            connected: false,
            message: 'No X/Twitter account connected. Use request_twitter_connection to prompt the user to connect.',
          },
        };
      },
    }),
  ];
}

export default createAdminTools;
