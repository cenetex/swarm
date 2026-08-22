import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderWranglerConfig } from './render-wrangler-config.mjs';

const validValues = {
  SWARM_CF_WORKER_NAME: 'swarm-hosted-preview',
  SWARM_CF_D1_DATABASE_NAME: 'swarm-hosted-preview',
  SWARM_CF_D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
  SWARM_CF_R2_BUCKET_NAME: 'swarm-hosted-preview',
  SWARM_CF_QUEUE_NAME: 'swarm-hosted-preview',
  SWARM_PUBLIC_URL: 'https://swarm-hosted-preview.example.workers.dev',
  SWARM_USER_SECRET_KEY_VERSION: 'preview_v1',
};

async function baseConfig() {
  return JSON.parse(await readFile(resolve(import.meta.dir, '..', 'wrangler.json'), 'utf8'));
}

describe('renderWranglerConfig', () => {
  it('injects environment resources without exposing the wrapping key', async () => {
    const config = renderWranglerConfig(await baseConfig(), validValues, 'preview');

    expect(config.name).toBe('swarm-hosted-preview');
    expect(config.vars.SWARM_ENV).toBe('preview');
    expect(config.vars.SWARM_HOSTED_ENABLED).toBe('1');
    expect(config.d1_databases[0].database_id).toBe(validValues.SWARM_CF_D1_DATABASE_ID);
    expect(config.r2_buckets[0].bucket_name).toBe(validValues.SWARM_CF_R2_BUCKET_NAME);
    expect(config.queues.producers[0].queue).toBe(validValues.SWARM_CF_QUEUE_NAME);
    expect(config.vars.SWARM_USER_SECRET_KEK).toBeUndefined();
  });

  it('rejects non-HTTPS public origins', async () => {
    const config = await baseConfig();
    expect(() =>
      renderWranglerConfig(
        config,
        { ...validValues, SWARM_PUBLIC_URL: 'http://swarm-hosted-preview.example.workers.dev' },
        'preview',
      ),
    ).toThrow('HTTPS origin');
  });

  it('rejects unsupported environments', async () => {
    const config = await baseConfig();
    expect(() => renderWranglerConfig(config, validValues, 'staging')).toThrow(
      'Environment must be preview or production',
    );
  });
});
