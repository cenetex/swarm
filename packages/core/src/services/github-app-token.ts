/**
 * GitHub App Token Provider
 *
 * Handles the full GitHub App authentication flow:
 * 1. Fetch app credentials from Secrets Manager
 * 2. Create a short-lived JWT signed with the app's private key
 * 3. Discover the installation ID dynamically from GITHUB_REPO (or use a static one)
 * 4. Exchange the JWT for an installation access token via GitHub API
 * 5. Cache and auto-refresh the installation token (50-min TTL, tokens last 60 min)
 *
 * Supported secret shapes:
 *   Preferred: { "clientId": "Iv1...", "privateKey": "-----BEGIN..." }
 *   Legacy:    { "appId": "12345", "privateKey": "...", "installationId": "67890" }
 *
 * When `installationId` is absent the provider resolves it dynamically from
 * the `repo` constructor argument (or GITHUB_REPO env var).
 *
 * Environment:
 * - GITHUB_APP_CREDENTIALS_ARN: Secrets Manager ARN for the JSON credentials blob
 * - GITHUB_REPO: owner/repo used to discover the installation (e.g. "cenetex/aws-swarm")
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubAppCredentials {
  /** Preferred: GitHub App client ID (used as JWT `iss`). Falls back to appId. */
  clientId?: string;
  /** Legacy: GitHub App numeric ID. Superseded by clientId. */
  appId?: string;
  privateKey: string;
  /** Static installation ID. When absent, resolved dynamically from repo. */
  installationId?: string;
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
 *
 * @param issuer - The JWT `iss` claim. Preferred: clientId (e.g. "Iv1..."). Legacy: appId.
 * @param privateKey - PEM-encoded RSA private key.
 */
export function createAppJwt(issuer: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iat: now - 60, // Backdate 60s to account for clock drift
    exp: now + 600, // 10 minutes
    iss: issuer,
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
  private repo: string;
  private credentials: GitHubAppCredentials | null = null;
  private resolvedInstallationId: string | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(secretArn: string, repo?: string) {
    this.secretArn = secretArn;
    this.repo = repo || process.env.GITHUB_REPO || 'cenetex/aws-swarm';
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

    // Must have at least one of clientId or appId, and a privateKey
    const clientId = parsed.clientId ? String(parsed.clientId) : undefined;
    const appId = parsed.appId ? String(parsed.appId) : undefined;
    const installationId = parsed.installationId ? String(parsed.installationId) : undefined;

    if (!clientId && !appId) {
      throw new Error(
        'GitHub App credentials must contain clientId (preferred) or appId'
      );
    }

    if (!parsed.privateKey) {
      throw new Error('GitHub App credentials must contain privateKey');
    }

    this.credentials = {
      clientId,
      appId,
      privateKey: String(parsed.privateKey).replace(/\\n/g, '\n'),
      installationId,
    };

    return this.credentials;
  }

  /**
   * Resolve the JWT issuer from credentials.
   * Prefers clientId over appId per current GitHub recommendations.
   */
  private getIssuer(creds: GitHubAppCredentials): string {
    return creds.clientId || creds.appId!;
  }

  /**
   * Discover the installation ID for the configured repo by listing app installations.
   * Falls back to the static installationId from the secret if provided.
   */
  private async resolveInstallationId(jwt: string, creds: GitHubAppCredentials): Promise<string> {
    // If we already resolved it, return cached
    if (this.resolvedInstallationId) return this.resolvedInstallationId;

    // If the secret provides a static installationId, use it
    if (creds.installationId) {
      this.resolvedInstallationId = creds.installationId;
      return creds.installationId;
    }

    // Dynamic lookup: GET /app/installations, find the one for our repo
    const [owner, repo] = this.repo.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GITHUB_REPO format: "${this.repo}". Expected "owner/repo".`);
    }

    const response = await fetch('https://api.github.com/app/installations', {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to list GitHub App installations (${response.status}): ${body.slice(0, 500)}`
      );
    }

    const installations = (await response.json()) as Array<{
      id: number;
      account: { login: string } | null;
    }>;

    // Find the installation for the target owner/org
    const match = installations.find(
      inst => inst.account?.login.toLowerCase() === owner.toLowerCase()
    );

    if (!match) {
      throw new Error(
        `No GitHub App installation found for owner "${owner}". ` +
        `Available installations: ${installations.map(i => i.account?.login || 'unknown').join(', ') || 'none'}`
      );
    }

    this.resolvedInstallationId = String(match.id);
    return this.resolvedInstallationId;
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
    const issuer = this.getIssuer(creds);
    const jwt = createAppJwt(issuer, creds.privateKey);
    const installationId = await this.resolveInstallationId(jwt, creds);
    const result = await this.exchangeForInstallationToken(jwt, installationId);

    this.cachedToken = result.token;
    this.tokenExpiresAt = now + INSTALL_TOKEN_TTL_MS;

    return this.cachedToken;
  }
}
