/**
 * Secrets Service - AWS Secrets Manager integration
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
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
    const response = await this.client.send(command);

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
   * Get multiple secrets at once (for agent initialization)
   */
  async getAgentSecrets(agentId: string, secretNames: string[]): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    await Promise.all(
      secretNames.map(async (name) => {
        try {
          // Try agent-specific secret first
          const agentSecretName = `swarm/${agentId}/${name}`;
          secrets[name] = await this.getSecret(agentSecretName);
        } catch {
          try {
            // Fall back to shared secret
            const sharedSecretName = `swarm/shared/${name}`;
            secrets[name] = await this.getSecret(sharedSecretName);
          } catch {
            console.warn(`Secret ${name} not found for agent ${agentId}`);
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
