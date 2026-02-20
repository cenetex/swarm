/**
 * Admin-only tools for configuration flows and UI prompts.
 */
import { z } from 'zod';
import { defineManualTool, defineTool, type ToolResult } from '../registry.js';
import type { TwitterServices } from './twitter.js';

export const TOGGLEABLE_FEATURES = ['media', 'voice', 'twitter', 'telegram', 'discord', 'replicate'] as const;
export type ToggleableFeature = typeof TOGGLEABLE_FEATURES[number];

/**
 * Supported integrations that can be configured via the configure_integration tool.
 * Each integration shows an inline configuration panel with:
 * - Enable/disable toggle
 * - Required credentials input
 * - Connection test
 * - Status display
 *
 * Includes both platform integrations (Telegram, Twitter, Discord) and
 * AI provider integrations (Replicate, OpenAI, Anthropic).
 */
export const CONFIGURABLE_INTEGRATIONS = [
  // Platform integrations
  'telegram',
  'twitter',
  'discord',
  // AI provider integrations
  'replicate',
  'openai',
  'anthropic',
  'openrouter',
] as const;
export type ConfigurableIntegration = typeof CONFIGURABLE_INTEGRATIONS[number];

/**
 * AI capabilities that can be configured per-integration
 */
export const AI_CAPABILITIES = [
  'image_generation',
  'video_generation',
  'audio_generation',
  'voice_clone',
  'text_to_speech',
  'transcription',
  'llm',
] as const;
export type AICapability = typeof AI_CAPABILITIES[number];

/**
 * Valid avatar statuses for activation/deactivation
 */
export const AVATAR_STATUSES = ['draft', 'active', 'paused'] as const;
export type AvatarStatus = typeof AVATAR_STATUSES[number];

/**
 * Integration status returned by get_integration_status
 */
export interface IntegrationStatus {
  type: string;
  name: string;
  category: 'platform' | 'ai_provider' | 'blockchain';
  status: 'not_configured' | 'configured' | 'error';
  enabled: boolean;
  hasApiKey: boolean;
  hasGlobalKey: boolean;
  useGlobalKey: boolean;
  capabilities: string[];
  models?: Record<string, string>;
  statusMessage?: string;
}

/**
 * Model info returned by get_available_models
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  description: string;
  tier: 'free' | 'standard' | 'premium';
  speed: 'fast' | 'medium' | 'slow';
  quality: 'draft' | 'standard' | 'high';
  isDefault?: boolean;
}

/**
 * Test connection result
 */
export interface TestConnectionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Services required by admin tools
 */
export interface AdminToolServices {
  twitter?: Pick<TwitterServices, 'getConnectionStatus'>;

  // Integration services (optional - only available in admin-api context)
  integrations?: {
    getStatus: (integration: ConfigurableIntegration) => Promise<IntegrationStatus>;
    getAllStatuses: () => Promise<IntegrationStatus[]>;
    testConnection: (integration: ConfigurableIntegration) => Promise<TestConnectionResult>;
    getAvailableModels: (integration?: string, capability?: string) => ModelInfo[];
    setModelPreference: (integration: string, capability: string, modelId: string) => Promise<void>;
  };

  // Avatar status management (optional - only available in admin-api context)
  avatar?: {
    setStatus: (avatarId: string, status: AvatarStatus) => Promise<{ success: boolean; name?: string; error?: string }>;
    getStatus: (avatarId: string) => Promise<{ status: AvatarStatus; name: string } | null>;
  };
}

