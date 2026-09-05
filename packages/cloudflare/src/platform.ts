import type {
  CompositeKey,
  HostedBlob,
  HostedBlobPutOptions,
  HostedBlobStore,
  HostedCoordinator,
  HostedPlatform,
  HostedQueueMessage,
  HostedQueueService,
  HostedScheduledJob,
  HostedScheduler,
  HostedSecretStore,
  HostedUserSecretScope,
  HostedStateEntry,
  HostedStatePutOptions,
  HostedStateStore,
  JsonObject,
} from '@swarm/core';
import type { CloudflareHostedBindings, CloudflareQueue } from './bindings.js';
import { CloudflareFeatureNotImplementedError } from './errors.js';
import { HostedSecretCipher, isHostedSecretKeyValid } from './secret-crypto.js';

type D1StateRow = {
  pk: string;
  sk: string;
  value: string;
  updated_at: number;
  expires_at: number | null;
};

function toStateEntry<T extends JsonObject>(row: D1StateRow): HostedStateEntry<T> {
  return {
    key: { pk: row.pk, sk: row.sk },
    value: JSON.parse(row.value) as T,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

export class CloudflareD1StateStore implements HostedStateStore {
  constructor(private readonly env: CloudflareHostedBindings) {}

  async get<T extends JsonObject = JsonObject>(key: CompositeKey): Promise<HostedStateEntry<T> | null> {
    const now = Date.now();
    const row = await this.env.SWARM_STATE.prepare(
      'select pk, sk, value, updated_at, expires_at from swarm_kv where pk = ? and sk = ? and (expires_at is null or expires_at > ?)',
    ).bind(key.pk, key.sk, now).first<D1StateRow>();
    return row ? toStateEntry<T>(row) : null;
  }

  async put<T extends JsonObject = JsonObject>(
    key: CompositeKey,
    value: T,
    options: HostedStatePutOptions = {},
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = options.ttlSeconds ? now + options.ttlSeconds * 1000 : null;
    const encoded = JSON.stringify(value);
    if (options.onlyIfNotExists) {
      const result = await this.env.SWARM_STATE.prepare(
        'insert into swarm_kv (pk, sk, value, updated_at, expires_at) values (?, ?, ?, ?, ?)',
      ).bind(key.pk, key.sk, encoded, now, expiresAt).run();
      if (!result.success) throw new Error(result.error ?? 'D1 conditional insert failed');
      return;
    }

    const result = await this.env.SWARM_STATE.prepare(
      `insert into swarm_kv (pk, sk, value, updated_at, expires_at)
       values (?, ?, ?, ?, ?)
       on conflict(pk, sk) do update set value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
    ).bind(key.pk, key.sk, encoded, now, expiresAt).run();
    if (!result.success) throw new Error(result.error ?? 'D1 state put failed');
  }

  async delete(key: CompositeKey): Promise<void> {
    const result = await this.env.SWARM_STATE.prepare(
      'delete from swarm_kv where pk = ? and sk = ?',
    ).bind(key.pk, key.sk).run();
    if (!result.success) throw new Error(result.error ?? 'D1 state delete failed');
  }

  async query<T extends JsonObject = JsonObject>(
    pk: string,
    options: { skPrefix?: string; limit?: number; scanForward?: boolean } = {},
  ): Promise<Array<HostedStateEntry<T>>> {
    const now = Date.now();
    const order = options.scanForward === false ? 'desc' : 'asc';
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.skPrefix
      ? await this.env.SWARM_STATE.prepare(
        `select pk, sk, value, updated_at, expires_at from swarm_kv
         where pk = ? and sk >= ? and sk < ? and (expires_at is null or expires_at > ?)
         order by sk ${order} limit ?`,
      ).bind(pk, options.skPrefix, `${options.skPrefix}\uffff`, now, limit).all<D1StateRow>()
      : await this.env.SWARM_STATE.prepare(
        `select pk, sk, value, updated_at, expires_at from swarm_kv
         where pk = ? and (expires_at is null or expires_at > ?)
         order by sk ${order} limit ?`,
      ).bind(pk, now, limit).all<D1StateRow>();
    if (!rows.success) throw new Error(rows.error ?? 'D1 state query failed');
    return (rows.results ?? []).map((row) => toStateEntry<T>(row));
  }
}

export class CloudflareR2BlobStore implements HostedBlobStore {
  constructor(private readonly env: CloudflareHostedBindings) {}

  async get(key: string): Promise<HostedBlob | null> {
    const object = await this.env.SWARM_BLOBS.get(key);
    if (!object) return null;
    return {
      key: object.key,
      body: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType,
      metadata: object.customMetadata,
    };
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array, options: HostedBlobPutOptions = {}): Promise<void> {
    await this.env.SWARM_BLOBS.put(key, body, {
      httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
      customMetadata: options.metadata,
    });
  }

  async delete(key: string): Promise<void> {
    await this.env.SWARM_BLOBS.delete(key);
  }
}

export class CloudflareQueueService implements HostedQueueService {
  constructor(private readonly queue: CloudflareQueue | undefined) {}

  async send<T extends JsonObject = JsonObject>(
    queueName: string,
    message: Omit<HostedQueueMessage<T>, 'enqueuedAt'>,
  ): Promise<void> {
    if (!this.queue) {
      throw new CloudflareFeatureNotImplementedError('Queues', 'SWARM_QUEUE binding is required.');
    }
    if (queueName !== 'default') {
      throw new CloudflareFeatureNotImplementedError('Named queues', 'Only the default SWARM_QUEUE binding is scaffolded.');
    }
    await this.queue.send({
      ...message,
      enqueuedAt: Date.now(),
    }, message.delaySeconds ? { delaySeconds: message.delaySeconds } : undefined);
  }
}

export class CloudflareScheduler implements HostedScheduler {
  constructor(private readonly env: CloudflareHostedBindings) {}

  async schedule<T extends JsonObject = JsonObject>(job: Omit<HostedScheduledJob<T>, 'createdAt'>): Promise<void> {
    const accountId = typeof job.payload.accountId === 'string' ? job.payload.accountId : '';
    const avatarId = typeof job.payload.avatarId === 'string' ? job.payload.avatarId : '';
    const summary = typeof job.payload.summary === 'string' ? job.payload.summary : job.type;
    if (!job.id.trim() || !job.type.trim() || !accountId || !avatarId || !Number.isFinite(job.runAt)) {
      throw new Error('Scheduled job is invalid.');
    }
    const result = await this.env.SWARM_STATE.prepare(
      `insert into swarm_hosted_scheduled_jobs
         (id, account_id, avatar_id, type, payload_json, summary, run_at, created_at, status)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    ).bind(
      job.id,
      accountId,
      avatarId,
      job.type,
      JSON.stringify(job.payload),
      summary.slice(0, 160),
      job.runAt,
      Date.now(),
    ).run();
    if (!result.success) throw new Error(result.error ?? 'Unable to schedule hosted work.');
  }

  async claimDueJobs(now: number, limit: number): Promise<Array<HostedScheduledJob>> {
    const recovered = await this.env.SWARM_STATE.prepare(
      `update swarm_hosted_scheduled_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           claimed_at = null,
           completed_at = case when attempts >= max_attempts then ? else completed_at end,
           error = case when attempts >= max_attempts then 'Attempt limit reached.' else 'Dispatch lease expired.' end
       where status = 'claimed' and claimed_at <= ?`,
    ).bind(now, now - 5 * 60_000).run();
    if (!recovered.success) throw new Error(recovered.error ?? 'Unable to recover scheduled work.');
    const due = await this.env.SWARM_STATE.prepare(
      `select id from swarm_hosted_scheduled_jobs
       where status = 'queued' and run_at <= ? and attempts < max_attempts order by run_at asc limit ?`,
    ).bind(now, Math.min(Math.max(limit, 1), 100)).all<{ id: string }>();
    if (!due.success) throw new Error(due.error ?? 'Unable to find scheduled work.');
    const claimed: HostedScheduledJob[] = [];
    for (const row of due.results ?? []) {
      const job = await this.env.SWARM_STATE.prepare(
        `update swarm_hosted_scheduled_jobs set status = 'claimed', claimed_at = ?, attempts = attempts + 1
         where id = ? and status = 'queued'
         returning id, type, payload_json, run_at, created_at`,
      ).bind(now, row.id).first<{
        id: string;
        type: string;
        payload_json: string;
        run_at: number;
        created_at: number;
      }>();
      if (!job) continue;
      try {
        const payload = JSON.parse(job.payload_json) as JsonObject;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
        claimed.push({ id: job.id, type: job.type, payload, runAt: job.run_at, createdAt: job.created_at });
      } catch {
        const failed = await this.env.SWARM_STATE.prepare(
          `update swarm_hosted_scheduled_jobs
           set status = 'failed', completed_at = ?, error = 'Scheduled payload is invalid.'
           where id = ? and status = 'claimed'`,
        ).bind(now, job.id).run();
        if (!failed.success) throw new Error(failed.error ?? 'Unable to fail invalid scheduled work.');
      }
    }
    return claimed;
  }

  async complete(id: string, now = Date.now()): Promise<void> {
    const result = await this.env.SWARM_STATE.prepare(
      `update swarm_hosted_scheduled_jobs
       set status = 'completed', completed_at = ?, error = null where id = ? and status = 'claimed'`,
    ).bind(now, id).run();
    if (!result.success) throw new Error(result.error ?? 'Unable to complete scheduled work.');
  }

  async retry(id: string, error: string, runAt: number): Promise<void> {
    const result = await this.env.SWARM_STATE.prepare(
      `update swarm_hosted_scheduled_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           run_at = ?, claimed_at = null, completed_at = case when attempts >= max_attempts then ? else null end,
           error = ? where id = ? and status = 'claimed'`,
    ).bind(runAt, Date.now(), error.slice(0, 240), id).run();
    if (!result.success) throw new Error(result.error ?? 'Unable to retry scheduled work.');
  }
}

export class CloudflareAvatarCoordinator implements HostedCoordinator {
  async withAvatarLock<T>(_avatarId: string, _work: () => Promise<T>): Promise<T> {
    throw new CloudflareFeatureNotImplementedError('Durable Object coordinator', 'Avatar locking must be routed through a Durable Object before hosted traffic uses it.');
  }

  async publishAvatarEvent(_avatarId: string, _event: JsonObject): Promise<void> {
    throw new CloudflareFeatureNotImplementedError('Durable Object realtime', 'Avatar event fanout is not wired yet.');
  }
}

export class CloudflareSecretStore implements HostedSecretStore {
  private readonly cipher: HostedSecretCipher;

  constructor(private readonly env: CloudflareHostedBindings) {
    this.cipher = createCloudflareSecretCipher(env);
  }

  async getPlatformSecret(name: string): Promise<string> {
    const value = this.env[name];
    if (typeof value !== 'string' || !value) {
      throw new Error(`Cloudflare platform secret ${name} is not bound.`);
    }
    return value;
  }

  async hasUserSecret(scope: HostedUserSecretScope, name: string): Promise<boolean> {
    assertSecretCoordinates(scope, name);
    const row = await this.env.SWARM_STATE.prepare(
      `select 1 as present from swarm_user_secrets
       where account_id = ? and tenant_id = ? and name = ?`,
    )
      .bind(scope.accountId, scope.tenantId ?? '', name)
      .first<{ present: number }>();
    return row?.present === 1;
  }

  async getUserSecret(scope: HostedUserSecretScope, name: string): Promise<string | null> {
    assertSecretCoordinates(scope, name);
    const tenantId = scope.tenantId ?? '';
    const row = await this.env.SWARM_STATE.prepare(
      `select envelope from swarm_user_secrets
       where account_id = ? and tenant_id = ? and name = ?`,
    )
      .bind(scope.accountId, tenantId, name)
      .first<{ envelope: string }>();
    if (!row) return null;
    return this.cipher.open(row.envelope, secretContext(scope, name));
  }

  async putUserSecret(scope: HostedUserSecretScope, name: string, value: string): Promise<void> {
    assertSecretCoordinates(scope, name);
    if (!value) throw new Error('Hosted user secrets cannot be empty.');
    const envelope = await this.cipher.seal(value, secretContext(scope, name));
    const tenantId = scope.tenantId ?? '';
    const result = await this.env.SWARM_STATE.prepare(
      `insert into swarm_user_secrets (account_id, tenant_id, name, envelope, key_version, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(account_id, tenant_id, name) do update set
         envelope = excluded.envelope,
         key_version = excluded.key_version,
         updated_at = excluded.updated_at`,
    )
      .bind(scope.accountId, tenantId, name, JSON.stringify(envelope), envelope.keyVersion, Date.now())
      .run();
    if (!result.success) throw new Error(result.error ?? 'D1 encrypted user secret write failed');
  }

  async deleteUserSecret(scope: HostedUserSecretScope, name: string): Promise<void> {
    assertSecretCoordinates(scope, name);
    const result = await this.env.SWARM_STATE.prepare(
      'delete from swarm_user_secrets where account_id = ? and tenant_id = ? and name = ?',
    )
      .bind(scope.accountId, scope.tenantId ?? '', name)
      .run();
    if (!result.success) throw new Error(result.error ?? 'D1 encrypted user secret deletion failed');
  }
}

export function createCloudflareSecretCipher(env: CloudflareHostedBindings): HostedSecretCipher {
  const activeKeyVersion = env.SWARM_USER_SECRET_KEY_VERSION?.trim() || 'v1';
  return new HostedSecretCipher(activeKeyVersion, (keyVersion) => {
    if (keyVersion === activeKeyVersion) {
      return env.SWARM_USER_SECRET_KEK?.trim() || null;
    }
    const suffix = keyVersion.toUpperCase().replace(/[^A-Z0-9]/gu, '_');
    const previousKey = env[`SWARM_USER_SECRET_KEK_${suffix}`];
    return typeof previousKey === 'string' && previousKey.trim() ? previousKey.trim() : null;
  });
}

function assertSecretCoordinates(scope: HostedUserSecretScope, name: string): void {
  if (!scope.accountId.trim() || scope.accountId.length > 160) {
    throw new Error('Hosted user secret account scope is invalid.');
  }
  if ((scope.tenantId?.length ?? 0) > 160) {
    throw new Error('Hosted user secret tenant scope is invalid.');
  }
  if (!name.trim() || name.length > 160) {
    throw new Error('Hosted user secret name is invalid.');
  }
}

function secretContext(scope: HostedUserSecretScope, name: string): string {
  return JSON.stringify([scope.accountId, scope.tenantId ?? '', name]);
}

export function createCloudflareHostedPlatform(env: CloudflareHostedBindings): HostedPlatform {
  const capabilities: HostedPlatform['descriptor']['capabilities'] = [
    'state',
    'blobs',
    'platform-secrets',
    'cron',
  ];
  if (env.SWARM_QUEUE) capabilities.push('queues');
  if (isHostedSecretKeyValid(env.SWARM_USER_SECRET_KEK)) capabilities.push('encrypted-user-secrets');
  return {
    descriptor: {
      kind: 'cloudflare',
      mode: 'hosted',
      displayName: 'Hosted Swarm',
      capabilities,
    },
    state: new CloudflareD1StateStore(env),
    blobs: new CloudflareR2BlobStore(env),
    queues: new CloudflareQueueService(env.SWARM_QUEUE),
    scheduler: new CloudflareScheduler(env),
    coordinator: new CloudflareAvatarCoordinator(),
    secrets: new CloudflareSecretStore(env),
  };
}
