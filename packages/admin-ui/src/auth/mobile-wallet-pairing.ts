import bs58 from 'bs58';
import { API_BASE } from '../api/apiBase';
import type { HostedWalletSessionResponse } from './hosted-wallet-sign-in';

type Fetch = typeof fetch;

export type MobileWalletPairing = {
  pairingId: string;
  pollToken: string;
  mobileUrl: string;
  verificationCode: string;
  expiresAt: number;
};

export type MobileWalletPairingPoll =
  | { status: 'pending'; expiresAt: number }
  | HostedWalletSessionResponse;

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown; status?: unknown } | null;
  const detail = typeof body?.error === 'string'
    ? body.error
    : body?.status === 'expired'
      ? 'This QR code expired. Start again on your computer.'
      : fallback;
  return new Error(detail);
}

export async function startMobileWalletPairing(fetchImpl: Fetch = fetch): Promise<MobileWalletPairing> {
  const response = await fetchImpl(`${API_BASE}/auth/mobile/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw await responseError(response, 'Unable to start mobile wallet sign-in.');
  const pairing = await response.json() as Partial<MobileWalletPairing>;
  if (
    !pairing.pairingId
    || !pairing.pollToken
    || !pairing.mobileUrl
    || !pairing.verificationCode
    || typeof pairing.expiresAt !== 'number'
  ) {
    throw new Error('Mobile wallet pairing response is invalid.');
  }
  return pairing as MobileWalletPairing;
}

export async function pollMobileWalletPairing(
  pairing: Pick<MobileWalletPairing, 'pairingId' | 'pollToken'>,
  fetchImpl: Fetch = fetch,
): Promise<MobileWalletPairingPoll> {
  const response = await fetchImpl(`${API_BASE}/auth/mobile/${encodeURIComponent(pairing.pairingId)}`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${pairing.pollToken}` },
  });
  if (response.status === 202) return response.json() as Promise<{ status: 'pending'; expiresAt: number }>;
  if (!response.ok) throw await responseError(response, 'Unable to finish mobile wallet sign-in.');
  const session = await response.json() as HostedWalletSessionResponse;
  if (!session.authenticated || !session.account?.accountId || !session.user?.walletAddress) {
    throw new Error('Mobile wallet session response is invalid.');
  }
  return session;
}

export async function approveMobileWalletPairing(input: {
  pairingId: string;
  walletAddress: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  fetchImpl?: Fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const path = `${API_BASE}/auth/mobile/${encodeURIComponent(input.pairingId)}`;
  const challengeResponse = await fetchImpl(`${path}/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: input.walletAddress }),
  });
  if (!challengeResponse.ok) {
    throw await responseError(challengeResponse, 'Unable to create the mobile sign-in request.');
  }
  const challenge = await challengeResponse.json() as { nonce?: unknown; message?: unknown };
  if (typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') {
    throw new Error('Mobile wallet challenge response is invalid.');
  }
  const signature = await input.signMessage(new TextEncoder().encode(challenge.message));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new Error('Wallet did not return a valid Solana signature.');
  }
  const verifyResponse = await fetchImpl(`${path}/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      nonce: challenge.nonce,
      signature: bs58.encode(signature),
    }),
  });
  if (!verifyResponse.ok) {
    throw await responseError(verifyResponse, 'The mobile wallet approval was rejected.');
  }
}

export function phantomBrowseUrl(targetUrl: string): string {
  const target = new URL(targetUrl);
  return `https://phantom.app/ul/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(target.origin)}`;
}

export function solflareBrowseUrl(targetUrl: string): string {
  const target = new URL(targetUrl);
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(target.origin)}`;
}
