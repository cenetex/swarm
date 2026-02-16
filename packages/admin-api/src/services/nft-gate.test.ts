import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkNFTGate, _resetNftGateForTesting } from './nft-gate.js';

const prevEnv = process.env.ENVIRONMENT;
const prevHeliusApiKey = process.env.HELIUS_API_KEY;
const prevHeliusApiKeyArn = process.env.HELIUS_API_KEY_ARN;
const prevDisableGate = process.env.DISABLE_NFT_GATE;
const prevAdminTable = process.env.ADMIN_TABLE;

function restoreEnvVar(key: string, value: string | undefined) {
  if (value === undefined) {
    delete (process.env as any)[key];
  } else {
    (process.env as any)[key] = value;
  }
}

describe('nft-gate (Helius config fallbacks)', () => {
  beforeEach(() => {
    process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'test-admin-table';
    delete process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY_ARN;
    delete process.env.DISABLE_NFT_GATE;
    delete process.env.ENVIRONMENT;
    // Reset cached module-level Helius state so env var changes take effect
    _resetNftGateForTesting();
  });

  afterEach(() => {
    restoreEnvVar('ENVIRONMENT', prevEnv);
    restoreEnvVar('HELIUS_API_KEY', prevHeliusApiKey);
    restoreEnvVar('HELIUS_API_KEY_ARN', prevHeliusApiKeyArn);
    restoreEnvVar('DISABLE_NFT_GATE', prevDisableGate);
    restoreEnvVar('ADMIN_TABLE', prevAdminTable);
    // Restore cached state to match restored env vars
    _resetNftGateForTesting();
  });

  it('fails closed (0 Orbs) in prod-like env when Helius key missing', async () => {
    process.env.ENVIRONMENT = 'prod';

    const res = await checkNFTGate('wallet-1');
    expect(res.allowed).toBe(false);
    expect(res.ownedCount).toBe(0);
    expect(res.error).toBe('Helius API key not configured');
  });

  it('bypasses (999 Orbs) in dev-like env when Helius key missing', async () => {
    process.env.ENVIRONMENT = 'dev';

    const res = await checkNFTGate('wallet-1');
    expect(res.allowed).toBe(true);
    expect(res.ownedCount).toBe(999);
  });

  it('bypasses when DISABLE_NFT_GATE=true even in prod', async () => {
    process.env.ENVIRONMENT = 'prod';
    process.env.DISABLE_NFT_GATE = 'true';

    const res = await checkNFTGate('wallet-1');
    expect(res.allowed).toBe(true);
    expect(res.ownedCount).toBe(999);
  });
});
