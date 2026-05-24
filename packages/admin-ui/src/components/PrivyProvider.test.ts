import { describe, it, expect } from 'vitest';
import { buildPrivyConfig } from './PrivyProvider.js';

describe('PrivyProvider config', () => {
  it('sets Solana defaults for wallets', async () => {
    const config = await buildPrivyConfig({ hostname: 'swarm.rati.chat' });

    expect(config.loginMethods).toEqual(['wallet', 'email', 'google', 'twitter']);
    expect(config.appearance?.showWalletLoginFirst).toBe(true);
    expect(config.appearance?.walletList?.[0]).toBe('phantom');
    expect(config.appearance?.walletList).toContain('detected_solana_wallets');
    expect(config.embeddedWallets?.solana?.createOnLogin).toBe('users-without-wallets');
    expect(config.defaultChain).toBeUndefined();
    expect(config.supportedChains).toBeUndefined();
  });
});

