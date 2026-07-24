/**
 * LocalSecretsAdapter — routes SecretsManager commands (Get/Put/Delete)
 * through the env-based EncryptedSecretsService.
 */
import { LocalAdapter } from './adapter-base.js';
import type { SecretsService } from '@swarm/core';

type ManageableSecretsService = SecretsService & {
  setSecret?: (name: string, value: string) => Promise<void>;
  deleteSecret?: (name: string) => Promise<void>;
  flush?: () => Promise<void>;
};

export class LocalSecretsAdapter extends LocalAdapter {
  constructor(private secrets: SecretsService) { super(); }

  protected async dispatch(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name.startsWith('GetSecretValue')) {
      const secretId = input.SecretId as string;
      try {
        return { $metadata: { httpStatusCode: 200 }, SecretString: await this.secrets.getSecret(secretId) };
      } catch {
        try {
          const json = await this.secrets.getSecretJson(secretId);
          return { $metadata: { httpStatusCode: 200 }, SecretString: JSON.stringify(json) };
        } catch {
          const err = new Error('ResourceNotFoundException') as Error & { $metadata: Record<string, unknown>; name: string };
          err.$metadata = { httpStatusCode: 404 };
          err.name = 'ResourceNotFoundException';
          throw err;
        }
      }
    }

    // Note: PutSecretValueCommand is not exported by @swarm/core commands.
    // The core uses CreateSecretCommand/UpdateSecretCommand instead.
    // This handler exists for future compatibility and Bun-compiled variants.
    if (name.startsWith('PutSecretValue')) {
      const secretId = input.SecretId as string;
      const secretString = input.SecretString as string;
      if (secretId && secretString) {
        const secrets = this.secrets as ManageableSecretsService;
        try { await secrets.setSecret?.(secretId, secretString); await secrets.flush?.(); } catch { /* ok */ }
      }
      return { $metadata: { httpStatusCode: 200 } };
    }

    if (name.startsWith('DeleteSecret')) {
      const secretId = input.SecretId as string;
      if (secretId) {
        const secrets = this.secrets as ManageableSecretsService;
        try { await secrets.deleteSecret?.(secretId); await secrets.flush?.(); } catch { /* ok */ }
      }
      return { $metadata: { httpStatusCode: 200 } };
    }

    throw new Error(`LocalSecretsAdapter: unsupported command "${name}"`);
  }
}
