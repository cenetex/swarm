import { describe, expect, it, vi } from 'vitest';
import { signInWithHostedWallet } from './hosted-wallet-sign-in';

describe('signInWithHostedWallet', () => {
  it('signs the server challenge and establishes a cookie-backed session', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) return Response.json({ nonce: 'nonce-1', message: 'Sign this exact message' });
      return Response.json({
        authenticated: true,
        account: {
          accountId: 'acct-1',
          role: 'user',
          identities: [{ type: 'wallet', providerId: 'wallet-1' }],
        },
        user: { walletAddress: 'wallet-1' },
      });
    }) as typeof fetch;
    const signMessage = vi.fn(async () => new Uint8Array(64).fill(4));

    const session = await signInWithHostedWallet({
      walletAddress: 'wallet-1',
      signMessage,
      fetchImpl,
    });

    expect(session.account.accountId).toBe('acct-1');
    expect(signMessage).toHaveBeenCalledWith(new TextEncoder().encode('Sign this exact message'));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.credentials).toBe('include');
    expect(requests[1]?.init?.credentials).toBe('include');
    expect(String(requests[1]?.init?.body)).not.toContain('Sign this exact message');
  });

  it('surfaces a safe server error', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'Too many wallet challenges. Try again shortly.' }, { status: 429 }),
    ) as typeof fetch;

    await expect(
      signInWithHostedWallet({
        walletAddress: 'wallet-1',
        signMessage: async () => new Uint8Array(64),
        fetchImpl,
      }),
    ).rejects.toThrow(/too many wallet challenges/i);
  });
});
