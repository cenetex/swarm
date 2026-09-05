import type { HostedSession } from './auth.js';
import { randomToken } from './auth.js';
import type { CloudflareHostedBindings } from './bindings.js';
import { enqueueHostedChat, getHostedAvatar, HostedChatNotFoundError } from './hosted-chat.js';
import { CloudflareScheduler } from './platform.js';

const MIN_FOLLOW_UP_DELAY_MS = 60_000;
const MAX_FOLLOW_UP_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

type FollowUpRow = {
  id: string;
  summary: string;
  run_at: number;
  created_at: number;
  status: 'queued' | 'claimed' | 'completed' | 'failed';
  completed_at: number | null;
  error: string | null;
};

export type HostedFollowUp = {
  id: string;
  summary: string;
  runAt: number;
  createdAt: number;
  status: 'scheduled' | 'starting' | 'started' | 'failed';
  completedAt?: number;
  error?: string;
};

export type HostedFollowUpQueueMessage = {
  type: 'swarm.hosted.follow-up';
  payload: {
    scheduledJobId: string;
    accountId: string;
    avatarId: string;
    prompt: string;
  };
  enqueuedAt: number;
};

function followUpFromRow(row: FollowUpRow): HostedFollowUp {
  const status = row.status === 'queued'
    ? 'scheduled'
    : row.status === 'claimed'
      ? 'starting'
      : row.status === 'completed'
        ? 'started'
        : 'failed';
  return {
    id: row.id,
    summary: row.summary,
    runAt: row.run_at,
    createdAt: row.created_at,
    status,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export async function scheduleHostedFollowUp(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; prompt: string; runAt: number },
  now = Date.now(),
): Promise<HostedFollowUp> {
  if (!await getHostedAvatar(env, session, input.avatarId)) throw new HostedChatNotFoundError();
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4_000) throw new Error('Follow-up prompt must be between 1 and 4,000 characters.');
  if (!Number.isFinite(input.runAt) || input.runAt < now + MIN_FOLLOW_UP_DELAY_MS) {
    throw new Error('Choose a follow-up time at least one minute from now.');
  }
  if (input.runAt > now + MAX_FOLLOW_UP_DELAY_MS) throw new Error('Choose a follow-up time within 30 days.');
  const id = `followup_${randomToken(16)}`;
  const summary = prompt.slice(0, 160);
  await new CloudflareScheduler(env).schedule({
    id,
    type: 'swarm.hosted.follow-up',
    runAt: input.runAt,
    payload: {
      accountId: session.accountId,
      avatarId: input.avatarId,
      prompt,
      summary,
    },
  });
  return { id, summary, runAt: input.runAt, createdAt: now, status: 'scheduled' };
}

export async function listHostedFollowUps(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<HostedFollowUp[]> {
  if (!await getHostedAvatar(env, session, avatarId)) throw new HostedChatNotFoundError();
  const result = await env.SWARM_STATE.prepare(
    `select id, summary, run_at, created_at, status, completed_at, error
     from swarm_hosted_scheduled_jobs
     where account_id = ? and avatar_id = ? and type = 'swarm.hosted.follow-up'
     order by created_at desc limit 50`,
  ).bind(session.accountId, avatarId).all<FollowUpRow>();
  if (!result.success) throw new Error(result.error ?? 'Unable to list follow-ups.');
  return (result.results ?? []).map(followUpFromRow);
}

export async function cancelHostedFollowUp(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  id: string,
): Promise<boolean> {
  const result = await env.SWARM_STATE.prepare(
    `delete from swarm_hosted_scheduled_jobs
     where id = ? and account_id = ? and avatar_id = ? and status = 'queued'`,
  ).bind(id, session.accountId, avatarId).run();
  if (!result.success) throw new Error(result.error ?? 'Unable to cancel the follow-up.');
  return Number(result.meta?.changes ?? 0) > 0;
}

export function isHostedFollowUpQueueMessage(value: unknown): value is HostedFollowUpQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<HostedFollowUpQueueMessage>;
  const payload = message.payload;
  return message.type === 'swarm.hosted.follow-up'
    && !!payload
    && typeof payload.scheduledJobId === 'string'
    && typeof payload.accountId === 'string'
    && typeof payload.avatarId === 'string'
    && typeof payload.prompt === 'string';
}

export async function processHostedFollowUpQueueMessage(
  env: CloudflareHostedBindings,
  value: unknown,
  now = Date.now(),
): Promise<{ action: 'ack' }> {
  if (!isHostedFollowUpQueueMessage(value)) return { action: 'ack' };
  const { payload } = value;
  const avatar = await env.SWARM_STATE.prepare(
    'select created_by from swarm_hosted_avatars where account_id = ? and avatar_id = ?',
  ).bind(payload.accountId, payload.avatarId).first<{ created_by: string }>();
  const scheduler = new CloudflareScheduler(env);
  if (!avatar) {
    await scheduler.complete(payload.scheduledJobId, now);
    return { action: 'ack' };
  }
  try {
    await enqueueHostedChat(env, {
      accountId: payload.accountId,
      walletAddress: avatar.created_by,
      expiresAt: now + 60_000,
      sessionHash: `scheduled_${payload.scheduledJobId}`,
      authProvider: 'passkey',
    }, {
      avatarId: payload.avatarId,
      message: payload.prompt,
      requestId: `scheduled_${payload.scheduledJobId}`,
      source: 'owner-follow-up',
      trust: 'owner',
      sourceLabel: 'scheduled follow-up',
    }, now);
    await scheduler.complete(payload.scheduledJobId, now);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Follow-up could not start.';
    await scheduler.retry(payload.scheduledJobId, detail, now + 60_000);
  }
  return { action: 'ack' };
}
