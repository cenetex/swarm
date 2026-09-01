import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { API_BASE } from '../api/apiBase';
import type { HostedWalletSessionResponse } from './hosted-wallet-sign-in';

type Fetch = typeof fetch;

type RegistrationStarter = (options: {
  optionsJSON: PublicKeyCredentialCreationOptionsJSON;
}) => Promise<RegistrationResponseJSON>;

type AuthenticationStarter = (options: {
  optionsJSON: PublicKeyCredentialRequestOptionsJSON;
}) => Promise<AuthenticationResponseJSON>;

type PasskeyStart<T> = {
  challengeId: string;
  options: T;
};

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}
async function postJson(fetchImpl: Fetch, path: string, body?: unknown): Promise<Response> {
  return fetchImpl(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function passkeyStart<T>(value: unknown): PasskeyStart<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Passkey challenge response is invalid.');
  }
  const start = value as { challengeId?: unknown; options?: unknown };
  if (typeof start.challengeId !== 'string' || !start.options || typeof start.options !== 'object') {
    throw new Error('Passkey challenge response is invalid.');
  }
  return start as PasskeyStart<T>;
}

export function supportsPasskeys(): boolean {
  return browserSupportsWebAuthn();
}

export async function registerHostedPasskey(input: {
  fetchImpl?: Fetch;
  startRegistrationImpl?: RegistrationStarter;
} = {}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const optionsResponse = await postJson(fetchImpl, '/auth/passkey/register/options');
  if (!optionsResponse.ok) throw await errorFromResponse(optionsResponse, 'Unable to start passkey setup.');
  const start = passkeyStart<PublicKeyCredentialCreationOptionsJSON>(await optionsResponse.json());
  const response = await (input.startRegistrationImpl ?? startRegistration)({ optionsJSON: start.options });
  const verifyResponse = await postJson(fetchImpl, '/auth/passkey/register/verify', {
    challengeId: start.challengeId,
    response,
  });
  if (!verifyResponse.ok) throw await errorFromResponse(verifyResponse, 'Passkey setup failed.');
  const result = (await verifyResponse.json()) as { verified?: unknown };
  if (result.verified !== true) throw new Error('Passkey setup response is invalid.');
}

export async function signInWithHostedPasskey(input: {
  fetchImpl?: Fetch;
  startAuthenticationImpl?: AuthenticationStarter;
} = {}): Promise<HostedWalletSessionResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const optionsResponse = await postJson(fetchImpl, '/auth/passkey/authenticate/options');
  if (!optionsResponse.ok) throw await errorFromResponse(optionsResponse, 'Unable to start passkey sign-in.');
  const start = passkeyStart<PublicKeyCredentialRequestOptionsJSON>(await optionsResponse.json());
  const response = await (input.startAuthenticationImpl ?? startAuthentication)({ optionsJSON: start.options });
  const verifyResponse = await postJson(fetchImpl, '/auth/passkey/authenticate/verify', {
    challengeId: start.challengeId,
    response,
  });
  if (!verifyResponse.ok) throw await errorFromResponse(verifyResponse, 'Passkey sign-in failed.');
  const session = (await verifyResponse.json()) as HostedWalletSessionResponse;
  if (!session.authenticated || !session.account?.accountId || !session.user?.walletAddress) {
    throw new Error('Hosted passkey session response is invalid.');
  }
  return session;
}
