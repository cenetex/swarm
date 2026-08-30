import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import type { HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import {
  createPortableHostedAvatar,
  getOwnedPortableRevision,
  getPublicAvatar,
  importPortableHostedAvatar,
  listOwnedPortableAvatars,
  listPublicAvatars,
  updatePortableAvatarPublication,
} from './portable-avatars.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import worker from './worker.js';

class SqliteStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly db: Database, private readonly query: string) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const statement = this.db.query(this.query) as unknown as { get(...values: unknown[]): unknown };
    const row = statement.get(...this.values) as Record<string, unknown> | null;
    if (!row) return null;
    return (column ? row[column] : row) as T | null;
  }

  async all<T = unknown>() {
    const statement = this.db.query(this.query) as unknown as { all(...values: unknown[]): unknown[] };
    return { success: true, results: statement.all(...this.values) as T[] };
  }

  async run() {
    const statement = this.db.query(this.query) as unknown as { run(...values: unknown[]): unknown };
    statement.run(...this.values);
    return { success: true };
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
};

function setup() {
  const state = new SqliteD1();
  state.db.exec("insert into swarm_accounts (account_id, created_at) values ('account-1', 1)");
  const blobs = new Map<string, string>();
  const env: CloudflareHostedBindings = {
    SWARM_STATE: state,
    SWARM_BLOBS: {
      get: async (key) => {
        const value = blobs.get(key);
        return value === undefined ? null : {
          key,
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        };
      },
      put: async (key, body) => {
        blobs.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body));
      },
      delete: async (key) => { blobs.delete(key); },
    },
    SWARM_HOSTED_ENABLED: '1',
    SWARM_PUBLIC_URL: 'https://next.swarm.rati.chat',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(7)),
    SWARM_USER_SECRET_KEY_VERSION: 'v1',
  };
  return { state, env, blobs };
}

const resources: SqliteD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()?.close();
});

