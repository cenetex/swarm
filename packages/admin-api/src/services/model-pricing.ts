/**
 * Model Pricing Configuration
 *
 * Provides per-model pricing in micro-USD (1 micro-USD = $0.000001) for cost estimation.
 * Prices are sourced from provider pricing pages and versioned for auditability.
 *
 * micro-USD is used to avoid floating-point precision issues while keeping
 * numbers small enough for DynamoDB number types (max 38 digits).
 *
 * Example: Claude 3.5 Sonnet input @ $3/1M tokens = 3 micro-USD per token
 */

/**
 * Pricing entry for a model, in micro-USD per token.
 */
export interface ModelPricing {
  /** micro-USD per input/prompt token */
  inputMicroUsdPerToken: number;
  /** micro-USD per output/completion token */
  outputMicroUsdPerToken: number;
  /** When this pricing was last updated (ISO 8601) */
  updatedAt: string;
  /** Source of the pricing data */
  source: string;
}

/**
 * Pricing version — bump when pricing data changes so downstream
 * consumers can detect stale cost estimates.
 */
export const PRICING_VERSION = 1;

/**
 * Model pricing registry.
 *
 * Prices in micro-USD per token.
 * 1 USD = 1,000,000 micro-USD
 *
 * To convert from $/1M tokens to micro-USD/token:
 *   micro-USD/token = ($/1M tokens)
 *
 * Example: $3.00 per 1M tokens = 3 micro-USD per token
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // -------------------------------------------------------------------------
  // Anthropic (via OpenRouter)
  // -------------------------------------------------------------------------
  'anthropic/claude-sonnet-4.5': {
    inputMicroUsdPerToken: 3,
    outputMicroUsdPerToken: 15,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-sonnet-4': {
    inputMicroUsdPerToken: 3,
    outputMicroUsdPerToken: 15,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-opus-4.5': {
    inputMicroUsdPerToken: 15,
    outputMicroUsdPerToken: 75,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-3-5-sonnet-latest': {
    inputMicroUsdPerToken: 3,
    outputMicroUsdPerToken: 15,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-3-opus-latest': {
    inputMicroUsdPerToken: 15,
    outputMicroUsdPerToken: 75,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-3-5-haiku-latest': {
    inputMicroUsdPerToken: 0.8,
    outputMicroUsdPerToken: 4,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'anthropic/claude-haiku-4': {
    inputMicroUsdPerToken: 0.8,
    outputMicroUsdPerToken: 4,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },

  // -------------------------------------------------------------------------
  // OpenAI (via OpenRouter)
  // -------------------------------------------------------------------------
  'openai/gpt-4o': {
    inputMicroUsdPerToken: 2.5,
    outputMicroUsdPerToken: 10,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'openai/gpt-4o-mini': {
    inputMicroUsdPerToken: 0.15,
    outputMicroUsdPerToken: 0.6,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'openai/gpt-4-turbo': {
    inputMicroUsdPerToken: 10,
    outputMicroUsdPerToken: 30,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'openai/gpt-5.1': {
    inputMicroUsdPerToken: 10,
    outputMicroUsdPerToken: 30,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },

  // -------------------------------------------------------------------------
  // DeepSeek (via OpenRouter)
  // -------------------------------------------------------------------------
  'deepseek/deepseek-r1': {
    inputMicroUsdPerToken: 0.55,
    outputMicroUsdPerToken: 2.19,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'deepseek/deepseek-v3.2': {
    inputMicroUsdPerToken: 0.27,
    outputMicroUsdPerToken: 1.1,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },

  // -------------------------------------------------------------------------
  // Other models (via OpenRouter)
  // -------------------------------------------------------------------------
  'minimax/minimax-01': {
    inputMicroUsdPerToken: 0.4,
    outputMicroUsdPerToken: 1.1,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'x-ai/grok-4': {
    inputMicroUsdPerToken: 3,
    outputMicroUsdPerToken: 15,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
  'google/gemini-3-pro-preview': {
    inputMicroUsdPerToken: 1.25,
    outputMicroUsdPerToken: 5,
    updatedAt: '2026-02-23',
    source: 'openrouter.ai',
  },
};

/**
 * Default pricing for unknown models (conservative estimate).
 * Uses mid-range pricing to avoid gross under- or over-estimation.
 */
export const DEFAULT_PRICING: ModelPricing = {
  inputMicroUsdPerToken: 3,
  outputMicroUsdPerToken: 15,
  updatedAt: '2026-02-23',
  source: 'default-estimate',
};

/**
 * Get pricing for a model, falling back to default if not in registry.
 */
export function getModelPricing(modelId: string): { pricing: ModelPricing; isDefault: boolean } {
  const pricing = MODEL_PRICING[modelId];
  if (pricing) {
    return { pricing, isDefault: false };
  }
  return { pricing: DEFAULT_PRICING, isDefault: true };
}

/**
 * Calculate cost in micro-USD given token counts and a model.
 */
export function calculateCostMicroUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): { inputCostMicroUsd: number; outputCostMicroUsd: number; totalCostMicroUsd: number; pricingVersion: number } {
  const { pricing } = getModelPricing(modelId);
  const inputCostMicroUsd = Math.round(promptTokens * pricing.inputMicroUsdPerToken);
  const outputCostMicroUsd = Math.round(completionTokens * pricing.outputMicroUsdPerToken);
  return {
    inputCostMicroUsd,
    outputCostMicroUsd,
    totalCostMicroUsd: inputCostMicroUsd + outputCostMicroUsd,
    pricingVersion: PRICING_VERSION,
  };
}
