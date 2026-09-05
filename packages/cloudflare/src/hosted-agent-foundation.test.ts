import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import type { HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import { addHostedMemory, deleteHostedMemory, listHostedMemories } from './hosted-memory.js';
import { listHostedFollowUps, scheduleHostedFollowUp } from './hosted-follow-ups.js';
import { CloudflareScheduler } from './platform.js';
import { createPortableHostedAvatar, getOwnedPortableRevision } from './portable-avatars.js';

class SqliteStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly db: Database, private readonly query: string) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.db.query(this.query).get(...this.values) as Record<string, unknown> | null;
    if (!row) return null;
    return (column ? row[column] : row) as T | null;
  }

  async all<T = unknown>() {
    const results = this.db.query(this.query).all(...this.values) as T[];
    return { success: true, results };
  }

  async run() {
    const result = this.db.query(this.query).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

class SqliteD1 implements CloudflareD1Database {
  readonly db = new Database(':memory:');

  constructor() {
    this.db.exec('pragma foreign_keys = on');
    for (const migration of [
      '0002_hosted_identity_and_secrets.sql',
      '0003_hosted_chat_runtime.sql',
      '0006_portable_public_avatars.sql',
      '0009_passkeys.sql',
      '0013_hosted_agent_foundation.sql',
    ]) {
      this.db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
  }

  prepare(query: string): CloudflareD1PreparedStatement {
    return new SqliteStatement(this.db, query);
  }

  close(): void {
    this.db.close();
  }
}

const owner: HostedSession = {
  accountId: 'account-1',
  walletAddress: '11111111111111111111111111111111',
  expiresAt: 9_999_999,
  sessionHash: 'session-1',
  authProvider: 'passkey',
};

function setup() {
  const state = new SqliteD1();
  state.db.exec("insert into swarm_accounts (account_id, created_at) values ('account-1', 1)");
  const blobs = new Map<string, string>();
  const env: CloudflareHostedBindings = {
    SWARM_STATE: state,
    SWARM_BLOBS: {
      get: async () => null,
      put: async (key, body) => {
        blobs.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body));
      },
      delete: async (key) => { blobs.delete(key); },
    },
  };
  return { state, env };
}

const resources: SqliteD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()?.close();
});

describe('hosted agent foundation', () => {
  it('keeps memory private by default and exports only chosen items', async () => {
    const { state, env } = setup();
    resources.push(state);
    const avatar = await createPortableHostedAvatar(env, owner, { name: 'Ada' }, 1_000);

    await addHostedMemory(env, owner, { avatarId: avatar.avatarId, content: 'Private preference' }, 2_000);
    const shared = await addHostedMemory(env, owner, {
      avatarId: avatar.avatarId,
      content: 'Portable principle',
      shareable: true,
    }, 3_000);

    const memories = await listHostedMemories(env, owner, avatar.avatarId);
    expect(memories.map((memory) => ({ content: memory.content, shareable: memory.shareable }))).toEqual([
      { content: 'Portable principle', shareable: true },
      { content: 'Private preference', shareable: false },
    ]);
    const revision = await getOwnedPortableRevision(env, owner, avatar.avatarId);
    expect(revision?.bundle.sharedMemory.entries).toEqual([
      expect.objectContaining({ id: shared.memoryId, content: 'Portable principle', source: 'owner-web' }),
    ]);

    await deleteHostedMemory(env, owner, avatar.avatarId, shared.memoryId, 4_000);
    const nextRevision = await getOwnedPortableRevision(env, owner, avatar.avatarId);
    expect(nextRevision?.bundle.sharedMemory).toEqual({ summary: '', entries: [] });
  });

  it('claims each due follow-up once and keeps a visible receipt', async () => {
    const { state, env } = setup();
    resources.push(state);
    const avatar = await createPortableHostedAvatar(env, owner, { name: 'Ada' }, 1_000);
    const followUp = await scheduleHostedFollowUp(env, owner, {
      avatarId: avatar.avatarId,
      prompt: 'Check the launch plan',
      runAt: 70_000,
    }, 1_000);
    const scheduler = new CloudflareScheduler(env);

    expect(await scheduler.claimDueJobs(69_999, 10)).toEqual([]);
    expect(await scheduler.claimDueJobs(70_000, 10)).toEqual([
      expect.objectContaining({ id: followUp.id, type: 'swarm.hosted.follow-up', runAt: 70_000 }),
    ]);
    expect(await scheduler.claimDueJobs(70_000, 10)).toEqual([]);
    await scheduler.complete(followUp.id, 70_001);

    expect(await listHostedFollowUps(env, owner, avatar.avatarId)).toEqual([
      expect.objectContaining({ id: followUp.id, status: 'started', completedAt: 70_001 }),
    ]);
  });

  it('fails malformed scheduled work instead of leaving a claimed receipt', async () => {
    const { state, env } = setup();
    resources.push(state);
    const avatar = await createPortableHostedAvatar(env, owner, { name: 'Ada' }, 1_000);
    state.db.query(
      `insert into swarm_hosted_scheduled_jobs
         (id, account_id, avatar_id, type, payload_json, summary, run_at, created_at, status)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    ).run('bad-job', owner.accountId, avatar.avatarId, 'swarm.hosted.follow-up', '{', 'Bad job', 2_000, 1_000);
    const scheduler = new CloudflareScheduler(env);

    expect(await scheduler.claimDueJobs(2_000, 10)).toEqual([]);
    expect(state.db.query(
      'select status, completed_at, error from swarm_hosted_scheduled_jobs where id = ?',
    ).get('bad-job')).toEqual({
      status: 'failed',
      completed_at: 2_000,
      error: 'Scheduled payload is invalid.',
    });
  });
});
