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
    currentState: z.boolean().describe('Current enabled state of the feature'),
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
