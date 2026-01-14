/**
 * Model Configuration Tools
 * 
 * Tools for listing and changing LLM models.
 */
import { z } from 'zod';
import { defineTool, defineManualTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing?: {
    prompt: number | string;
    completion: number | string;
  };
}

export interface ModelServices {
  listModels: (family?: string) => Promise<ModelInfo[]>;
  
  getConfig: (agentId: string) => Promise<{
    model: string;
    temperature: number;
    maxTokens: number;
    provider?: string;
  }>;
  
  updateConfig: (agentId: string, config: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<void>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createModelTools = (services: ModelServices) => [
  defineTool({
    name: 'list_available_models',
    description: 'List available AI models I can use. Returns model IDs and context lengths.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      family: z.string()
        .optional()
        .describe('Filter by model family (e.g., "claude", "gpt", "gemini")'),
    }),
    execute: async (input): Promise<ToolResult> => {
      const models = await services.listModels(input.family);

      return {
        success: true,
        data: models.slice(0, 20).map(m => ({
          id: m.id,
          name: m.name,
          contextLength: m.contextLength,
        })),
      };
    },
  }),

  defineTool({
    name: 'get_my_model_config',
    description: 'Get my current LLM model configuration.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const config = await services.getConfig(context.agentId);

      return {
        success: true,
        data: config,
      };
    },
  }),

  defineTool({
    name: 'change_my_model',
    description: 'Change which AI model I use. Model ID must be from list_available_models.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      model: z.string().describe('The model ID to use (e.g., "anthropic/claude-sonnet-4")'),
      temperature: z.number()
        .min(0)
        .max(2)
        .optional()
        .describe('Creativity level 0.0-2.0 (default 0.8)'),
      maxTokens: z.number()
        .min(100)
        .max(16000)
        .optional()
        .describe('Maximum response length'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.updateConfig(context.agentId, {
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });

      return {
        success: true,
        data: {
          message: `Model changed to ${input.model}`,
          newConfig: {
            model: input.model,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
          },
        },
      };
    },
  }),

  // Manual tool for UI-based model selection
  defineManualTool({
    name: 'request_model_selection',
    description: 'Open a model selector UI showing ALL available models from all providers. The user will pick their preferred model.',
    toolset: 'models',
    platforms: ['admin-ui'], // Only available in admin UI
    inputSchema: z.object({
      preferredFamily: z.string()
        .optional()
        .describe('Optional filter to show only models from a specific provider (e.g., "anthropic", "openai"). Leave empty to show all models.'),
    }),
  }),
];

export default createModelTools;