export function createAdminTools(services: AdminToolServices) {
  return [
    /**
     * Unified integration configuration tool.
     * Avatar calls this with the integration name, UI shows a complete setup panel.
     * Much simpler than having the avatar walk through multi-step credential flows.
     *
     * Supports both platform integrations (Telegram, Twitter, Discord) and
     * AI provider integrations (Replicate, OpenAI, Anthropic, OpenRouter).
     */
    defineManualTool({
      name: 'configure_integration',
      description: `Show the configuration panel for an integration.

**Platform integrations:** telegram, twitter, discord
**AI providers:** replicate, openai, anthropic, openrouter

The panel allows the user to:
- Enable or disable the integration
- Enter required credentials (bot tokens, API keys)
- For AI providers: select which models to use for each capability
- Test the connection
- View current status

Use this when:
- Setting up a new integration
- Resetting credentials (e.g., "reset my Telegram token", "update Replicate API key")
- Configuring AI model preferences (e.g., "I want to use a different image model")
- Checking integration status
- Troubleshooting connection issues

The UI handles all the complexity - just call this tool with the integration name.`,
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        integration: z.enum(CONFIGURABLE_INTEGRATIONS).describe('Which integration to configure'),
        reason: z.string().optional().describe('Brief context for why configuration is needed'),
      }),
    }),

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
      description: 'Check if an X/Twitter account is connected to this avatar.',
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

    // =========================================================================
    // Integration Status Tools
    // =========================================================================

    defineTool({
      name: 'get_integration_status',
      description: `Get the current status of a specific integration.
Returns whether it's configured, enabled, which API keys are set, and for AI providers, which models are selected.

Use this to check if an integration is ready to use before attempting to use its features.`,
      category: 'readonly',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({
        integration: z.enum(CONFIGURABLE_INTEGRATIONS).describe('Which integration to check'),
      }),
      execute: async (params): Promise<ToolResult> => {
        if (!services.integrations) {
          return { success: false, error: 'Integration service is not available.' };
        }

        const status = await services.integrations.getStatus(params.integration);
        return {
          success: true,
          data: status,
        };
      },
    }),

    defineTool({
      name: 'get_all_integration_statuses',
      description: `Get the status of all integrations at once.
Useful for showing an overview of what's configured and what needs setup.`,
      category: 'readonly',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => {
        if (!services.integrations) {
          return { success: false, error: 'Integration service is not available.' };
        }

        const statuses = await services.integrations.getAllStatuses();
        return {
          success: true,
          data: {
            integrations: statuses,
            summary: {
              configured: statuses.filter(s => s.status === 'configured').length,
              enabled: statuses.filter(s => s.enabled).length,
              total: statuses.length,
            },
          },
        };
      },
    }),

    defineTool({
      name: 'test_integration_connection',
      description: `Test the connection for an integration.
Verifies that the credentials are valid and the service is accessible.`,
      category: 'readonly',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({
        integration: z.enum(CONFIGURABLE_INTEGRATIONS).describe('Which integration to test'),
      }),
      execute: async (params): Promise<ToolResult> => {
        if (!services.integrations) {
          return { success: false, error: 'Integration service is not available.' };
        }

        const result = await services.integrations.testConnection(params.integration);
        return {
          success: result.success,
          data: result,
          error: result.success ? undefined : result.message,
        };
      },
    }),

    // =========================================================================
    // Model Configuration Tools
    // =========================================================================

    defineTool({
      name: 'get_available_models',
      description: `Get the list of available AI models.
Can filter by integration (e.g., 'replicate', 'openai') or capability (e.g., 'image_generation', 'voice_clone').

Use this to show the user what models they can choose from.`,
      category: 'readonly',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({
        integration: z.enum(['replicate', 'openai', 'anthropic', 'openrouter']).optional()
          .describe('Filter models by provider'),
        capability: z.enum(AI_CAPABILITIES).optional()
          .describe('Filter models by capability'),
      }),
      execute: async (params): Promise<ToolResult> => {
        if (!services.integrations) {
          return { success: false, error: 'Integration service is not available.' };
        }

        const models = services.integrations.getAvailableModels(params.integration, params.capability);
        return {
          success: true,
          data: {
            models,
            count: models.length,
          },
        };
      },
    }),

    defineManualTool({
      name: 'request_model_selection',
      description: `Show the user a model selection interface for a specific capability.
Use this when the user wants to change which AI model is used for a specific task.

Example: "I want to use a different model for image generation"`,
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        capability: z.enum(AI_CAPABILITIES).describe('Which capability to configure'),
        currentModel: z.string().optional().describe('Currently selected model (if any)'),
        reason: z.string().optional().describe('Why the user wants to change models'),
      }),
    }),

    // =========================================================================
    // Avatar Status Tools
    // =========================================================================

    defineTool({
      name: 'set_avatar_status',
      description: `Set the status of an avatar to control whether it responds to messages.

**Statuses:**
- \`active\` - Avatar will respond to messages in shared chat and on connected platforms
- \`paused\` - Avatar is temporarily disabled and won't respond to messages
- \`draft\` - Avatar is in setup mode and won't respond until activated

Use this when:
- Activating a newly configured avatar ("activate this avatar", "turn on the bot")
- Pausing an avatar temporarily ("pause the avatar", "stop responding")
- Putting an avatar back in draft mode for reconfiguration

Note: This affects the current avatar context. The avatar must have required configuration (persona, at least one platform) to be activated.`,
      category: 'config',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({
        status: z.enum(AVATAR_STATUSES).describe('The new status for the avatar'),
        reason: z.string().optional().describe('Optional reason for the status change'),
      }),
      execute: async (params, context): Promise<ToolResult> => {
        if (!services.avatar) {
          return { success: false, error: 'Avatar service is not available.' };
        }

        if (!context.avatarId) {
          return { success: false, error: 'No avatar context available.' };
        }

        const result = await services.avatar.setStatus(context.avatarId, params.status);
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to update avatar status.' };
        }

        const statusMessages: Record<AvatarStatus, string> = {
          active: `Avatar "${result.name}" is now active and will respond to messages.`,
          paused: `Avatar "${result.name}" is now paused and won't respond to messages.`,
          draft: `Avatar "${result.name}" is now in draft mode for configuration.`,
        };

        return {
          success: true,
          data: {
            avatarId: context.avatarId,
            name: result.name,
            status: params.status,
            message: statusMessages[params.status],
          },
        };
      },
    }),

    defineTool({
      name: 'get_avatar_status',
      description: `Get the current status of an avatar.

Returns whether the avatar is active, paused, or in draft mode.`,
      category: 'readonly',
      toolset: 'admin',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({}),
      execute: async (_params, context): Promise<ToolResult> => {
        if (!services.avatar) {
          return { success: false, error: 'Avatar service is not available.' };
        }

        if (!context.avatarId) {
          return { success: false, error: 'No avatar context available.' };
        }

        const result = await services.avatar.getStatus(context.avatarId);
        if (!result) {
          return { success: false, error: 'Avatar not found.' };
        }

        return {
          success: true,
          data: {
            avatarId: context.avatarId,
            name: result.name,
            status: result.status,
            isActive: result.status === 'active',
          },
        };
      },
    }),

    // =========================================================================
    // Wallet Linking Tools
    // =========================================================================

    defineManualTool({
      name: 'request_wallet_link',
      description: `Show the wallet linking UI to let the user link an additional Solana wallet to their account.

This opens an inline prompt where the user can:
1. Connect a Solana wallet (via Phantom or other wallet adapter)
2. Sign a challenge message to prove ownership
3. Link the wallet to their existing Swarm account

Use this when:
- User asks to link a wallet ("link my wallet", "add another wallet")
- User wants to connect a new wallet to their account
- User asks about wallet linking or account wallets

The linked wallets appear in the user's account identity and affect NFT gate status.`,
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        reason: z.string().optional().describe('Brief context for why the user wants to link a wallet'),
      }),
    }),
  ];
}

export default createAdminTools;
