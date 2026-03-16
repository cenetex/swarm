/**
 * GitHub App Token Provider Tests
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  GitHubAppTokenProvider,
  createAppJwt,
  _setSecretsClient,
} from './github-app-token.js';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Test RSA key pair (generated once, deterministic for tests)
// ---------------------------------------------------------------------------
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

// Preferred (new) credential shape
const TEST_CREDENTIALS_NEW = {
  clientId: 'Iv1.abc123def456',
  privateKey: TEST_PRIVATE_KEY,
};

// Legacy credential shape
const TEST_CREDENTIALS_LEGACY = {
  appId: '12345',
  privateKey: TEST_PRIVATE_KEY,
  installationId: '67890',
};

function makeSecretsClient(secretString: string) {
  const sendMock = mock(() =>
    Promise.resolve({ SecretString: secretString })
  );
  return { client: { send: sendMock } as any, sendMock };
}

function makeInstallationTokenResponse() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        token: 'ghs_test_installation_token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    text: () => Promise.resolve(''),
  };
}

function makeInstallationsListResponse(installations: Array<{ id: number; login: string }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve(
        installations.map(inst => ({
          id: inst.id,
          account: { login: inst.login },
        }))
      ),
    text: () => Promise.resolve(''),
  };
}

// ---------------------------------------------------------------------------
// createAppJwt
// ---------------------------------------------------------------------------

describe('createAppJwt', () => {
  it('produces a valid 3-part JWT', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS_LEGACY.appId, TEST_CREDENTIALS_LEGACY.privateKey);
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
  });

  it('has correct header', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS_LEGACY.appId, TEST_CREDENTIALS_LEGACY.privateKey);
    const [headerB64] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('uses the provided issuer as iss claim', () => {
    const jwt = createAppJwt('Iv1.abc123', TEST_CREDENTIALS_LEGACY.privateKey);
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.iss).toBe('Iv1.abc123');
  });

  it('has correct payload fields', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS_LEGACY.appId, TEST_CREDENTIALS_LEGACY.privateKey);
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    expect(payload.iss).toBe('12345');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp - payload.iat).toBe(660); // 600 + 60 backdate
  });

  it('signature is verifiable with the public key', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS_LEGACY.appId, TEST_CREDENTIALS_LEGACY.privateKey);
    const [header, payload, signature] = jwt.split('.');
    const signable = `${header}.${payload}`;

    const sigBuf = Buffer.from(signature, 'base64url');
    const verify = crypto.createVerify('SHA256');
    verify.update(signable);
    verify.end();

    expect(verify.verify(TEST_PUBLIC_KEY, sigBuf)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider — clientId + dynamic installation lookup
// ---------------------------------------------------------------------------

describe('GitHubAppTokenProvider (clientId + dynamic lookup)', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let fetchCalls: Array<{ url: string; options?: any }>;

  beforeEach(() => {
    fetchCalls = [];
    mockFetch = mock((url: string, options?: any) => {
      fetchCalls.push({ url, options });

      // Route: list installations
      if (url === 'https://api.github.com/app/installations') {
        return Promise.resolve(makeInstallationsListResponse([
          { id: 99999, login: 'cenetex' },
          { id: 11111, login: 'other-org' },
        ]));
      }

      // Route: exchange for token
      if (url.includes('/access_tokens')) {
        return Promise.resolve(makeInstallationTokenResponse());
      }

      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not Found') });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSecretsClient(null);
  });

  it('uses clientId as JWT issuer when available', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_NEW));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test', 'cenetex/aws-swarm');
    const token = await provider.getToken();

    expect(token).toBe('ghs_test_installation_token');

    // Verify the JWT uses clientId as issuer
    const installationsCall = fetchCalls.find(c => c.url.includes('/app/installations') && !c.url.includes('/access_tokens'));
    expect(installationsCall).toBeTruthy();
    const authHeader = installationsCall!.options?.headers?.['Authorization'] as string;
    const jwt = authHeader.replace('Bearer ', '');
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.iss).toBe('Iv1.abc123def456');
  });

  it('discovers installation ID dynamically from repo', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_NEW));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test', 'cenetex/aws-swarm');
    await provider.getToken();

    // Should have called list installations, then exchange with discovered ID
    const tokenExchangeCall = fetchCalls.find(c => c.url.includes('/access_tokens'));
    expect(tokenExchangeCall!.url).toBe(
      'https://api.github.com/app/installations/99999/access_tokens'
    );
  });

  it('caches the resolved installation ID on subsequent calls', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_NEW));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test', 'cenetex/aws-swarm');

    // Expire token immediately to force a second full cycle
    await provider.getToken();

    // Reset fetch calls and force token refresh by manipulating expiry
    fetchCalls = [];
    (provider as any).tokenExpiresAt = 0;
    (provider as any).cachedToken = null;

    await provider.getToken();

    // Should NOT call /app/installations again — installation ID is cached
    const installationsCalls = fetchCalls.filter(c =>
      c.url === 'https://api.github.com/app/installations'
    );
    expect(installationsCalls.length).toBe(0);
  });

  it('throws when no installation matches the repo owner', async () => {
    mockFetch = mock((url: string) => {
      if (url === 'https://api.github.com/app/installations') {
        return Promise.resolve(makeInstallationsListResponse([
          { id: 11111, login: 'other-org' },
        ]));
      }
      return Promise.resolve(makeInstallationTokenResponse());
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_NEW));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test', 'cenetex/aws-swarm');

    try {
      await provider.getToken();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('No GitHub App installation found for owner "cenetex"');
    }
  });

  it('owner matching is case-insensitive', async () => {
    mockFetch = mock((url: string) => {
      if (url === 'https://api.github.com/app/installations') {
        return Promise.resolve(makeInstallationsListResponse([
          { id: 77777, login: 'Cenetex' }, // Capital C
        ]));
      }
      if (url.includes('/access_tokens')) {
        return Promise.resolve(makeInstallationTokenResponse());
      }
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_NEW));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test', 'cenetex/aws-swarm');
    const token = await provider.getToken();
    expect(token).toBe('ghs_test_installation_token');
  });
});

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider — legacy { appId, privateKey, installationId }
// ---------------------------------------------------------------------------

describe('GitHubAppTokenProvider (legacy credentials)', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(makeInstallationTokenResponse()));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSecretsClient(null);
  });

  it('uses appId as JWT issuer and static installationId', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_LEGACY));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test');
    const token = await provider.getToken();

    expect(token).toBe('ghs_test_installation_token');

    // Should NOT call list installations — static ID provided
    const fetchUrl = (mockFetch.mock.calls[0] as any[])[0];
    expect(fetchUrl).toBe(
      'https://api.github.com/app/installations/67890/access_tokens'
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches the token on second call (no additional HTTP)', async () => {
    const { client, sendMock } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_LEGACY));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test');

    const token1 = await provider.getToken();
    const token2 = await provider.getToken();

    expect(token1).toBe(token2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws when credentials have neither clientId nor appId', async () => {
    const { client } = makeSecretsClient(JSON.stringify({ privateKey: 'x' }));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test');

    try {
      await provider.getToken();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('clientId (preferred) or appId');
    }
  });

  it('throws when credentials are missing privateKey', async () => {
    const { client } = makeSecretsClient(JSON.stringify({ clientId: 'Iv1.abc' }));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test');

    try {
      await provider.getToken();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('privateKey');
    }
  });

  it('throws when GitHub API returns an error', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS_LEGACY));
    _setSecretsClient(client);

    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Bad credentials'),
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GitHubAppTokenProvider('arn:test');

    try {
      await provider.getToken();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('token exchange failed');
      expect(err.message).toContain('401');
    }
  });

  it('normalizes escaped newlines in the private key', async () => {
    const escapedCreds = {
      ...TEST_CREDENTIALS_LEGACY,
      privateKey: TEST_CREDENTIALS_LEGACY.privateKey.replace(/\n/g, '\\n'),
    };
    const { client } = makeSecretsClient(JSON.stringify(escapedCreds));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:test');
    const token = await provider.getToken();

    expect(token).toBe('ghs_test_installation_token');
  });
});
