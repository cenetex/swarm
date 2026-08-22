/**
 * FileSecretsService tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FileSecretsService } from './secrets.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const ENV_PATH = resolve('/tmp/swarm-test-secrets.env');

describe('FileSecretsService', () => {
  beforeEach(() => {
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);
  });

  afterEach(() => {
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);
    delete process.env.SWARM_SHARED_OPENAI_API_KEY;
    delete process.env.SWARM_SHARED_OTHER_KEY;
    delete process.env.DIRECT_VAR;
  });

  describe('env var resolution', () => {
    it('resolves from process.env', async () => {
      process.env.SWARM_SHARED_OPENAI_API_KEY = 'sk-test123';
      const svc = new FileSecretsService();
      expect(await svc.getSecret('swarm/shared/OPENAI_API_KEY')).toBe('sk-test123');
    });

    it('translates secret names to env vars', async () => {
      process.env.SWARM_MYAVATAR_DISCORD_TOKEN = 'dt-secret';
      const svc = new FileSecretsService();
      expect(await svc.getSecret('swarm/myavatar/DISCORD_TOKEN')).toBe('dt-secret');
    });

    it('throws for missing secrets', async () => {
      const svc = new FileSecretsService();
      await expect(svc.getSecret('swarm/nonexistent/KEY')).rejects.toThrow('Secret not found');
    });

    it('handles hyphens in names', async () => {
      process.env.SWARM_SHARED_MY_API_KEY = 'hyphen-key';
      const svc = new FileSecretsService();
      expect(await svc.getSecret('swarm/shared/my-api-key')).toBe('hyphen-key');
    });
  });

  describe('.env file parsing', () => {
    it('reads secrets from a .env file', async () => {
      writeFileSync(ENV_PATH, 'SWARM_SHARED_OPENAI_API_KEY=env-file-value\n');
      const svc = new FileSecretsService({ envFilePath: ENV_PATH });
      expect(await svc.getSecret('swarm/shared/OPENAI_API_KEY')).toBe('env-file-value');
    });

    it('env vars override .env file values', async () => {
      process.env.SWARM_SHARED_OPENAI_API_KEY = 'env-override';
      writeFileSync(ENV_PATH, 'SWARM_SHARED_OPENAI_API_KEY=env-file-value\n');
      const svc = new FileSecretsService({ envFilePath: ENV_PATH });
      expect(await svc.getSecret('swarm/shared/OPENAI_API_KEY')).toBe('env-override');
    });

    it('handles quoted values', async () => {
      writeFileSync(ENV_PATH, 'SWARM_SHARED_KEY="quoted value"\n');
      const svc = new FileSecretsService({ envFilePath: ENV_PATH });
      expect(await svc.getSecret('swarm/shared/KEY')).toBe('quoted value');
    });

    it('handles single-quoted values', async () => {
      writeFileSync(ENV_PATH, "SWARM_SHARED_KEY='single quoted'\n");
      const svc = new FileSecretsService({ envFilePath: ENV_PATH });
      expect(await svc.getSecret('swarm/shared/KEY')).toBe('single quoted');
    });

    it('skips comments and empty lines', async () => {
      writeFileSync(ENV_PATH, '# This is a comment\n\nSWARM_SHARED_KEY=real-value\n');
      const svc = new FileSecretsService({ envFilePath: ENV_PATH });
      expect(await svc.getSecret('swarm/shared/KEY')).toBe('real-value');
    });

    it('silently skips missing .env file', () => {
      new FileSecretsService({ envFilePath: '/tmp/nonexistent.env' });
      // Should not throw — just won't have file-based secrets
    });
  });

  describe('JSON secrets', () => {
    it('parses JSON secrets', async () => {
      process.env.SWARM_SHARED_CONFIG = '{"host":"localhost","port":5432}';
      const svc = new FileSecretsService();
      const parsed = await svc.getSecretJson<{ host: string; port: number }>('swarm/shared/CONFIG');
      expect(parsed.host).toBe('localhost');
      expect(parsed.port).toBe(5432);
    });

    it('throws on invalid JSON', async () => {
      process.env.SWARM_SHARED_BAD = 'not-json';
      const svc = new FileSecretsService();
      await expect(svc.getSecretJson('swarm/shared/BAD')).rejects.toThrow('not valid JSON');
    });
  });
});
