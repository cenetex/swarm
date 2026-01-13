/**
 * LLM Model management tools
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

// Type for model info from OpenRouter
interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
  };
}

/**
 * List available models from OpenRouter
 */
export const listAvailableModels = (
  fetchModels: (family?: string) => Promise<OpenRouterModel[]>
) => tool({
  name: 'list_available_models',
  description: 'List available LLM models from OpenRouter that I can switch to. Returns model IDs, names, pricing, and context lengths.',
  inputSchema: z.object({
    family: z.string().optional().describe('Filter by model family (e.g., "anthropic", "openai", "google", "meta-llama"). Leave empty for all.'),
  }),
  execute: async ({ family }) => {
    const models = await fetchModels(family);
    return {
      models: models.slice(0, 20).map(m => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        pricing: {
          prompt: m.pricing.prompt,
          completion: m.pricing.completion,
        },
        maxOutput: m.top_provider?.max_completion_tokens,
      })),
      total: models.length,
      showing: Math.min(20, models.length),
    };
  },
});

/**
 * Change LLM model or settings
 */
export const changeMyModel = (
  _agentId: string,
  updateConfig: (config: { model?: string; temperature?: number; maxTokens?: number }) => Promise<void>
) => tool({
  name: 'change_my_model',
  description: 'Change my LLM model or settings. Use list_available_models first to see options.',
  inputSchema: z.object({
    model: z.string().optional().describe('Model ID from OpenRouter (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o")'),
    temperature: z.number().min(0).max(2).optional().describe('Temperature (0.0-2.0). Lower = more focused, higher = more creative.'),
    maxTokens: z.number().optional().describe('Maximum response tokens (e.g., 1024, 4096)'),
  }),
  execute: async (params) => {
    if (!params.model && params.temperature === undefined && params.maxTokens === undefined) {
      return { error: 'Please specify at least one setting to change (model, temperature, or maxTokens)' };
    }
    await updateConfig(params);
    return {
      success: true,
      message: 'Model configuration updated',
      updated: {
        ...(params.model && { model: params.model }),
        ...(params.temperature !== undefined && { temperature: params.temperature }),
        ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
      },
    };
  },
});

/**
 * Request model selection (manual - shows dropdown in UI)
 */
export const requestModelSelection = tool({
  name: 'request_model_selection',
  description: 'Show the user a dropdown to select a model. Use this when the user wants to choose interactively.',
  inputSchema: z.object({
    family: z.string().optional().describe('Pre-filter by family (e.g., "anthropic", "openai"). Leave empty to show all.'),
    preferredFamily: z.string().optional().describe('Alias for family; use if you have a preferred provider.'),
    currentModel: z.string().optional().describe('Current model ID to show as selected'),
  }),
  execute: false, // Manual - needs user interaction
});
