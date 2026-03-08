import { describe, it, expect } from 'vitest';
import { getAccountGateStatus } from './account-gate.js';

function gateStatus(availableSlots: number, nftsHeld: number) {
  return {
    nftsHeld,
    avatarsCreated: 0,
    availableSlots,
    canCreate: availableSlots > 0,
    canAbandon: true,
  };
}

describe('account-gate', () => {
  it('returns nulls when account has no linked wallets', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({ accountId: 'acct-1', role: 'user', identities: [{ type: 'privy', providerId: 'privy-1' }] }),
      getGateStatus: async () => gateStatus(0, 0) as any,
    });

    expect(result.gateWallet).toBe(null);
    expect(result.gateStatus).toBe(null);
    expect(result.gateStatusByWallet).toEqual({});
  });

  it('dedupes wallets and picks best by availableSlots then nftsHeld', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({
        accountId: 'acct-1',
        role: 'user',
        identities: [
          { type: 'wallet', providerId: 'w1' },
          { type: 'wallet', providerId: 'w1' },
          { type: 'wallet', providerId: 'w2' },
          { type: 'wallet', providerId: 'w3' },
        ],
      }),
      getGateStatus: async (wallet: string) => {
        if (wallet === 'w1') return gateStatus(0, 10) as any;
        if (wallet === 'w2') return gateStatus(2, 0) as any;
        return gateStatus(2, 5) as any;
      },
    });

    // w3 and w2 tie on availableSlots=2; w3 wins on nftsHeld=5
    expect(result.gateWallet).toBe('w3');
    expect(result.gateStatus?.availableSlots).toBe(2);
    expect(Object.keys(result.gateStatusByWallet).sort()).toEqual(['w1', 'w2', 'w3']);
  });

  it('returns per-wallet statuses independently (no cross-wallet aggregation)', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({
        accountId: 'acct-1',
        role: 'user',
        identities: [
          { type: 'wallet', providerId: 'walletA' },
          { type: 'wallet', providerId: 'walletB' },
        ],
      }),
      getGateStatus: async (wallet: string) => {
        // walletA holds 3 NFTs with 2 available slots
        if (wallet === 'walletA') return gateStatus(2, 3) as any;
        // walletB holds 1 NFT with 1 available slot
        return gateStatus(1, 1) as any;
      },
    });

    // Per-wallet statuses should reflect each wallet independently
    expect(result.gateStatusByWallet['walletA'].availableSlots).toBe(2);
    expect(result.gateStatusByWallet['walletA'].nftsHeld).toBe(3);
    expect(result.gateStatusByWallet['walletB'].availableSlots).toBe(1);
    expect(result.gateStatusByWallet['walletB'].nftsHeld).toBe(1);

    // Best wallet is walletA (most availableSlots), NOT an aggregation
    expect(result.gateWallet).toBe('walletA');
    expect(result.gateStatus?.availableSlots).toBe(2);
    // Crucially: the "account-level" status is NOT 3 (2+1 aggregated),
    // it is 2 (the best single wallet's slots)
    expect(result.gateStatus?.availableSlots).not.toBe(3);
  });

  it('selects best wallet by availableSlots not by summing across wallets', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({
        accountId: 'acct-1',
        role: 'user',
        identities: [
          { type: 'wallet', providerId: 'w1' },
          { type: 'wallet', providerId: 'w2' },
          { type: 'wallet', providerId: 'w3' },
        ],
      }),
      getGateStatus: async (wallet: string) => {
        // Each wallet has 1 slot; an aggregation would give 3 total
        if (wallet === 'w1') return gateStatus(1, 1) as any;
        if (wallet === 'w2') return gateStatus(1, 2) as any;
        return gateStatus(1, 0) as any;
      },
    });

    // Best wallet is w2 (tied on slots=1, wins on nftsHeld=2)
    expect(result.gateWallet).toBe('w2');
    // The returned status has 1 slot, not 3 (would be 3 if aggregated)
    expect(result.gateStatus?.availableSlots).toBe(1);
  });

  it('handles single wallet account correctly', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({
        accountId: 'acct-1',
        role: 'user',
        identities: [
          { type: 'wallet', providerId: 'onlyWallet' },
        ],
      }),
      getGateStatus: async () => gateStatus(3, 5) as any,
    });

    expect(result.gateWallet).toBe('onlyWallet');
    expect(result.gateStatus?.availableSlots).toBe(3);
    expect(result.gateStatus?.nftsHeld).toBe(5);
    expect(Object.keys(result.gateStatusByWallet)).toEqual(['onlyWallet']);
  });
});
