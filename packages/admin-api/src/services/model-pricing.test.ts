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
  it('returns known pricing for a registered model', () => {
    const result = getModelPricing('anthropic/claude-3-5-sonnet-latest');
    expect(result.isDefault).toBe(false);
    expect(result.pricing.inputMicroUsdPerToken).toBe(3);
    expect(result.pricing.outputMicroUsdPerToken).toBe(15);
  });

  it('returns default pricing for an unknown model', () => {
    const result = getModelPricing('unknown/model-xyz');
    expect(result.isDefault).toBe(true);
    expect(result.pricing).toEqual(DEFAULT_PRICING);
  });

  it('has pricing entries for all major model families', () => {
    const families = ['anthropic/', 'openai/', 'deepseek/'];
    for (const family of families) {
      const models = Object.keys(MODEL_PRICING).filter(k => k.startsWith(family));
      expect(models.length).toBeGreaterThan(0);
    }
  });
});

describe('calculateCostMicroUsd', () => {
  it('calculates cost correctly for a known model', () => {
    // Claude 3.5 Sonnet: input 3 micro-USD/token, output 15 micro-USD/token
    const cost = calculateCostMicroUsd(
      'anthropic/claude-3-5-sonnet-latest',
      1000, // prompt tokens
      500,  // completion tokens
    );

    expect(cost.inputCostMicroUsd).toBe(3000);  // 1000 * 3
    expect(cost.outputCostMicroUsd).toBe(7500);  // 500 * 15
    expect(cost.totalCostMicroUsd).toBe(10500);  // 3000 + 7500
    expect(cost.pricingVersion).toBe(PRICING_VERSION);
  });

  it('uses default pricing for unknown models', () => {
    const cost = calculateCostMicroUsd('unknown/model', 100, 50);
    expect(cost.inputCostMicroUsd).toBe(Math.round(100 * DEFAULT_PRICING.inputMicroUsdPerToken));
    expect(cost.outputCostMicroUsd).toBe(Math.round(50 * DEFAULT_PRICING.outputMicroUsdPerToken));
  });

  it('handles zero tokens', () => {
    const cost = calculateCostMicroUsd('anthropic/claude-3-5-sonnet-latest', 0, 0);
    expect(cost.inputCostMicroUsd).toBe(0);
    expect(cost.outputCostMicroUsd).toBe(0);
    expect(cost.totalCostMicroUsd).toBe(0);
  });

  it('rounds to integer micro-USD', () => {
    // GPT-4o-mini: input 0.15 micro-USD/token
    const cost = calculateCostMicroUsd('openai/gpt-4o-mini', 7, 3);
    // 7 * 0.15 = 1.05, rounds to 1
    expect(Number.isInteger(cost.inputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.outputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.totalCostMicroUsd)).toBe(true);
  });
});
