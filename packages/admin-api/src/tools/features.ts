/**
 * Feature toggle tools for enabling/disabling agent capabilities
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

/**
 * Supported features that can be toggled
 */
export const TOGGLEABLE_FEATURES = ['media', 'voice', 'twitter', 'telegram'] as const;
export type ToggleableFeature = typeof TOGGLEABLE_FEATURES[number];

/**
 * Request feature toggle (manual - shows toggle switch in UI)
 *
 * The agent calls this when it detects user intent to enable/disable a feature.
 * The UI renders a toggle switch and returns the user's selection.
 */
export const requestFeatureToggle = tool({
  name: 'request_feature_toggle',
  description: 'Show the user a toggle switch to enable/disable a feature. Use when user expresses intent to turn on/off capabilities like media generation, voice, Twitter, or Telegram.',
  inputSchema: z.object({
    feature: z.enum(TOGGLEABLE_FEATURES).describe('The feature to toggle'),
    currentState: z.boolean().optional().describe('Current enabled state of the feature (computed by the server)'),
    label: z.string().describe('Human-readable label for the feature (e.g., "Media Generation")'),
    description: z.string().optional().describe('Optional description of what this feature does'),
  }),
  execute: false, // Manual - needs user interaction via UI toggle
});

/**
 * Map feature names to their config paths
 * Used by the handler to update the correct config field
 */
export const FEATURE_CONFIG_PATHS: Record<ToggleableFeature, string> = {
  media: 'mediaConfig.enabled',
  voice: 'voiceConfig.enabled',
  twitter: 'platforms.twitter.enabled',
  telegram: 'platforms.telegram.enabled',
};

/**
 * Request Twitter/X account connection (manual - shows OAuth button in UI)
 *
 * The agent calls this when it detects user intent to connect an X/Twitter account.
 * The UI renders a "Connect X Account" button that initiates the OAuth flow.
 */
export const requestTwitterConnection = tool({
  name: 'request_twitter_connection',
  description: 'Show the user a button to connect their X/Twitter account via OAuth. Use when user wants to link their X account, enable Twitter posting, or connect to Twitter.',
  inputSchema: z.object({
    message: z.string().optional().describe('Optional message to show the user explaining why they should connect'),
  }),
  execute: false, // Manual - needs user interaction via OAuth flow
});

/**
 * Get Twitter/X connection status
 */
export const getTwitterConnectionStatus = (
  _agentId: string,
  getStatus: () => Promise<{
    connected: boolean;
    username?: string;
    userId?: string;
    connectedAt?: number;
  }>
) => tool({
  name: 'get_twitter_connection_status',
  description: 'Check if an X/Twitter account is connected to this agent. Returns connection status and username if connected.',
  inputSchema: z.object({}),
  execute: async () => {
    const status = await getStatus();
    if (status.connected) {
      return {
        connected: true,
        username: status.username,
        message: `Connected to @${status.username}`,
      };
    }
    return {
      connected: false,
      message: 'No X/Twitter account connected. Use request_twitter_connection to prompt the user to connect.',
    };
  },
});
