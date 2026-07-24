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
  HostedStateEntry,
  HostedStatePutOptions,
  HostedStateStore,
  JsonObject,
} from '@swarm/core';
import type { CloudflareHostedBindings, CloudflareQueue } from './bindings.js';
import { CloudflareFeatureNotImplementedError } from './errors.js';

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
  async schedule<T extends JsonObject = JsonObject>(_job: Omit<HostedScheduledJob<T>, 'createdAt'>): Promise<void> {
    throw new CloudflareFeatureNotImplementedError('Scheduler', 'Map scheduled jobs to D1 plus Cron/Workflows in the next migration slice.');
  }

  async claimDueJobs(_now: number, _limit: number): Promise<Array<HostedScheduledJob>> {
    throw new CloudflareFeatureNotImplementedError('Scheduler', 'Cron-triggered due job claiming is not wired yet.');
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
  constructor(private readonly env: CloudflareHostedBindings) {}

  async getPlatformSecret(name: string): Promise<string> {
    const value = this.env[name];
    if (typeof value !== 'string' || !value) {
      throw new Error(`Cloudflare platform secret ${name} is not bound.`);
    }
    return value;
  }

  async getUserSecret(_accountId: string, _name: string): Promise<string | null> {
    throw new CloudflareFeatureNotImplementedError('User secrets', 'Envelope encryption for D1/R2 user secrets must be implemented first.');
  }

  async putUserSecret(_accountId: string, _name: string, _value: string): Promise<void> {
    throw new CloudflareFeatureNotImplementedError('User secrets', 'Refusing to store user secrets without envelope encryption.');
  }

  async deleteUserSecret(_accountId: string, _name: string): Promise<void> {
    throw new CloudflareFeatureNotImplementedError('User secrets', 'Encrypted user secret deletion is not wired yet.');
  }
}

export function createCloudflareHostedPlatform(env: CloudflareHostedBindings): HostedPlatform {
  const capabilities: HostedPlatform['descriptor']['capabilities'] = [
    'state',
    'blobs',
    'platform-secrets',
  ];
  if (env.SWARM_QUEUE) capabilities.push('queues');
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
    scheduler: new CloudflareScheduler(),
    coordinator: new CloudflareAvatarCoordinator(),
    secrets: new CloudflareSecretStore(env),
  };
}
