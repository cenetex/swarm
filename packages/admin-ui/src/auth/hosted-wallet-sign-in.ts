import bs58 from 'bs58';
import { API_BASE } from '../api/apiBase';

type Fetch = typeof fetch;

export type HostedWalletSessionResponse = {
  authenticated: true;
  account: {
    accountId: string;
    role: 'user' | 'admin';
    identities: Array<{ type: 'wallet' | 'privy'; providerId: string }>;
  };
  user: {
    walletAddress: string;
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  };
};

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}

export async function signInWithHostedWallet(input: {
  walletAddress: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  fetchImpl?: Fetch;
}): Promise<HostedWalletSessionResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const challengeResponse = await fetchImpl(`${API_BASE}/auth/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: input.walletAddress }),
  });
  if (!challengeResponse.ok) throw await errorFromResponse(challengeResponse, 'Unable to create wallet challenge.');
  const challenge = (await challengeResponse.json()) as { nonce?: unknown; message?: unknown };
  if (typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') {
    throw new Error('Hosted wallet challenge response is invalid.');
  }

  const signature = await input.signMessage(new TextEncoder().encode(challenge.message));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new Error('Wallet did not return a valid Solana signature.');
  }
  const verifyResponse = await fetchImpl(`${API_BASE}/auth/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: input.walletAddress,
      nonce: challenge.nonce,
      signature: bs58.encode(signature),
    }),
  });
  if (!verifyResponse.ok) throw await errorFromResponse(verifyResponse, 'Wallet sign-in failed.');
  const session = (await verifyResponse.json()) as HostedWalletSessionResponse;
  if (!session.authenticated || !session.account?.accountId || !session.user?.walletAddress) {
    throw new Error('Hosted wallet session response is invalid.');
  }
  return session;
}
