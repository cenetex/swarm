/**
 * Tests for model-pricing service.
 */
import { describe, it, expect } from 'vitest';
import {
  getModelPricing,
  calculateCostMicroUsd,
  MODEL_PRICING,
  DEFAULT_PRICING,
  PRICING_VERSION,
} from './model-pricing.js';

describe('getModelPricing', () => {
  it('returns default pricing when no live pricing has been attached', () => {
    const result = getModelPricing('provider/live-model');
    expect(result.isDefault).toBe(true);
    expect(result.pricing).toEqual(DEFAULT_PRICING);
  });

  it('does not hard-code OpenRouter model IDs in the pricing registry', () => {
    expect(Object.keys(MODEL_PRICING)).toEqual([]);
  });
});

describe('calculateCostMicroUsd', () => {
  it('calculates cost using default pricing for live OpenRouter models', () => {
    const cost = calculateCostMicroUsd(
      'provider/live-model',
      1000, // prompt tokens
      500,  // completion tokens
    );

    expect(cost.inputCostMicroUsd).toBe(Math.round(1000 * DEFAULT_PRICING.inputMicroUsdPerToken));
    expect(cost.outputCostMicroUsd).toBe(Math.round(500 * DEFAULT_PRICING.outputMicroUsdPerToken));
    expect(cost.totalCostMicroUsd).toBe(cost.inputCostMicroUsd + cost.outputCostMicroUsd);
    expect(cost.pricingVersion).toBe(PRICING_VERSION);
  });

  it('uses default pricing for unknown models', () => {
    const cost = calculateCostMicroUsd('unknown/model', 100, 50);
    expect(cost.inputCostMicroUsd).toBe(Math.round(100 * DEFAULT_PRICING.inputMicroUsdPerToken));
    expect(cost.outputCostMicroUsd).toBe(Math.round(50 * DEFAULT_PRICING.outputMicroUsdPerToken));
  });

  it('handles zero tokens', () => {
    const cost = calculateCostMicroUsd('provider/live-model', 0, 0);
    expect(cost.inputCostMicroUsd).toBe(0);
    expect(cost.outputCostMicroUsd).toBe(0);
    expect(cost.totalCostMicroUsd).toBe(0);
  });

  it('rounds to integer micro-USD', () => {
    const cost = calculateCostMicroUsd('provider/live-model', 7, 3);
    expect(Number.isInteger(cost.inputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.outputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.totalCostMicroUsd)).toBe(true);
  });
});
