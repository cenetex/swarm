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

const TEST_CREDENTIALS = {
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

// ---------------------------------------------------------------------------
// createAppJwt
// ---------------------------------------------------------------------------

describe('createAppJwt', () => {
  it('produces a valid 3-part JWT', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS.appId, TEST_CREDENTIALS.privateKey);
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
  });

  it('has correct header', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS.appId, TEST_CREDENTIALS.privateKey);
    const [headerB64] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('has correct payload fields', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS.appId, TEST_CREDENTIALS.privateKey);
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    expect(payload.iss).toBe('12345');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp - payload.iat).toBe(660); // 600 + 60 backdate
  });

  it('signature is verifiable with the public key', () => {
    const jwt = createAppJwt(TEST_CREDENTIALS.appId, TEST_CREDENTIALS.privateKey);
    const [header, payload, signature] = jwt.split('.');
    const signable = `${header}.${payload}`;

    // Re-pad the base64url signature
    const sigBuf = Buffer.from(signature, 'base64url');
    const verify = crypto.createVerify('SHA256');
    verify.update(signable);
    verify.end();

    expect(verify.verify(TEST_PUBLIC_KEY, sigBuf)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider
// ---------------------------------------------------------------------------

describe('GitHubAppTokenProvider', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'ghs_test_installation_token',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        text: () => Promise.resolve(''),
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSecretsClient(null);
  });

  it('fetches credentials from Secrets Manager and returns an installation token', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:aws:secretsmanager:us-east-1:123:secret:test');
    const token = await provider.getToken();

    expect(token).toBe('ghs_test_installation_token');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify the GitHub API was called with the correct URL
    const fetchUrl = (mockFetch.mock.calls[0] as any[])[0];
    expect(fetchUrl).toBe(
      'https://api.github.com/app/installations/67890/access_tokens'
    );
  });

  it('caches the token on second call (no additional HTTP)', async () => {
    const { client, sendMock } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:aws:secretsmanager:us-east-1:123:secret:test');

    const token1 = await provider.getToken();
    const token2 = await provider.getToken();

    expect(token1).toBe(token2);
    // Secrets Manager called once, GitHub API called once
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws when credentials are missing required fields', async () => {
    const { client } = makeSecretsClient(JSON.stringify({ appId: '123' }));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:aws:secretsmanager:us-east-1:123:secret:test');

    try {
      await provider.getToken();
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('appId, privateKey, and installationId');
    }
  });

  it('throws when GitHub API returns an error', async () => {
    const { client } = makeSecretsClient(JSON.stringify(TEST_CREDENTIALS));
    _setSecretsClient(client);

    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Bad credentials'),
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GitHubAppTokenProvider('arn:aws:secretsmanager:us-east-1:123:secret:test');

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
      ...TEST_CREDENTIALS,
      privateKey: TEST_CREDENTIALS.privateKey.replace(/\n/g, '\\n'),
    };
    const { client } = makeSecretsClient(JSON.stringify(escapedCreds));
    _setSecretsClient(client);

    const provider = new GitHubAppTokenProvider('arn:aws:secretsmanager:us-east-1:123:secret:test');
    const token = await provider.getToken();

    // Should succeed despite escaped newlines
    expect(token).toBe('ghs_test_installation_token');
  });
});
