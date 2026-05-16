import { describe, it, expect } from 'vitest';
import type { SecretsService } from '@swarm/core';
import { ensureOpenRouterKey, getSystemOpenRouterKey } from './system-openrouter-key.js';

function mockSecretsService(getSecret: SecretsService['getSecret']): SecretsService {
  return {
    getSecret,
    getSecretJson: async () => {
      throw new Error('not used');
    },
    getAvatarSecrets: async () => ({}),
  };
}

function captureEnv() {
  return {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    openrouter_api_key: process.env.openrouter_api_key,
    LLM_API_KEY: process.env.LLM_API_KEY,
    OPENROUTER_API_KEY_SECRET_ARN: process.env.OPENROUTER_API_KEY_SECRET_ARN,
    LLM_API_KEY_SECRET_ARN: process.env.LLM_API_KEY_SECRET_ARN,
  };
}

function restoreEnv(previous: ReturnType<typeof captureEnv>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('system-openrouter-key', () => {
  it('prefers direct OpenRouter env var', async () => {
    const prev = captureEnv();
    process.env.OPENROUTER_API_KEY = 'env-openrouter-key';
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY_SECRET_ARN;
    delete process.env.LLM_API_KEY_SECRET_ARN;

    const key = await getSystemOpenRouterKey(mockSecretsService(async () => {
      throw new Error('should not be called');
    }));

    expect(key).toBe('env-openrouter-key');
    restoreEnv(prev);
  });

  it('loads from the LLM secret ARN', async () => {
    const prev = captureEnv();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.openrouter_api_key;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY_SECRET_ARN;
    process.env.LLM_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:openrouter';

    const key = await getSystemOpenRouterKey(mockSecretsService(async () => 'secret-openrouter-key'));

    expect(key).toBe('secret-openrouter-key');
    restoreEnv(prev);
  });

  it('parses JSON secret shapes', async () => {
    const prev = captureEnv();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.openrouter_api_key;
    delete process.env.LLM_API_KEY;
    process.env.OPENROUTER_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:openrouter';
    delete process.env.LLM_API_KEY_SECRET_ARN;

    const key = await getSystemOpenRouterKey(mockSecretsService(async () => JSON.stringify({
      OPENROUTER_API_KEY: 'json-openrouter-key',
    })));

    expect(key).toBe('json-openrouter-key');
    restoreEnv(prev);
  });

  it('ensureOpenRouterKey injects canonical secret name when missing', async () => {
    const prev = captureEnv();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.openrouter_api_key;
    delete process.env.LLM_API_KEY;
    process.env.LLM_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:openrouter';

    const secrets: Record<string, string> = {};
    const ok = await ensureOpenRouterKey(secrets, mockSecretsService(async () => 'secret-openrouter-key'));

    expect(ok).toBe(true);
    expect(secrets.OPENROUTER_API_KEY).toBe('secret-openrouter-key');
    restoreEnv(prev);
  });
});
