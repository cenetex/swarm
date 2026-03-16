/**
 * GitHub App Token Provider
 *
 * Handles the full GitHub App authentication flow:
 * 1. Fetch app credentials (appId, privateKey, installationId) from Secrets Manager
 * 2. Create a short-lived JWT signed with the app's private key
 * 3. Exchange the JWT for an installation access token via GitHub API
 * 4. Cache and auto-refresh the installation token (50-min TTL, tokens last 60 min)
 *
 * Environment:
 * - GITHUB_APP_CREDENTIALS_ARN: Secrets Manager ARN for the JSON credentials blob
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Secrets Manager client (injectable for tests)
// ---------------------------------------------------------------------------

let _secretsClient: SecretsManagerClient | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!_secretsClient) {
    _secretsClient = new SecretsManagerClient({});
  }
  return _secretsClient;
}

/** For testing — inject a mock secrets client */
export function _setSecretsClient(client: SecretsManagerClient | null): void {
  _secretsClient = client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(input: Buffer): string {
  return input.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses RS256 (RSA + SHA-256) as required by GitHub.
 */
export function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iat: now - 60, // Backdate 60s to account for clock drift
    exp: now + 600, // 10 minutes
    iss: appId,
  })));

  const signable = `${header}.${payload}`;
  const sign = crypto.createSign('SHA256');
  sign.update(signable);
  sign.end();

  const signature = base64url(sign.sign(privateKey));
  return `${signable}.${signature}`;
}

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider
// ---------------------------------------------------------------------------

/** How long to cache installation tokens (50 min; tokens are valid for 60 min) */
const INSTALL_TOKEN_TTL_MS = 50 * 60 * 1000;

export class GitHubAppTokenProvider implements GitHubTokenProvider {
  private secretArn: string;
  private credentials: GitHubAppCredentials | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(secretArn: string) {
    this.secretArn = secretArn;
  }

  /**
   * Load credentials from Secrets Manager. Cached permanently (credentials don't rotate).
   */
  private async loadCredentials(): Promise<GitHubAppCredentials> {
    if (this.credentials) return this.credentials;

    const result = await getSecretsClient().send(
      new GetSecretValueCommand({ SecretId: this.secretArn })
    );

    if (!result.SecretString) {
      throw new Error('GitHub App credentials secret is empty');
    }

    const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;

    if (!parsed.appId || !parsed.privateKey || !parsed.installationId) {
      throw new Error(
        'GitHub App credentials must contain appId, privateKey, and installationId'
      );
    }

    this.credentials = {
      appId: String(parsed.appId),
      privateKey: String(parsed.privateKey).replace(/\\n/g, '\n'),
      installationId: String(parsed.installationId),
    };

    return this.credentials;
  }

  /**
   * Exchange an app JWT for an installation access token via GitHub REST API.
   */
  private async exchangeForInstallationToken(
    jwt: string,
    installationId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub App token exchange failed (${response.status}): ${body.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as { token: string; expires_at: string };
    return { token: data.token, expiresAt: data.expires_at };
  }

  /**
   * Get a valid installation access token.
   * Returns a cached token if still valid, otherwise fetches a new one.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const creds = await this.loadCredentials();
    const jwt = createAppJwt(creds.appId, creds.privateKey);
    const result = await this.exchangeForInstallationToken(jwt, creds.installationId);

    this.cachedToken = result.token;
    this.tokenExpiresAt = now + INSTALL_TOKEN_TTL_MS;

    return this.cachedToken;
  }
}
