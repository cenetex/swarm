import { describe, expect, it, vi } from 'vitest';
import { linkHostedWallet } from './hosted-wallet-link';

describe('linkHostedWallet', () => {
  it('signs the domain-bound challenge and links the wallet', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) {
        return Response.json({ nonce: 'link-nonce', message: 'Link this exact wallet' });
      }
      return Response.json({ linked: true, status: 'linked', walletAddress: 'wallet-2' });
    }) as typeof fetch;
    const signMessage = vi.fn(async () => new Uint8Array(64).fill(7));

    await expect(linkHostedWallet({
      walletAddress: 'wallet-2',
      signMessage,
      fetchImpl,
    })).resolves.toMatchObject({ status: 'linked', walletAddress: 'wallet-2' });

    expect(signMessage).toHaveBeenCalledWith(new TextEncoder().encode('Link this exact wallet'));
    expect(requests[0]?.url).toMatch(/\/auth\/wallet\/link\/challenge$/u);
    expect(requests[1]?.url).toMatch(/\/auth\/wallet\/link\/verify$/u);
    expect(requests.every(({ init }) => init?.credentials === 'include')).toBe(true);
    expect(String(requests[1]?.init?.body)).not.toContain('Link this exact wallet');
  });

  it('surfaces cross-account conflicts without signing again', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ nonce: 'link-nonce', message: 'Link this exact wallet' }))
      .mockResolvedValueOnce(Response.json(
        { error: 'This wallet belongs to a different hosted account.' },
        { status: 409 },
      )) as typeof fetch;

    await expect(linkHostedWallet({
      walletAddress: 'wallet-2',
      signMessage: async () => new Uint8Array(64),
      fetchImpl,
    })).rejects.toThrow(/different hosted account/i);
  });
});
