import { describe, expect, it, vi } from 'vitest';
import { registerHostedPasskey, signInWithHostedPasskey } from './hosted-passkeys';

const registrationResponse = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'client', attestationObject: 'attestation' },
} as const;

const authenticationResponse = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: 'client',
    authenticatorData: 'authenticator',
    signature: 'signature',
    userHandle: 'user-1',
  },
} as const;

describe('hosted passkeys client', () => {
  it('registers a passkey with a server-issued one-use challenge handle', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challengeId: 'challenge-handle',
        options: { challenge: 'challenge', rp: { id: 'swarm.example', name: 'Swarm Hosted' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true }), { status: 201 }));
    const startRegistrationImpl = vi.fn().mockResolvedValue(registrationResponse);

    await registerHostedPasskey({ fetchImpl, startRegistrationImpl });

    expect(startRegistrationImpl).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ challenge: 'challenge' }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/auth\/passkey\/register\/verify$/u),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ challengeId: 'challenge-handle', response: registrationResponse }),
      }),
    );
  });

  it('signs in with a discoverable credential and returns the cookie-backed session', async () => {
    const session = {
      authenticated: true as const,
      authProvider: 'passkey' as const,
      account: { accountId: 'acct-1', role: 'user' as const, identities: [] },
      user: { walletAddress: 'wallet-1' },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challengeId: 'challenge-handle',
        options: { challenge: 'challenge', rpId: 'swarm.example', userVerification: 'required' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }));
    const startAuthenticationImpl = vi.fn().mockResolvedValue(authenticationResponse);

    await expect(signInWithHostedPasskey({ fetchImpl, startAuthenticationImpl })).resolves.toEqual(session);
    expect(startAuthenticationImpl).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ userVerification: 'required' }),
    });
  });

  it('uses the safe server error when verification fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challengeId: 'challenge-handle',
        options: { challenge: 'challenge' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Passkey sign-in is invalid or expired.' }), {
        status: 401,
      }));

    await expect(signInWithHostedPasskey({
      fetchImpl,
      startAuthenticationImpl: vi.fn().mockResolvedValue(authenticationResponse),
    })).rejects.toThrow('Passkey sign-in is invalid or expired.');
  });
});
