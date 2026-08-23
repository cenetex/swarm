import { describe, expect, it } from 'bun:test';
import { createCloudflareHostedPlatform } from './platform.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import worker from './worker.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
  CloudflareQueue,
  CloudflareR2Bucket,
} from './bindings.js';

function fakeStatement(onBind?: (values: unknown[]) => void): CloudflareD1PreparedStatement {
  const statement: CloudflareD1PreparedStatement = {
    bind: (...values) => {
      onBind?.(values);
      return statement;
    },
    first: async () => null,
    all: async () => ({ success: true, results: [] }),
    run: async () => ({ success: true }),
  };
  return statement;
}

function fakeEnv(queue?: CloudflareQueue, onBind?: (values: unknown[]) => void): CloudflareHostedBindings {
  return {
    SWARM_STATE: { prepare: () => fakeStatement(onBind) } satisfies CloudflareD1Database,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
    } satisfies CloudflareR2Bucket,
    ...(queue ? { SWARM_QUEUE: queue } : {}),
    OPENROUTER_API_KEY: 'sk-test',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(9)),
  };
}

describe('Cloudflare hosted platform scaffold', () => {
  it('describes the hosted Cloudflare capabilities', () => {
    const platform = createCloudflareHostedPlatform(fakeEnv());
    expect(platform.descriptor.kind).toBe('cloudflare');
    expect(platform.descriptor.mode).toBe('hosted');
    expect(platform.descriptor.capabilities).toContain('state');
    expect(platform.descriptor.capabilities).toContain('platform-secrets');
    expect(platform.descriptor.capabilities).not.toContain('cron');
    expect(platform.descriptor.capabilities).not.toContain('workflows');
    expect(platform.descriptor.capabilities).not.toContain('coordination');
    expect(platform.descriptor.capabilities).not.toContain('realtime');
    expect(platform.descriptor.capabilities).not.toContain('queues');
    expect(platform.descriptor.capabilities).toContain('encrypted-user-secrets');
  });

  it('reads platform secrets from worker bindings', async () => {
    const platform = createCloudflareHostedPlatform(fakeEnv());
    await expect(platform.secrets.getPlatformSecret('OPENROUTER_API_KEY')).resolves.toBe('sk-test');
  });

  it('stores user secrets as an encrypted envelope', async () => {
    const boundValues: unknown[][] = [];
    const platform = createCloudflareHostedPlatform(fakeEnv(undefined, (values) => boundValues.push(values)));
    await platform.secrets.putUserSecret({ accountId: 'acct-1' }, 'telegram', 'bot-secret');

    const write = boundValues.find((values) => values.length === 6);
    expect(write).toBeDefined();
    expect(String(write?.[3])).not.toContain('bot-secret');
    expect(String(write?.[3])).toContain('wrappedDataKey');
  });

  it('fails closed when the hosted encryption key is missing', async () => {
    const env = fakeEnv();
    delete env.SWARM_USER_SECRET_KEK;
    const platform = createCloudflareHostedPlatform(env);
    await expect(platform.secrets.putUserSecret({ accountId: 'acct-1' }, 'telegram', 'secret')).rejects.toThrow(
      /not configured/i,
    );
  });

  it('sends default queue messages through the queue binding', async () => {
    const sent: unknown[] = [];
    const queue: CloudflareQueue = {
      send: async (message) => {
        sent.push(message);
      },
    };
    const platform = createCloudflareHostedPlatform(fakeEnv(queue));

    await platform.queues.send('default', {
      type: 'test.message',
      payload: { ok: true },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'test.message', payload: { ok: true } });
  });

  it('does not claim a subscription or active hosted runtime', async () => {
    const response = await worker.fetch(new Request('https://swarm.example/api/hosting/status'), fakeEnv());
    const status = (await response.json()) as {
      mode: string;
      hosted: { available: boolean; status: string; entitlement: string };
    };

    expect(status.mode).toBe('local');
    expect(status.hosted.available).toBe(false);
    expect(status.hosted.status).toBe('not-configured');
    expect(status.hosted.entitlement).toBe('none');
  });

  it('reports configured infrastructure as available but not active', async () => {
    const env = fakeEnv();
    env.SWARM_HOSTED_ENABLED = '1';
    env.SWARM_PUBLIC_URL = 'https://swarm.example';
    env.SWARM_ENV = 'production';
    const response = await worker.fetch(new Request('https://swarm.example/api/hosting/status'), env);
    const status = (await response.json()) as {
      mode: string;
      hosted: { available: boolean; status: string; entitlement: string };
    };

    expect(status.mode).toBe('local');
    expect(status.hosted.available).toBe(true);
    expect(status.hosted.status).toBe('available');
    expect(status.hosted.entitlement).toBe('none');
  });

  it('serves the hosted app through the asset binding with security headers', async () => {
    const env = fakeEnv();
    env.SWARM_ENV = 'preview';
    env.SWARM_ASSETS = {
      fetch: async () => new Response('<!doctype html><title>Swarm Hosted</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    };

    const response = await worker.fetch(new Request('https://swarm.example/'), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Swarm Hosted');
    const contentSecurityPolicy = response.headers.get('Content-Security-Policy');
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain("frame-src 'self' https://connect.solflare.com");
    expect(contentSecurityPolicy).not.toContain('frame-src https:');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('does not route unknown API requests to static assets', async () => {
    let assetRequests = 0;
    const env = fakeEnv();
    env.SWARM_ASSETS = {
      fetch: async () => {
        assetRequests += 1;
        return new Response('asset');
      },
    };

    const response = await worker.fetch(new Request('https://swarm.example/api/not-implemented'), env);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(assetRequests).toBe(0);
  });
});
