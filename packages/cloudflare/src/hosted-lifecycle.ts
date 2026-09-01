import {
  applyHostedBillingEvent,
  applyHostedRuntimeEvent,
  canPerformHostedModelWork,
  initialHostedBillingState,
  initialHostedRuntimeState,
  markHostedCheckoutPending,
  normalizeHostedLifecycle,
  reconcileHostedLifecycle,
  requestHostedRuntime,
  type HostedBillingProviderEvent,
  type HostedLifecycle,
  type HostedRuntimeProviderEvent,
} from '@swarm/core/hosted';
import type {
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';

type LifecycleRow = {
  billing_json: string;
  runtime_json: string;
};

type LifecycleAccountRow = LifecycleRow & { account_id: string };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyHostedProviderSignature(
  body: string,
  signatureHeader: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret?.trim() || !signatureHeader) return false;
  const supplied = signatureHeader.trim().replace(/^sha256=/iu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(supplied)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return constantTimeEqual(supplied, toHex(new Uint8Array(digest)));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function runStatements(
  env: CloudflareHostedBindings,
  statements: CloudflareD1PreparedStatement[],
): Promise<void> {
  const results = env.SWARM_STATE.batch
    ? await env.SWARM_STATE.batch(statements)
    : await Promise.all(statements.map((statement) => statement.run()));
  for (const result of results) {
    if (!result.success) throw new Error(result.error ?? 'Unable to persist hosted lifecycle.');
  }
}

function lifecycleFromRow(row: LifecycleRow | null, now: number): HostedLifecycle {
  if (!row) {
    return {
      billing: initialHostedBillingState(now),
      runtime: initialHostedRuntimeState(now),
    };
  }
  return normalizeHostedLifecycle({
    billing: parseJson(row.billing_json),
    runtime: parseJson(row.runtime_json),
  }, now);
}

async function lifecycleRow(
  env: CloudflareHostedBindings,
  accountId: string,
): Promise<LifecycleRow | null> {
  try {
    return await env.SWARM_STATE.prepare(
      `select billing_json, runtime_json from swarm_hosted_lifecycles where account_id = ?`,
    ).bind(accountId).first<LifecycleRow>();
  } catch (error) {
    // A staged code rollout can briefly precede its D1 migration. Treat only that
    // known legacy shape as no lifecycle row; all other storage errors fail closed.
    if (error instanceof Error && /no such table|does not exist/iu.test(error.message)) return null;
    throw error;
  }
}

async function persistHostedLifecycle(
  env: CloudflareHostedBindings,
  accountId: string,
  lifecycle: HostedLifecycle,
  now: number,
): Promise<void> {
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_lifecycles
       (account_id, billing_json, runtime_json, created_at, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict(account_id) do update set
       billing_json = excluded.billing_json,
       runtime_json = excluded.runtime_json,
       updated_at = excluded.updated_at`,
  ).bind(
    accountId,
    JSON.stringify(lifecycle.billing),
    JSON.stringify(lifecycle.runtime),
    now,
    now,
  ).run();
  if (!result.success) throw new Error(result.error ?? 'Unable to persist hosted lifecycle.');
}

export async function getHostedLifecycle(
  env: CloudflareHostedBindings,
  accountId: string,
  now = Date.now(),
): Promise<HostedLifecycle> {
  return reconcileHostedLifecycle(lifecycleFromRow(await lifecycleRow(env, accountId), now), now);
}

export async function beginHostedCheckout(
  env: CloudflareHostedBindings,
  accountId: string,
  now = Date.now(),
): Promise<HostedLifecycle> {
  const current = await getHostedLifecycle(env, accountId, now);
  const next = {
    ...current,
    billing: markHostedCheckoutPending(current.billing, now),
  };
  await persistHostedLifecycle(env, accountId, next, now);
  return next;
}

export async function beginHostedProvisioning(
  env: CloudflareHostedBindings,
  accountId: string,
  now = Date.now(),
): Promise<HostedLifecycle> {
  const current = await getHostedLifecycle(env, accountId, now);
  const next = {
    ...current,
    runtime: requestHostedRuntime(current.billing, current.runtime, now),
  };
  await persistHostedLifecycle(env, accountId, next, now);
  return next;
}

async function eventProcessed(
  env: CloudflareHostedBindings,
  scope: 'billing' | 'runtime',
  provider: string,
  eventId: string,
): Promise<boolean> {
  const row = await env.SWARM_STATE.prepare(
    `select 1 as present from swarm_hosted_lifecycle_events
     where event_scope = ? and provider = ? and event_id = ?`,
  ).bind(scope, provider, eventId).first<{ present: number }>();
  return Boolean(row);
}

async function persistProviderEvent(
  env: CloudflareHostedBindings,
  accountId: string,
  scope: 'billing' | 'runtime',
  event: HostedBillingProviderEvent | HostedRuntimeProviderEvent,
  lifecycle: HostedLifecycle,
  now: number,
): Promise<void> {
  await runStatements(env, [
    env.SWARM_STATE.prepare(
      `insert into swarm_hosted_lifecycle_events
         (event_scope, provider, event_id, account_id, occurred_at, received_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(event_scope, provider, event_id) do nothing`,
    ).bind(scope, event.provider, event.eventId, accountId, event.occurredAt, now),
    env.SWARM_STATE.prepare(
      `insert into swarm_hosted_lifecycles
         (account_id, billing_json, runtime_json, created_at, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(account_id) do update set
         billing_json = excluded.billing_json,
         runtime_json = excluded.runtime_json,
         updated_at = excluded.updated_at`,
    ).bind(accountId, JSON.stringify(lifecycle.billing), JSON.stringify(lifecycle.runtime), now, now),
  ]);
}

export async function recordHostedBillingEvent(
  env: CloudflareHostedBindings,
  accountId: string,
  event: HostedBillingProviderEvent,
  now = Date.now(),
): Promise<{ lifecycle: HostedLifecycle; replayed: boolean }> {
  if (await eventProcessed(env, 'billing', event.provider, event.eventId)) {
    return { lifecycle: await getHostedLifecycle(env, accountId, now), replayed: true };
  }
  const current = await getHostedLifecycle(env, accountId, now);
  const updated = {
    ...current,
    billing: applyHostedBillingEvent(current.billing, event, now),
  };
  const lifecycle = reconcileHostedLifecycle(updated, now);
  await persistProviderEvent(env, accountId, 'billing', event, lifecycle, now);
  return { lifecycle, replayed: false };
}

export async function recordHostedRuntimeEvent(
  env: CloudflareHostedBindings,
  accountId: string,
  event: HostedRuntimeProviderEvent,
  now = Date.now(),
): Promise<{ lifecycle: HostedLifecycle; replayed: boolean }> {
  if (await eventProcessed(env, 'runtime', event.provider, event.eventId)) {
    return { lifecycle: await getHostedLifecycle(env, accountId, now), replayed: true };
  }
  const current = await getHostedLifecycle(env, accountId, now);
  const updated = {
    ...current,
    runtime: applyHostedRuntimeEvent(current.runtime, event, now),
  };
  const lifecycle = reconcileHostedLifecycle(updated, now);
  await persistProviderEvent(env, accountId, 'runtime', event, lifecycle, now);
  return { lifecycle, replayed: false };
}

export async function reconcileHostedAccount(
  env: CloudflareHostedBindings,
  accountId: string,
  now = Date.now(),
): Promise<HostedLifecycle> {
  const row = await lifecycleRow(env, accountId);
  const lifecycle = reconcileHostedLifecycle(lifecycleFromRow(row, now), now);
  if (row && (
    JSON.stringify(lifecycle.billing) !== JSON.stringify(parseJson(row.billing_json))
    || JSON.stringify(lifecycle.runtime) !== JSON.stringify(parseJson(row.runtime_json))
  )) {
    await persistHostedLifecycle(env, accountId, lifecycle, now);
  }
  return lifecycle;
}

export async function reconcileHostedAccounts(
  env: CloudflareHostedBindings,
  now = Date.now(),
  limit = 100,
): Promise<number> {
  let result;
  try {
    result = await env.SWARM_STATE.prepare(
      `select account_id, billing_json, runtime_json
       from swarm_hosted_lifecycles order by updated_at asc limit ?`,
    ).bind(limit).all<LifecycleAccountRow>();
  } catch (error) {
    if (error instanceof Error && /no such table|does not exist/iu.test(error.message)) return 0;
    throw error;
  }
  if (!result.success) throw new Error(result.error ?? 'Unable to list hosted lifecycles.');
  for (const row of result.results ?? []) {
    const lifecycle = reconcileHostedLifecycle(lifecycleFromRow(row, now), now);
    if (
      JSON.stringify(lifecycle.billing) !== JSON.stringify(parseJson(row.billing_json))
      || JSON.stringify(lifecycle.runtime) !== JSON.stringify(parseJson(row.runtime_json))
    ) {
      await persistHostedLifecycle(env, row.account_id, lifecycle, now);
    }
  }
  return result.results?.length ?? 0;
}

export async function hostedModelWorkAllowed(
  env: CloudflareHostedBindings,
  accountId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await lifecycleRow(env, accountId);
  // Existing hosted accounts did not have lifecycle rows. Keep them working during
  // rollout unless strict enforcement is enabled. Once an account enters the new
  // lifecycle, all work is governed by authoritative billing and health evidence.
  if (!row) return env.SWARM_HOSTED_LIFECYCLE_REQUIRED !== '1';
  return canPerformHostedModelWork(reconcileHostedLifecycle(lifecycleFromRow(row, now), now), now);
}
