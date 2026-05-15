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
export const MODEL_PRICING: Record<string, ModelPricing> = {};

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
