import { describe, expect, it } from 'bun:test';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import {
  beginHostedCheckout,
  beginHostedProvisioning,
  getHostedLifecycle,
  hostedModelWorkAllowed,
  reconcileHostedAccount,
  recordHostedBillingEvent,
  recordHostedRuntimeEvent,
  verifyHostedProviderSignature,
} from './hosted-lifecycle.js';

type StoredLifecycle = { billing_json: string; runtime_json: string; created_at: number; updated_at: number };
type StoredEvent = { account_id: string; occurred_at: number; received_at: number };

class LifecycleMemoryD1 implements CloudflareD1Database {
  readonly lifecycles = new Map<string, StoredLifecycle>();
  readonly events = new Map<string, StoredEvent>();

  prepare(query: string): CloudflareD1PreparedStatement {
    return new LifecycleMemoryStatement(this, query.replace(/\s+/gu, ' ').trim().toLowerCase());
  }
}

class LifecycleMemoryStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: LifecycleMemoryD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.startsWith('select billing_json, runtime_json from swarm_hosted_lifecycles')) {
      return (this.db.lifecycles.get(String(this.values[0])) ?? null) as T | null;
    }
    if (this.query.startsWith('select 1 as present from swarm_hosted_lifecycle_events')) {
      const [scope, provider, eventId] = this.values.map(String);
      return (this.db.events.has(`${scope}|${provider}|${eventId}`) ? { present: 1 } : null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ success: boolean; results: T[] }> {
    if (this.query.startsWith('select account_id, billing_json, runtime_json from swarm_hosted_lifecycles')) {
      const limit = Number(this.values[0]);
      const rows = Array.from(this.db.lifecycles, ([account_id, value]) => ({ account_id, ...value }))
        .sort((left, right) => left.updated_at - right.updated_at)
        .slice(0, limit);
      return { success: true, results: rows as T[] };
    }
    return { success: true, results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    if (this.query.startsWith('insert into swarm_hosted_lifecycles')) {
      const [accountId, billingJson, runtimeJson, createdAt, updatedAt] = this.values as [
        string,
        string,
        string,
        number,
        number,
      ];
      const existing = this.db.lifecycles.get(accountId);
      this.db.lifecycles.set(accountId, {
        billing_json: billingJson,
        runtime_json: runtimeJson,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }
    if (this.query.startsWith('insert into swarm_hosted_lifecycle_events')) {
      const [scope, provider, eventId, accountId, occurredAt, receivedAt] = this.values as [
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      const key = `${scope}|${provider}|${eventId}`;
      if (!this.db.events.has(key)) {
        this.db.events.set(key, { account_id: accountId, occurred_at: occurredAt, received_at: receivedAt });
      }
      return { success: true };
    }
    return { success: true };
  }
}

function fakeEnv(db = new LifecycleMemoryD1()): CloudflareHostedBindings {
  return {
    SWARM_STATE: db,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
    },
  };
}

const NOW = 3_000_000;

describe('Cloudflare hosted lifecycle persistence', () => {
  it('keeps checkout pending until a provider event confirms payment', async () => {
    const env = fakeEnv();
    const checkout = await beginHostedCheckout(env, 'acct-1', NOW);
    expect(checkout.billing.status).toBe('checkout-pending');
    expect(await hostedModelWorkAllowed(env, 'acct-1', NOW)).toBe(false);

    const paid = await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-paid',
      occurredAt: NOW + 1,
      planId: 'starter',
    }, NOW + 1);
    expect(paid.lifecycle.billing.status).toBe('paid');
    expect(await hostedModelWorkAllowed(env, 'acct-1', NOW + 1)).toBe(false);
  });

  it('only activates after provision and fresh health evidence', async () => {
    const env = fakeEnv();
    await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-paid',
      occurredAt: NOW,
    }, NOW);
    expect((await beginHostedProvisioning(env, 'acct-1', NOW + 1)).runtime.status).toBe('requested');
    expect((await recordHostedRuntimeEvent(env, 'acct-1', {
      type: 'provision.succeeded',
      provider: 'runtime-provider',
      eventId: 'runtime-ready',
      occurredAt: NOW + 2,
      runtimeId: 'runtime-1',
      endpoint: 'https://runtime-1.example',
    }, NOW + 2)).lifecycle.runtime.status).toBe('health-checking');
    expect(await hostedModelWorkAllowed(env, 'acct-1', NOW + 2)).toBe(false);

    const healthy = await recordHostedRuntimeEvent(env, 'acct-1', {
      type: 'health.healthy',
      provider: 'runtime-provider',
      eventId: 'health-1',
      occurredAt: NOW + 3,
    }, NOW + 3);
    expect(healthy.lifecycle.runtime.status).toBe('active');
    expect(await hostedModelWorkAllowed(env, 'acct-1', NOW + 3)).toBe(true);
  });

  it('ignores replayed and delayed paid events after cancellation', async () => {
    const env = fakeEnv();
    await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-paid',
      occurredAt: NOW + 10,
    }, NOW + 10);
    await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.cancelled',
      provider: 'billing-provider',
      eventId: 'bill-cancelled',
      occurredAt: NOW + 30,
    }, NOW + 30);
    const delayed = await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-delayed',
      occurredAt: NOW + 20,
    }, NOW + 40);
    const replay = await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.cancelled',
      provider: 'billing-provider',
      eventId: 'bill-cancelled',
      occurredAt: NOW + 30,
    }, NOW + 50);

    expect(delayed.lifecycle.billing.status).toBe('cancelled');
    expect(replay.replayed).toBe(true);
    expect((await getHostedLifecycle(env, 'acct-1', NOW + 50)).billing.status).toBe('cancelled');
  });

  it('reconciliation blocks cancelled billing and stale health', async () => {
    const env = fakeEnv();
    await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-paid',
      occurredAt: NOW,
    }, NOW);
    await recordHostedRuntimeEvent(env, 'acct-1', {
      type: 'provision.succeeded',
      provider: 'runtime-provider',
      eventId: 'runtime-ready',
      occurredAt: NOW + 1,
      runtimeId: 'runtime-1',
    }, NOW + 1);
    await recordHostedRuntimeEvent(env, 'acct-1', {
      type: 'health.healthy',
      provider: 'runtime-provider',
      eventId: 'health-1',
      occurredAt: NOW + 2,
    }, NOW + 2);

    const stale = await reconcileHostedAccount(env, 'acct-1', NOW + 600_000);
    expect(stale.runtime.status).toBe('health-checking');
    expect(await hostedModelWorkAllowed(env, 'acct-1', NOW + 600_000)).toBe(false);

    await recordHostedBillingEvent(env, 'acct-1', {
      type: 'subscription.cancelled',
      provider: 'billing-provider',
      eventId: 'bill-cancelled',
      occurredAt: NOW + 600_001,
    }, NOW + 600_001);
    expect((await getHostedLifecycle(env, 'acct-1', NOW + 600_001)).runtime.status).toBe('cancelled');
  });

  it('allows legacy accounts during rollout but strict mode fails closed', async () => {
    const legacy = fakeEnv();
    expect(await hostedModelWorkAllowed(legacy, 'acct-legacy', NOW)).toBe(true);
    legacy.SWARM_HOSTED_LIFECYCLE_REQUIRED = '1';
    expect(await hostedModelWorkAllowed(legacy, 'acct-legacy', NOW)).toBe(false);
  });

  it('verifies provider callbacks with an HMAC signature', async () => {
    const body = JSON.stringify({ eventId: 'event-1' });
    const secret = 'test-provider-secret';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');

    expect(await verifyHostedProviderSignature(body, `sha256=${signature}`, secret)).toBe(true);
    expect(await verifyHostedProviderSignature(`${body} `, `sha256=${signature}`, secret)).toBe(false);
    expect(await verifyHostedProviderSignature(body, null, secret)).toBe(false);
  });
});
