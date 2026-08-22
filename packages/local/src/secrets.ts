/**
 * FileSecretsService — local-first secrets backed by env vars and .env files.
 *
 * Implements the SecretsService interface from @swarm/core.
 * Secrets are resolved with the following precedence:
 *   1. process.env (direct overrides)
 *   2. A parsed .env file (optional)
 *
 * Secret names are translated to env var names:
 *   "swarm/shared/OPENAI_API_KEY" → SWARM_SHARED_OPENAI_API_KEY
 */
import type { SecretsService } from '@swarm/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function secretNameToEnvVar(name: string): string {
  return name
    .replace(/^swarm\//, 'SWARM_')
    .replace(/\//g, '_')
    .replace(/-/g, '_')
    .toUpperCase();
}

export interface FileSecretsOptions {
  /** Path to a .env file. Defaults to '.env' in cwd. */
  envFilePath?: string;
}

export class FileSecretsService implements SecretsService {
  private cache: Map<string, string>;

  constructor(options: FileSecretsOptions = {}) {
    this.cache = new Map();

    const envPath = resolve(options.envFilePath ?? '.env');
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        this.cache.set(key, value);
      }
    } catch {
      // .env file not found or unreadable — skip
    }
  }

  async getSecret(name: string): Promise<string> {
    // Check direct env var first
    const envVar = secretNameToEnvVar(name);
    if (process.env[envVar]) return process.env[envVar]!;

    // Check .env file cache
    const cached = this.cache.get(envVar);
    if (cached) return cached;

    throw new Error(`Secret not found: ${name} (env var: ${envVar})`);
  }

  async getSecretJson<T = Record<string, string>>(name: string): Promise<T> {
    const value = await this.getSecret(name);
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`Secret "${name}" is not valid JSON`);
    }
  }
}
