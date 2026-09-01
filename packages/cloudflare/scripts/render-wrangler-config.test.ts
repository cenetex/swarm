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
    expect(config.compatibility_flags).toEqual(['global_fetch_strictly_public']);
    expect(config.vars.SWARM_ENV).toBe('preview');
    expect(config.vars.SWARM_HOSTED_ENABLED).toBe('1');
    expect(config.vars.SWARM_PASSKEY_RP_ID).toBe('swarm-hosted-preview.example.workers.dev');
    expect(config.d1_databases[0].database_id).toBe(validValues.SWARM_CF_D1_DATABASE_ID);
    expect(config.r2_buckets[0].bucket_name).toBe(validValues.SWARM_CF_R2_BUCKET_NAME);
    expect(config.queues.producers[0].queue).toBe(validValues.SWARM_CF_QUEUE_NAME);
    expect(config.assets).toEqual({
      directory: '../admin-ui/dist-hosted',
      binding: 'SWARM_ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    });
    expect(config.vars.SWARM_USER_SECRET_KEK).toBeUndefined();
    expect(config.vars.SWARM_X_API_KEY).toBeUndefined();
    expect(config.vars.SWARM_X_API_SECRET).toBeUndefined();
    expect(config.secrets.required).toEqual([
      'SWARM_USER_SECRET_KEK',
      'SWARM_X_API_KEY',
      'SWARM_X_API_SECRET',
      'SWARM_BILLING_WEBHOOK_SECRET',
      'SWARM_RUNTIME_CALLBACK_SECRET',
    ]);
    expect(config.vars.SWARM_OPENROUTER_MODEL).toBe('openrouter/free');
    expect(config.vars.SWARM_HOSTED_LIFECYCLE_REQUIRED).toBe('0');
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

  it('only accepts an explicit lifecycle rollout flag', async () => {
    const base = await baseConfig();
    expect(renderWranglerConfig(base, {
      ...validValues,
      SWARM_HOSTED_LIFECYCLE_REQUIRED: '1',
    }, 'preview').vars.SWARM_HOSTED_LIFECYCLE_REQUIRED).toBe('1');
    expect(() => renderWranglerConfig(base, {
      ...validValues,
      SWARM_HOSTED_LIFECYCLE_REQUIRED: 'true',
    }, 'preview')).toThrow('must be 0 or 1');
  });

  it('renders a production staging domain without activating the primary hostname', async () => {
    const config = renderWranglerConfig(
      await baseConfig(),
      {
        ...validValues,
        SWARM_CF_WORKER_NAME: 'swarm-hosted-production',
        SWARM_PUBLIC_URL: 'https://next.swarm.rati.chat',
        SWARM_CF_STAGING_DOMAIN: 'next.swarm.rati.chat',
        SWARM_CF_ZONE_NAME: 'rati.chat',
      },
      'production',
    );

    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([
      { pattern: 'next.swarm.rati.chat', custom_domain: true },
    ]);
    expect(config.vars.SWARM_PASSKEY_RP_ID).toBe('rati.chat');
  });

  it('activates the primary route only when it matches the canonical public origin', async () => {
    const productionValues = {
      ...validValues,
      SWARM_CF_WORKER_NAME: 'swarm-hosted-production',
      SWARM_PUBLIC_URL: 'https://swarm.rati.chat',
      SWARM_CF_STAGING_DOMAIN: 'next.swarm.rati.chat',
      SWARM_CF_ZONE_NAME: 'rati.chat',
      SWARM_CF_PRIMARY_ROUTE: 'swarm.rati.chat/*',
    };
    const config = renderWranglerConfig(await baseConfig(), productionValues, 'production');

    expect(config.routes).toEqual([
      { pattern: 'next.swarm.rati.chat', custom_domain: true },
      { pattern: 'swarm.rati.chat/*', zone_name: 'rati.chat' },
    ]);
    expect(() => renderWranglerConfig(
      config,
      { ...productionValues, SWARM_PUBLIC_URL: 'https://wrong.rati.chat' },
      'production',
    )).toThrow('must match the active primary route hostname');
  });

  it('rejects production routing variables in preview', async () => {
    const config = await baseConfig();
    expect(() => renderWranglerConfig(
      config,
      { ...validValues, SWARM_CF_STAGING_DOMAIN: 'next.swarm.rati.chat' },
      'preview',
    )).toThrow('not allowed in preview');
  });

  it('rejects a passkey RP ID outside the public origin hierarchy', async () => {
    const config = await baseConfig();
    expect(() => renderWranglerConfig(
      config,
      { ...validValues, SWARM_PASSKEY_RP_ID: 'unrelated.example' },
      'preview',
    )).toThrow('SWARM_PASSKEY_RP_ID');
  });
});
