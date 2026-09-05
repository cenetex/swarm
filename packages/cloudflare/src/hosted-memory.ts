import type { HostedSession } from './auth.js';
import { randomToken } from './auth.js';
import type { CloudflareHostedBindings } from './bindings.js';
import { getHostedAvatar } from './hosted-chat.js';
import { syncPortableAvatarSharedMemory } from './portable-avatars.js';

const MAX_MEMORIES = 100;
const MAX_MEMORY_LENGTH = 1_000;

type HostedMemoryRow = {
  memory_id: string;
  content: string;
  source: string;
  source_label: string | null;
  shareable: number;
  created_at: number;
  updated_at: number;
};

export type HostedMemory = {
  memoryId: string;
  content: string;
  source: string;
  sourceLabel?: string;
  shareable: boolean;
  createdAt: number;
  updatedAt: number;
};

function memoryFromRow(row: HostedMemoryRow): HostedMemory {
  return {
    memoryId: row.memory_id,
    content: row.content,
    source: row.source,
    ...(row.source_label ? { sourceLabel: row.source_label } : {}),
    shareable: row.shareable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertOwnedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<void> {
  if (!await getHostedAvatar(env, session, avatarId)) throw new HostedMemoryNotFoundError();
}

export class HostedMemoryNotFoundError extends Error {
  constructor() {
    super('Hosted memory was not found.');
    this.name = 'HostedMemoryNotFoundError';
  }
}

export async function listHostedMemories(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<HostedMemory[]> {
  await assertOwnedAvatar(env, session, avatarId);
  const result = await env.SWARM_STATE.prepare(
    `select memory_id, content, source, source_label, shareable, created_at, updated_at
     from swarm_hosted_memories
     where account_id = ? and avatar_id = ?
     order by created_at desc limit ?`,
  ).bind(session.accountId, avatarId, MAX_MEMORIES).all<HostedMemoryRow>();
  if (!result.success) throw new Error(result.error ?? 'Unable to list hosted memories.');
  return (result.results ?? []).map(memoryFromRow);
}

async function syncShareableMemory(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  now: number,
): Promise<void> {
  const memories = (await listHostedMemories(env, session, avatarId)).filter((memory) => memory.shareable);
  await syncPortableAvatarSharedMemory(env, session, avatarId, memories.map((memory) => ({
    id: memory.memoryId,
    createdAt: new Date(memory.createdAt).toISOString(),
    content: memory.content,
    source: memory.sourceLabel || memory.source,
  })), now);
}

export async function addHostedMemory(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; content: string; shareable?: boolean; sourceLabel?: string },
  now = Date.now(),
): Promise<HostedMemory> {
  await assertOwnedAvatar(env, session, input.avatarId);
  const content = input.content.trim();
  if (!content || content.length > MAX_MEMORY_LENGTH) throw new Error('Memory must be between 1 and 1,000 characters.');
  const count = await env.SWARM_STATE.prepare(
    'select count(*) as count from swarm_hosted_memories where account_id = ? and avatar_id = ?',
  ).bind(session.accountId, input.avatarId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_MEMORIES) throw new Error('This companion memory is full. Forget one item first.');
  const memory: HostedMemory = {
    memoryId: `memory_${randomToken(14)}`,
    content,
    source: 'owner-web',
    ...(input.sourceLabel?.trim() ? { sourceLabel: input.sourceLabel.trim() } : {}),
    shareable: input.shareable === true,
    createdAt: now,
    updatedAt: now,
  };
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_memories
       (account_id, avatar_id, memory_id, content, source, source_label, shareable, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    session.accountId,
    input.avatarId,
    memory.memoryId,
    memory.content,
    memory.source,
    memory.sourceLabel ?? null,
    memory.shareable ? 1 : 0,
    now,
    now,
  ).run();
  if (!result.success) throw new Error(result.error ?? 'Unable to save hosted memory.');
  if (memory.shareable) await syncShareableMemory(env, session, input.avatarId, now);
  return memory;
}

export async function deleteHostedMemory(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  memoryId: string,
  now = Date.now(),
): Promise<boolean> {
  await assertOwnedAvatar(env, session, avatarId);
  const existing = await env.SWARM_STATE.prepare(
    `select memory_id, content, source, source_label, shareable, created_at, updated_at
     from swarm_hosted_memories where account_id = ? and avatar_id = ? and memory_id = ?`,
  ).bind(session.accountId, avatarId, memoryId).first<HostedMemoryRow>();
  if (!existing) return false;
  const result = await env.SWARM_STATE.prepare(
    'delete from swarm_hosted_memories where account_id = ? and avatar_id = ? and memory_id = ?',
  ).bind(session.accountId, avatarId, memoryId).run();
  if (!result.success) throw new Error(result.error ?? 'Unable to forget hosted memory.');
  if (existing.shareable === 1) await syncShareableMemory(env, session, avatarId, now);
  return true;
}
