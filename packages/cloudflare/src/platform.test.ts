import { describe, expect, it } from 'bun:test';
import { createCloudflareHostedPlatform } from './platform.js';
import worker from './worker.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
  CloudflareQueue,
  CloudflareR2Bucket,
} from './bindings.js';

function fakeStatement(): CloudflareD1PreparedStatement {
  return {
    bind: () => fakeStatement(),
    first: async () => null,
    all: async () => ({ success: true, results: [] }),
    run: async () => ({ success: true }),
  };
}

function fakeEnv(queue?: CloudflareQueue): CloudflareHostedBindings {
  return {
    SWARM_STATE: { prepare: () => fakeStatement() } satisfies CloudflareD1Database,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
    } satisfies CloudflareR2Bucket,
    ...(queue ? { SWARM_QUEUE: queue } : {}),
    OPENROUTER_API_KEY: 'sk-test',
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
  });

  it('reads platform secrets from worker bindings', async () => {
    const platform = createCloudflareHostedPlatform(fakeEnv());
    await expect(platform.secrets.getPlatformSecret('OPENROUTER_API_KEY')).resolves.toBe('sk-test');
  });

  it('fails closed for user secrets until envelope encryption exists', async () => {
    const platform = createCloudflareHostedPlatform(fakeEnv());
    await expect(platform.secrets.putUserSecret('acct-1', 'telegram', 'secret')).rejects.toThrow(/envelope encryption/i);
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
    const response = await worker.fetch(
      new Request('https://swarm.example/api/hosting/status'),
      fakeEnv(),
    );
    const status = await response.json() as {
      mode: string;
      hosted: { available: boolean; status: string; entitlement: string };
    };

    expect(status.mode).toBe('local');
    expect(status.hosted.available).toBe(false);
    expect(status.hosted.status).toBe('not-configured');
    expect(status.hosted.entitlement).toBe('none');
  });
});
