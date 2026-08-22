/**
 * Secrets Service - AWS Secrets Manager integration
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '../commands/index.js';
import type { SecretsService } from '../types/index.js';

export class AWSSecretsService implements SecretsService {
  private client: SecretsManagerClient;
  private cache: Map<string, { value: string; expiry: number }> = new Map();
  private cacheTTLMs: number;

  constructor(region: string = 'us-east-1', cacheTTLMs: number = 300000) {
    this.client = new SecretsManagerClient({ region });
    this.cacheTTLMs = cacheTTLMs;
  }

  async getSecret(name: string): Promise<string> {
    // Check cache
    const cached = this.cache.get(name);
    if (cached && cached.expiry > Date.now()) {
      return cached.value;
    }

    const command = new GetSecretValueCommand({ SecretId: name });
    let response;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // Preserve the original error shape/name, but annotate it with the secret id for easier debugging.
      if (error && typeof error === 'object') {
        (error as { secretId?: string }).secretId = name;
      }
      throw error;
    }

    const value = response.SecretString;
    if (!value) {
      throw new Error(`Secret ${name} has no string value`);
    }

    // Cache the result
    this.cache.set(name, {
      value,
      expiry: Date.now() + this.cacheTTLMs,
    });

    return value;
  }

  async getSecretJson<T = Record<string, string>>(name: string): Promise<T> {
    const value = await this.getSecret(name);
    return JSON.parse(value) as T;
  }

  /**
   * Get multiple secrets at once (for avatar initialization)
   */
  async getAvatarSecrets(avatarId: string, secretNames: string[]): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    await Promise.all(
      secretNames.map(async (name) => {
        try {
          // Try avatar-specific secret first
          const avatarecretName = `swarm/${avatarId}/${name}`;
          secrets[name] = await this.getSecret(avatarecretName);
        } catch {
          try {
            // Fall back to shared secret
            const sharedSecretName = `swarm/shared/${name}`;
            secrets[name] = await this.getSecret(sharedSecretName);
          } catch {
            console.warn(`Secret ${name} not found for avatar ${avatarId}`);
          }
        }
      })
    );

    return secrets;
  }

  /**
   * Clear the cache (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Factory function
 */
export function createSecretsService(region?: string): SecretsService {
  return new AWSSecretsService(region);
}
