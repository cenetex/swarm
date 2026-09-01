import bs58 from 'bs58';
import { API_BASE } from '../api/apiBase';

type Fetch = typeof fetch;

export type HostedWalletLinkResponse = {
  linked: true;
  status: 'linked' | 'already-linked';
  walletAddress: string;
};

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}

export async function linkHostedWallet(input: {
  walletAddress: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  fetchImpl?: Fetch;
}): Promise<HostedWalletLinkResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const challengeResponse = await fetchImpl(`${API_BASE}/auth/wallet/link/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: input.walletAddress }),
  });
  if (!challengeResponse.ok) {
    throw await errorFromResponse(challengeResponse, 'Unable to create a wallet-link challenge.');
  }
  const challenge = await challengeResponse.json() as { nonce?: unknown; message?: unknown };
  if (typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') {
    throw new Error('Hosted wallet-link challenge response is invalid.');
  }

  const signature = await input.signMessage(new TextEncoder().encode(challenge.message));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new Error('Wallet did not return a valid Solana signature.');
  }
  const verifyResponse = await fetchImpl(`${API_BASE}/auth/wallet/link/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      nonce: challenge.nonce,
      signature: bs58.encode(signature),
    }),
  });
  if (!verifyResponse.ok) throw await errorFromResponse(verifyResponse, 'Wallet linking failed.');
  const result = await verifyResponse.json() as Partial<HostedWalletLinkResponse>;
  if (
    result.linked !== true
    || (result.status !== 'linked' && result.status !== 'already-linked')
    || result.walletAddress !== input.walletAddress
  ) {
    throw new Error('Hosted wallet-link response is invalid.');
  }
  return result as HostedWalletLinkResponse;
}
