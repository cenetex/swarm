import { describe, expect, it, vi } from 'vitest';
import {
  approveMobileWalletPairing,
  phantomBrowseUrl,
  solflareBrowseUrl,
  startMobileWalletPairing,
} from './mobile-wallet-pairing';

describe('mobile wallet pairing client', () => {
  it('builds official Phantom and Solflare in-app browser links', () => {
    const target = 'https://swarm.example/mobile-sign-in?pairing=pair_123';
    const phantom = new URL(phantomBrowseUrl(target));
    const solflare = new URL(solflareBrowseUrl(target));

    expect(phantom.origin).toBe('https://phantom.app');
    expect(decodeURIComponent(phantom.pathname.replace('/ul/browse/', ''))).toBe(target);
    expect(phantom.searchParams.get('ref')).toBe('https://swarm.example');
    expect(solflare.origin).toBe('https://solflare.com');
    expect(decodeURIComponent(solflare.pathname.replace('/ul/v1/browse/', ''))).toBe(target);
    expect(solflare.searchParams.has('url')).toBe(false);
    expect(solflare.searchParams.get('ref')).toBe('https://swarm.example');
  });

  it('keeps the desktop poll token out of the mobile URL', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      pairingId: 'pairing-id-abcdefghijklmnopqrstuvwxyz',
      pollToken: 'desktop-only-poll-token-abcdefghijklmnopqrstuvwxyz',
      mobileUrl: 'https://swarm.example/mobile-sign-in?pairing=pairing-id-abcdefghijklmnopqrstuvwxyz',
      verificationCode: 'PAIRIN',
      expiresAt: Date.now() + 300_000,
    }, { status: 201 })) as unknown as typeof fetch;

    const pairing = await startMobileWalletPairing(fetchImpl);

    expect(pairing.mobileUrl).not.toContain(pairing.pollToken);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/mobile\/start$/u), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
  });

  it('signs the pairing challenge and sends the signature only to Swarm', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ nonce: 'nonce-1', message: 'Approve this login' }))
      .mockResolvedValueOnce(Response.json({ success: true, status: 'approved' })) as unknown as typeof fetch;
    const signMessage = vi.fn(async () => new Uint8Array(64).fill(7));

    await approveMobileWalletPairing({
      pairingId: 'pairing-id-abcdefghijklmnopqrstuvwxyz',
      walletAddress: 'wallet-address',
      signMessage,
      fetchImpl,
    });

    expect(signMessage).toHaveBeenCalledWith(new TextEncoder().encode('Approve this login'));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/auth\/mobile\/pairing-id-abcdefghijklmnopqrstuvwxyz\/verify$/u),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
