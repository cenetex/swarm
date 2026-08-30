import {
  canonicalPortableAvatarJson,
  parsePortableAvatarBundle,
  portableAvatarRevision,
  type PortableAvatarBundleV1,
  type PortableAvatarRevision,
} from '@swarm/core/hosted';
import type { HostedSession } from './auth.js';
import { randomToken } from './auth.js';
import type {
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import { createHostedAvatar, getHostedAvatar, listHostedAvatars, type HostedAvatar } from './hosted-chat.js';

const MAX_PUBLIC_AVATARS = 100;
const PORTABLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type PublicAvatarRow = {
  account_id: string;
  avatar_id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  listed: number;
  current_revision_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type RevisionRow = {
  revision_id: string;
  sha256: string;
  bundle_key: string;
  bundle_json: string;
  created_at: number;
};

export type PublicAvatarSummary = {
  avatarId: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public';
  listed: boolean;
  revisionId: string;
  controller: string;
  createdAt: number;
  updatedAt: number;
};

export type PublicAvatarProject = PublicAvatarSummary & {
  bundle: PortableAvatarBundleV1;
  sha256: string;
};

export type PortableHostedAvatar = HostedAvatar & {
  slug: string;
  visibility: 'public' | 'private';
  listed: boolean;
  revisionId: string;
  sha256: string;
};

export class PortableAvatarConflictError extends Error {
  constructor(message = 'That portable avatar already exists.') {
    super(message);
    this.name = 'PortableAvatarConflictError';
  }
}

export class PortableAvatarAuthorizationError extends Error {
  constructor() {
    super('The connected wallet does not control this portable avatar.');
    this.name = 'PortableAvatarAuthorizationError';
  }
}

export class PortableAvatarDataError extends Error {
  constructor() {
    super('Portable avatar data could not be loaded.');
    this.name = 'PortableAvatarDataError';
  }
}

function ensureD1Result(success: boolean, error: string | undefined, message: string): void {
  if (!success) throw new Error(error ?? message);
}

async function runStatements(env: CloudflareHostedBindings, statements: CloudflareD1PreparedStatement[]): Promise<void> {
  if (env.SWARM_STATE.batch) {
    const results = await env.SWARM_STATE.batch(statements);
    for (const result of results) ensureD1Result(result.success, result.error, 'D1 batch failed.');
    return;
  }
  for (const statement of statements) {
    const result = await statement.run();
    ensureD1Result(result.success, result.error, 'D1 write failed.');
  }
}

function safeSlug(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60)
    .replace(/-$/u, '') || 'avatar';
  const safeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(-8) || 'project';
  return `${base}-${safeSuffix}`;
}

function validPortableSlug(value: string | undefined): value is string {
  return !!value && value.length <= 80 && PORTABLE_SLUG_PATTERN.test(value);
}

function bundleKey(avatarId: string, sha256: string): string {
  return `portable-avatars/${avatarId}/revisions/${sha256}.json`;
}

function bundleFromRow(row: RevisionRow): PortableAvatarRevision {
  try {
    const bundle = parsePortableAvatarBundle(JSON.parse(row.bundle_json) as unknown);
    return { revisionId: row.revision_id, sha256: row.sha256, bundle };
  } catch {
    throw new PortableAvatarDataError();
  }
}

function publicSummary(row: PublicAvatarRow, revision: PortableAvatarRevision): PublicAvatarSummary {
  return {
    avatarId: row.avatar_id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    visibility: 'public',
    listed: true,
    revisionId: row.current_revision_id,
    controller: revision.bundle.identity.controller.address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function persistRevision(
  env: CloudflareHostedBindings,
  session: HostedSession,
  revision: PortableAvatarRevision,
  now: number,
  createAvatar: boolean,
): Promise<void> {
  const { bundle } = revision;
  const key = bundleKey(bundle.identity.avatarId, revision.sha256);
  const canonicalJson = canonicalPortableAvatarJson(bundle);
  await env.SWARM_BLOBS.put(key, canonicalJson, {
    httpMetadata: { contentType: 'application/vnd.swarm.avatar+json' },
    customMetadata: {
      schema: bundle.schema,
      avatarId: bundle.identity.avatarId,
      revisionId: revision.revisionId,
      sha256: revision.sha256,
    },
  });

  const statements: CloudflareD1PreparedStatement[] = [];
  if (createAvatar) {
    const threadId = `thread_${randomToken(12)}`;
    statements.push(
      env.SWARM_STATE.prepare(
        `insert into swarm_hosted_avatars
           (account_id, avatar_id, default_thread_id, name, description, persona, status, created_by, created_at,
            updated_at, slug, visibility, listed, current_revision_id, current_bundle_key)
         values (?, ?, ?, ?, ?, ?, 'shell', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        session.accountId,
        bundle.identity.avatarId,
        threadId,
        bundle.identity.name,
        bundle.identity.description || null,
        bundle.prompts.system || null,
        session.walletAddress,
        now,
        now,
        bundle.identity.slug,
        bundle.publication.visibility,
        bundle.publication.listed ? 1 : 0,
        revision.revisionId,
        key,
      ),
      env.SWARM_STATE.prepare(
        `insert into swarm_hosted_chat_threads (account_id, avatar_id, thread_id, created_at, updated_at)
         values (?, ?, ?, ?, ?)`,
      ).bind(session.accountId, bundle.identity.avatarId, threadId, now, now),
    );
  } else {
    statements.push(
      env.SWARM_STATE.prepare(
        `update swarm_hosted_avatars
         set slug = ?, visibility = ?, listed = ?, current_revision_id = ?, current_bundle_key = ?,
             persona = ?, updated_at = ?
         where account_id = ? and avatar_id = ?`,
      ).bind(
        bundle.identity.slug,
        bundle.publication.visibility,
        bundle.publication.listed ? 1 : 0,
        revision.revisionId,
        key,
        bundle.prompts.system || null,
        now,
        session.accountId,
        bundle.identity.avatarId,
      ),
    );
  }
  statements.push(
    env.SWARM_STATE.prepare(
      `insert into swarm_hosted_avatar_revisions
         (account_id, avatar_id, revision_id, sha256, bundle_key, bundle_json, previous_revision_id,
          publicly_accessible, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      session.accountId,
      bundle.identity.avatarId,
      revision.revisionId,
      revision.sha256,
      key,
      canonicalJson,
      bundle.lineage.previousRevisionId ?? null,
      bundle.publication.visibility === 'public' ? 1 : 0,
      now,
    ),
  );
  try {
    await runStatements(env, statements);
  } catch (error) {
    await env.SWARM_BLOBS.delete(key).catch(() => undefined);
    throw error;
  }
}

export async function createPortableHostedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: {
    name: string;
    description?: string;
    persona?: string;
    visibility?: 'public' | 'private';
    listed?: boolean;
  },
  now = Date.now(),
): Promise<PortableHostedAvatar> {
  const avatar = await createHostedAvatar(env, session, {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
  }, now);
  const visibility = input.visibility ?? 'public';
  const listed = visibility === 'public' ? input.listed ?? true : false;
  const slug = safeSlug(avatar.name, avatar.avatarId);
  const bundle: PortableAvatarBundleV1 = {
    schema: 'swarm.avatar/v1',
    identity: {
      avatarId: avatar.avatarId,
      slug,
      name: avatar.name,
      description: avatar.description ?? '',
      controller: { type: 'solana-wallet', address: session.walletAddress },
    },
    publication: { visibility, listed },
    prompts: {
      system: input.persona?.trim() || `You are ${avatar.name}, a public Swarm avatar.`,
      starters: [],
    },
    capabilities: [{ id: 'conversation', name: 'Conversation' }],
    sharedMemory: { summary: '', entries: [] },
    media: [],
    lineage: {},
    revision: { createdAt: new Date(now).toISOString() },
  };
  const revision = await portableAvatarRevision(bundle);
  try {
    await persistRevision(env, session, revision, now, false);
  } catch (error) {
    await env.SWARM_STATE.prepare(
      'delete from swarm_hosted_avatars where account_id = ? and avatar_id = ?',
    ).bind(session.accountId, avatar.avatarId).run().catch(() => undefined);
    throw error;
  }
  return {
    ...avatar,
    slug,
    visibility,
    listed,
    revisionId: revision.revisionId,
    sha256: revision.sha256,
  };
}

async function migrateLegacyHostedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatar: HostedAvatar,
): Promise<PortableHostedAvatar> {
  const slug = validPortableSlug(avatar.slug) ? avatar.slug : safeSlug(avatar.name, avatar.avatarId);
  const bundle: PortableAvatarBundleV1 = {
    schema: 'swarm.avatar/v1',
    identity: {
      avatarId: avatar.avatarId,
      slug,
      name: avatar.name,
      description: avatar.description ?? '',
      controller: { type: 'solana-wallet', address: avatar.createdBy },
    },
    publication: { visibility: 'private', listed: false },
    prompts: {
      system: avatar.persona?.trim() || `You are ${avatar.name}, a private Swarm avatar.`,
      starters: [],
    },
    capabilities: [{ id: 'conversation', name: 'Conversation' }],
    sharedMemory: { summary: '', entries: [] },
    media: [],
    lineage: {},
    revision: { createdAt: new Date(avatar.createdAt).toISOString() },
  };
  const revision = await portableAvatarRevision(bundle);
  await persistRevision(env, session, revision, avatar.updatedAt, false);
  return {
    ...avatar,
    slug,
    visibility: 'private',
    listed: false,
    revisionId: revision.revisionId,
    sha256: revision.sha256,
  };
}

export async function listOwnedPortableAvatars(
  env: CloudflareHostedBindings,
  session: HostedSession,
): Promise<HostedAvatar[]> {
  const avatars = await listHostedAvatars(env, session);
  const result: HostedAvatar[] = [];
  for (const avatar of avatars) {
    if (avatar.revisionId) result.push(avatar);
    else result.push(await migrateLegacyHostedAvatar(env, session, avatar));
  }
  return result;
}

export async function importPortableHostedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  value: unknown,
  now = Date.now(),
): Promise<PortableHostedAvatar> {
  const revision = await portableAvatarRevision(value);
  const { bundle } = revision;
  if (bundle.identity.controller.address !== session.walletAddress) {
    throw new PortableAvatarAuthorizationError();
  }
  const existing = await env.SWARM_STATE.prepare(
    'select avatar_id from swarm_hosted_avatars where avatar_id = ? or slug = ? limit 1',
  ).bind(bundle.identity.avatarId, bundle.identity.slug).first<{ avatar_id: string }>();
  if (existing) throw new PortableAvatarConflictError();
  await persistRevision(env, session, revision, now, true);
  return {
    avatarId: bundle.identity.avatarId,
    name: bundle.identity.name,
    ...(bundle.identity.description ? { description: bundle.identity.description } : {}),
    ...(bundle.prompts.system ? { persona: bundle.prompts.system } : {}),
    status: 'shell',
    createdAt: now,
    updatedAt: now,
    createdBy: session.walletAddress,
    slug: bundle.identity.slug,
    visibility: bundle.publication.visibility,
    listed: bundle.publication.listed,
    revisionId: revision.revisionId,
    sha256: revision.sha256,
  };
}

export async function updatePortableAvatarPublication(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  publication: { visibility: 'public' | 'private'; listed?: boolean },
  now = Date.now(),
): Promise<PortableHostedAvatar | null> {
  const current = await getOwnedPortableRevision(env, session, avatarId);
  const avatar = await getHostedAvatar(env, session, avatarId);
  if (!current || !avatar) return null;
  const visibility = publication.visibility;
  const listed = visibility === 'public' ? publication.listed ?? true : false;
  const nextBundle: PortableAvatarBundleV1 = {
    ...current.bundle,
    publication: { visibility, listed },
    lineage: {
      ...current.bundle.lineage,
      previousRevisionId: current.revisionId,
    },
    revision: { createdAt: new Date(now).toISOString() },
  };
  const revision = await portableAvatarRevision(nextBundle);
  await persistRevision(env, session, revision, now, false);
  return {
    ...avatar,
    slug: nextBundle.identity.slug,
    visibility,
    listed,
    revisionId: revision.revisionId,
    sha256: revision.sha256,
  };
}

export async function listPublicAvatars(env: CloudflareHostedBindings): Promise<PublicAvatarSummary[]> {
  const result = await env.SWARM_STATE.prepare(
    `select account_id, avatar_id, slug, name, description, visibility, listed, current_revision_id,
            created_by, created_at, updated_at
     from swarm_hosted_avatars
     where visibility = 'public' and listed = 1 and current_revision_id is not null
     order by updated_at desc limit ?`,
  ).bind(MAX_PUBLIC_AVATARS).all<PublicAvatarRow>();
  ensureD1Result(result.success, result.error, 'Unable to list public avatars.');
  const summaries = await Promise.all((result.results ?? []).map(async (row) => {
    const revision = await getRevision(env, row.current_revision_id);
    return revision ? publicSummary(row, revision) : null;
  }));
  return summaries.filter((summary): summary is PublicAvatarSummary => summary !== null);
}

async function getRevision(env: CloudflareHostedBindings, revisionId: string): Promise<PortableAvatarRevision | null> {
  const row = await env.SWARM_STATE.prepare(
    `select revision_id, sha256, bundle_key, bundle_json, created_at
     from swarm_hosted_avatar_revisions where revision_id = ?`,
  ).bind(revisionId).first<RevisionRow>();
  return row ? bundleFromRow(row) : null;
}

export async function getPublicAvatar(
  env: CloudflareHostedBindings,
  slugOrId: string,
): Promise<PublicAvatarProject | null> {
  const row = await env.SWARM_STATE.prepare(
    `select account_id, avatar_id, slug, name, description, visibility, listed, current_revision_id,
            created_by, created_at, updated_at
     from swarm_hosted_avatars
     where (slug = ? or avatar_id = ?) and visibility = 'public' and current_revision_id is not null
     limit 1`,
  ).bind(slugOrId, slugOrId).first<PublicAvatarRow>();
  if (!row) return null;
  const revision = await getRevision(env, row.current_revision_id);
  if (!revision) return null;
  return { ...publicSummary(row, revision), listed: row.listed === 1, bundle: revision.bundle, sha256: revision.sha256 };
}

export async function getPublicRevision(
  env: CloudflareHostedBindings,
  revisionId: string,
): Promise<PortableAvatarRevision | null> {
  const published = await env.SWARM_STATE.prepare(
    `select revision_id, sha256, bundle_key, bundle_json, created_at
     from swarm_hosted_avatar_revisions
     where revision_id = ? and publicly_accessible = 1`,
  ).bind(revisionId).first<RevisionRow>();
  return published ? bundleFromRow(published) : null;
}

export async function getOwnedPortableRevision(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<PortableAvatarRevision | null> {
  const row = await env.SWARM_STATE.prepare(
    `select current_revision_id from swarm_hosted_avatars
     where account_id = ? and avatar_id = ? and current_revision_id is not null`,
  ).bind(session.accountId, avatarId).first<{ current_revision_id: string }>();
  return row ? getRevision(env, row.current_revision_id) : null;
}