describe('portable public avatars', () => {
  it('keeps pre-migration avatars private and unlisted', () => {
    const database = new Database(':memory:');
    database.exec('pragma foreign_keys = on');
    for (const migration of ['0002_hosted_identity_and_secrets.sql', '0003_hosted_chat_runtime.sql']) {
      database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    database.exec("insert into swarm_accounts (account_id, created_at) values ('account-1', 1)");
    database.exec(`insert into swarm_hosted_avatars
      (account_id, avatar_id, default_thread_id, name, status, created_by, created_at, updated_at)
      values ('account-1', 'before-migration', 'thread-1', 'Before', 'shell',
              '11111111111111111111111111111111', 1, 1)`);

    database.exec(readFileSync(new URL('../migrations/0006_portable_public_avatars.sql', import.meta.url), 'utf8'));
    const row = database.query(
      "select visibility, listed from swarm_hosted_avatars where avatar_id = 'before-migration'",
    ).get() as { visibility: string; listed: number };
    expect(row).toEqual({ visibility: 'private', listed: 0 });
    database.close();
  });

  it('creates a public listed project and immutable R2 mirror by default', async () => {
    const { state, env, blobs } = setup();
    resources.push(state);

    const created = await createPortableHostedAvatar(env, owner, {
      name: 'Ada Commons',
      description: 'A public research egregore.',
      persona: 'Think carefully in public.',
    }, Date.parse('2026-08-30T12:00:00.000Z'));

    expect(created).toMatchObject({ visibility: 'public', listed: true });
    expect(created.revisionId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(blobs.size).toBe(1);
    const catalog = await listPublicAvatars(env);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ slug: created.slug, name: 'Ada Commons' });
    const project = await getPublicAvatar(env, created.slug);
    expect(project?.bundle.prompts.system).toBe('Think carefully in public.');
    expect(JSON.stringify(project)).not.toContain('apiKey');
    const plan = state.db.query(
      `explain query plan select avatar_id from swarm_hosted_avatars
       where visibility = 'public' and listed = 1 order by updated_at desc limit 100`,
    ).all();
    expect(JSON.stringify(plan)).toContain('swarm_hosted_avatars_catalog_idx');
  });

  it('keeps private projects out of anonymous reads but lets the owner export', async () => {
    const { state, env } = setup();
    resources.push(state);
    const created = await createPortableHostedAvatar(env, owner, {
      name: 'Private Lab',
      visibility: 'private',
      listed: true,
    });

    expect(created).toMatchObject({ visibility: 'private', listed: false });
    expect(await listPublicAvatars(env)).toEqual([]);
    expect(await getPublicAvatar(env, created.slug)).toBeNull();
    expect((await getOwnedPortableRevision(env, owner, created.avatarId))?.revisionId).toBe(created.revisionId);
  });

  it('restores an exported artifact into an empty environment with the same revision id', async () => {
    const source = setup();
    const target = setup();
    resources.push(source.state, target.state);
    const created = await createPortableHostedAvatar(source.env, owner, { name: 'Restorable Ada' }, 1_000);
    const exported = await getOwnedPortableRevision(source.env, owner, created.avatarId);
    expect(exported).not.toBeNull();

    const imported = await importPortableHostedAvatar(target.env, owner, exported?.bundle, 2_000);

    expect(imported.revisionId).toBe(created.revisionId);
    expect((await getPublicAvatar(target.env, imported.slug))?.revisionId).toBe(created.revisionId);
  });

  it('backfills a legacy avatar as private without changing its identity or owner', async () => {
    const { state, env } = setup();
    resources.push(state);
    state.db.exec(`insert into swarm_hosted_avatars
      (account_id, avatar_id, default_thread_id, name, description, persona, status, created_by, created_at, updated_at)
      values ('account-1', 'legacy-avatar', 'legacy-thread', 'Legacy Ada', 'Preserved project',
              'Keep the original prompt.', 'shell', '11111111111111111111111111111111', 1000, 2000)`);
    state.db.exec(`insert into swarm_hosted_chat_threads
      (account_id, avatar_id, thread_id, created_at, updated_at)
      values ('account-1', 'legacy-avatar', 'legacy-thread', 1000, 2000)`);

    const [backfilled] = await listOwnedPortableAvatars(env, owner);

    expect(backfilled).toMatchObject({
      avatarId: 'legacy-avatar',
      createdBy: '11111111111111111111111111111111',
      visibility: 'private',
      listed: false,
    });
    expect(await getPublicAvatar(env, 'legacy-avatar')).toBeNull();
    expect((await getOwnedPortableRevision(env, owner, 'legacy-avatar'))?.bundle.prompts.system)
      .toBe('Keep the original prompt.');

    const published = await updatePortableAvatarPublication(
      env,
      owner,
      'legacy-avatar',
      { visibility: 'public', listed: true },
      3_000,
    );
    expect(published?.revisionId).not.toBe(backfilled?.revisionId);
    expect(published?.visibility).toBe('public');
    expect((await getPublicAvatar(env, 'legacy-avatar'))?.bundle.lineage.previousRevisionId)
      .toBe(backfilled?.revisionId);
  });

  it('serves the catalog, portable download, NFT metadata, and sitemap without a session', async () => {
    const { state, env } = setup();
    resources.push(state);
    const created = await createPortableHostedAvatar(env, owner, { name: 'Public Ada' }, 1_000);

    const catalogResponse = await worker.fetch(new Request('https://next.swarm.rati.chat/api/public/avatars'), env);
    expect(catalogResponse.status).toBe(200);
    expect(await catalogResponse.json()).toMatchObject([{ slug: created.slug }]);

    const bundleResponse = await worker.fetch(
      new Request(`https://next.swarm.rati.chat/api/public/avatars/${created.slug}/bundle`),
      env,
    );
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get('Content-Disposition')).toContain('.swarm-avatar.json');
    expect((await bundleResponse.json()).schema).toBe('swarm.avatar/v1');

    const metadataResponse = await worker.fetch(
      new Request(`https://next.swarm.rati.chat/api/public/avatars/${created.slug}/nft-metadata`),
      env,
    );
    expect(await metadataResponse.json()).toMatchObject({
      properties: { revision_id: created.revisionId, bundle_sha256: created.sha256 },
    });

    const sitemapResponse = await worker.fetch(new Request('https://next.swarm.rati.chat/sitemap.xml'), env);
    expect(await sitemapResponse.text()).toContain(`/a/${created.slug}`);

    env.SWARM_ASSETS = {
      fetch: async () => new Response(`<!doctype html><html><head>
        <meta name="description" content="Catalog" />
        <meta property="og:title" content="Swarm" />
        <meta property="og:description" content="Catalog" />
        <meta property="og:image" content="https://next.swarm.rati.chat/og.png" />
        <meta name="twitter:title" content="Swarm" />
        <meta name="twitter:description" content="Catalog" />
        <meta name="twitter:image" content="https://next.swarm.rati.chat/og.png" />
        <title>Swarm</title></head><body></body></html>`, {
        headers: { 'Content-Type': 'text/html' },
      }),
    };
    const pageResponse = await worker.fetch(
      new Request(`https://next.swarm.rati.chat/a/${created.slug}`),
      env,
    );
    const pageHtml = await pageResponse.text();
    expect(pageHtml).toContain('<title>Public Ada — Swarm</title>');
    expect(pageHtml).toContain('Explore Public Ada on Swarm.');
    expect(pageHtml).toContain(`rel="canonical" href="https://next.swarm.rati.chat/a/${created.slug}"`);
    expect(pageHtml).not.toContain('og.png');
  });
});
