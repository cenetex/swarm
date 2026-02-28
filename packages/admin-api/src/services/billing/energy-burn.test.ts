import { describe, expect, it } from 'vitest';

import { quoteBurnToEnergy } from './energy-burn.js';

describe('energy-burn.quoteBurnToEnergy', () => {
  it('computes credits and burn amount with decimals', () => {
    // 9 decimals, 100 tokens per credit.
    // available = 250 tokens => 2 credits, burn 200 tokens.
    const unit = 10n ** 9n;
    const available = 250n * unit;

    const quote = quoteBurnToEnergy({
      mint: 'mint1',
      decimals: 9,
      availableAmountRaw: available,
      tokensPerEnergyCredit: 100,
    });

    expect(quote.energyCredits).toBe(2);
    expect(quote.burnAmountRaw).toBe(200n * unit);
    expect(quote.remainderRaw).toBe(50n * unit);
  });

  it('returns zero credits when below threshold', () => {
    const unit = 10n ** 6n;
    const available = 99n * unit;

    const quote = quoteBurnToEnergy({
      mint: 'mint1',
      decimals: 6,
      availableAmountRaw: available,
      tokensPerEnergyCredit: 100,
    });

    expect(quote.energyCredits).toBe(0);
    expect(quote.burnAmountRaw).toBe(0n);
    expect(quote.remainderRaw).toBe(available);
  });
});
