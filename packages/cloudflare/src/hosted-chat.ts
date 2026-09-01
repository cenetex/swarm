import type { HostedSession } from './auth.js';
import { randomToken } from './auth.js';
import type {
  CloudflareD1PreparedStatement,
  CloudflareDurableObjectState,
  CloudflareHostedBindings,
  CloudflareQueueBatch,
} from './bindings.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { isHostedSecretKeyValid } from './secret-crypto.js';
import { hostedModelWorkAllowed } from './hosted-lifecycle.js';

const CHAT_RATE_WINDOW_MS = 60_000;
const DEFAULT_CHAT_RATE_LIMIT = 20;
const MAX_CHAT_RATE_LIMIT = 100;
const MAX_MODEL_ATTEMPTS = 3;
const MAX_HISTORY_MESSAGES = 20;
const COORDINATOR_LEASE_MS = 120_000;
const SAFE_MODEL_ERROR = 'The AI provider is temporarily unavailable. Try again later.';
const SAFE_MODEL_AUTH_ERROR = 'OpenRouter authorization is no longer valid. Reconnect OpenRouter and try again.';
const SAFE_MODEL_CREDIT_ERROR = 'This OpenRouter model needs credits. Add credits or choose a free model, then try again.';
const SAFE_MODEL_NOT_FOUND_ERROR = 'The configured OpenRouter model is unavailable. Choose another model and try again.';
const SAFE_MODEL_REQUEST_ERROR = 'OpenRouter rejected this message. Try a shorter message or another model.';
const SAFE_KEY_ERROR = 'Connect OpenRouter before sending a message.';
const SAFE_RUNTIME_ERROR = 'Hosted chat could not process this message. Try again later.';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';

export type HostedModelFailure = {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
};

function openRouterFailure(status?: number): HostedModelFailure {
  if (status === 401 || status === 403) {
    return { ok: false, code: 'model_unauthorized', message: SAFE_MODEL_AUTH_ERROR, retryable: false };
  }
  if (status === 402) {
    return { ok: false, code: 'model_payment_required', message: SAFE_MODEL_CREDIT_ERROR, retryable: false };
  }
  if (status === 404) {
    return { ok: false, code: 'model_not_found', message: SAFE_MODEL_NOT_FOUND_ERROR, retryable: false };
  }
  if (status === 400 || status === 413 || status === 422) {
    return { ok: false, code: 'model_request_rejected', message: SAFE_MODEL_REQUEST_ERROR, retryable: false };
  }
  return { ok: false, code: 'model_unavailable', message: SAFE_MODEL_ERROR, retryable: true };
}

function logOpenRouterFailure(requestId: string, failure: HostedModelFailure, status?: number): void {
  console.warn(JSON.stringify({
    level: 'WARN',
    subsystem: 'hosted-chat',
    event: 'openrouter_request_failed',
    requestId,
    code: failure.code,
    ...(status === undefined ? {} : { status }),
  }));
}

type HostedAvatarRow = {
  account_id: string;
  avatar_id: string;
  default_thread_id: string;
  name: string;
  description: string | null;
  persona: string | null;
  status: 'shell';
  created_by: string;
  created_at: number;
  updated_at: number;
  slug?: string | null;
  visibility?: 'public' | 'private';
  listed?: number;
  current_revision_id?: string | null;
};

type HostedChatMessageRow = {
  message_id: string;
  request_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
};

type HostedChatJobRow = {
  account_id: string;
  avatar_id: string;
  thread_id: string;
  job_id: string;
  request_id: string;
  status: 'queued' | 'processing' | 'retry' | 'completed' | 'dead';
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  response_message_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type HostedAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  slug?: string;
  visibility?: 'public' | 'private';
  listed?: boolean;
  revisionId?: string;
};

export type HostedChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type HostedChatQueueMessage = {
  type: 'swarm.hosted.chat.request';
  payload: {
    accountId: string;
    avatarId: string;
    jobId: string;
  };
  enqueuedAt: number;
};

export type HostedChatJobStatus = {
  jobId: string;
  type: 'chat';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  response?: string;
  history?: HostedChatHistoryMessage[];
  error?: string;
};

export class HostedChatRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('Too many chat messages. Try again shortly.');
    this.name = 'HostedChatRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class HostedChatConfigurationError extends Error {
  constructor() {
    super('Hosted chat is not configured.');
    this.name = 'HostedChatConfigurationError';
  }
}

export class HostedLifecycleInactiveError extends Error {
  constructor() {
    super('Hosted model work is paused until billing, provisioning, and runtime health are confirmed.');
    this.name = 'HostedLifecycleInactiveError';
  }
}

function assertHostedChatRuntimeReady(env: CloudflareHostedBindings): void {
  if (
    env.SWARM_HOSTED_ENABLED !== '1'
    || !isHostedSecretKeyValid(env.SWARM_USER_SECRET_KEK)
    || !env.SWARM_QUEUE
    || !env.SWARM_AVATAR_COORDINATORS
  ) {
    throw new HostedChatConfigurationError();
  }
}

function avatarFromRow(row: HostedAvatarRow): HostedAvatar {
  return {
    avatarId: row.avatar_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.persona ? { persona: row.persona } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    ...(row.slug ? { slug: row.slug } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    ...(row.listed === undefined ? {} : { listed: row.listed === 1 }),
    ...(row.current_revision_id ? { revisionId: row.current_revision_id } : {}),
  };
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

export async function createHostedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { name: string; description?: string },
  now = Date.now(),
): Promise<HostedAvatar> {
  const avatarId = `avatar_${randomToken(12)}`;
  const threadId = `thread_${randomToken(12)}`;
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const avatarStatement = env.SWARM_STATE.prepare(
    `insert into swarm_hosted_avatars
       (account_id, avatar_id, default_thread_id, name, description, persona, status, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, null, 'shell', ?, ?, ?)`,
  ).bind(
    session.accountId,
    avatarId,
    threadId,
    name,
    description,
    session.walletAddress,
    now,
    now,
  );
  const threadStatement = env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_threads (account_id, avatar_id, thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
  ).bind(session.accountId, avatarId, threadId, now, now);
  await runStatements(env, [avatarStatement, threadStatement]);
  return {
    avatarId,
    name,
    ...(description ? { description } : {}),
    status: 'shell',
    createdAt: now,
    updatedAt: now,
    createdBy: session.walletAddress,
  };
}

export async function listHostedAvatars(
  env: CloudflareHostedBindings,
  session: HostedSession,
): Promise<HostedAvatar[]> {
  const result = await env.SWARM_STATE.prepare(
    `select account_id, avatar_id, default_thread_id, name, description, persona, status,
            created_by, created_at, updated_at, slug, visibility, listed, current_revision_id
     from swarm_hosted_avatars where account_id = ? order by updated_at desc limit 100`,
  )
    .bind(session.accountId)
    .all<HostedAvatarRow>();
  ensureD1Result(result.success, result.error, 'Unable to list hosted avatars.');
  return (result.results ?? []).map(avatarFromRow);
}

export async function getHostedAvatar(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<HostedAvatar | null> {
  const row = await findHostedAvatarRow(env, session.accountId, avatarId);
  return row ? avatarFromRow(row) : null;
}

async function findHostedAvatarRow(
  env: CloudflareHostedBindings,
  accountId: string,
  avatarId: string,
): Promise<HostedAvatarRow | null> {
  return env.SWARM_STATE.prepare(
    `select account_id, avatar_id, default_thread_id, name, description, persona, status,
            created_by, created_at, updated_at, slug, visibility, listed, current_revision_id
     from swarm_hosted_avatars where account_id = ? and avatar_id = ?`,
  )
    .bind(accountId, avatarId)
    .first<HostedAvatarRow>();
}

export async function listHostedChatHistory(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<HostedChatHistoryMessage[] | null> {
  const avatar = await findHostedAvatarRow(env, session.accountId, avatarId);
  if (!avatar) return null;
  const result = await env.SWARM_STATE.prepare(
    `select message_id, request_id, role, content, created_at
     from swarm_hosted_chat_messages
     where account_id = ? and avatar_id = ? and thread_id = ?
     order by created_at asc, message_id asc limit 200`,
  )
    .bind(session.accountId, avatarId, avatar.default_thread_id)
    .all<HostedChatMessageRow>();
  ensureD1Result(result.success, result.error, 'Unable to load hosted chat history.');
  return (result.results ?? []).map((message) => ({ role: message.role, content: message.content }));
}

export async function clearHostedChatHistory(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<boolean> {
  const avatar = await findHostedAvatarRow(env, session.accountId, avatarId);
  if (!avatar) return false;
  await runStatements(env, [
    env.SWARM_STATE.prepare(
      `delete from swarm_hosted_chat_jobs where account_id = ? and avatar_id = ? and thread_id = ?`,
    ).bind(session.accountId, avatarId, avatar.default_thread_id),
    env.SWARM_STATE.prepare(
      `delete from swarm_hosted_chat_messages where account_id = ? and avatar_id = ? and thread_id = ?`,
    ).bind(session.accountId, avatarId, avatar.default_thread_id),
  ]);
  return true;
}

function configuredRateLimit(env: CloudflareHostedBindings): number {
  const value = Number(env.SWARM_HOSTED_CHAT_RATE_LIMIT ?? DEFAULT_CHAT_RATE_LIMIT);
  if (!Number.isInteger(value)) return DEFAULT_CHAT_RATE_LIMIT;
  return Math.min(Math.max(value, 1), MAX_CHAT_RATE_LIMIT);
}

async function enforceChatRateLimit(
  env: CloudflareHostedBindings,
  accountId: string,
  now: number,
): Promise<void> {
  const windowStart = Math.floor(now / CHAT_RATE_WINDOW_MS) * CHAT_RATE_WINDOW_MS;
  const expiresAt = windowStart + CHAT_RATE_WINDOW_MS * 2;
  const row = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_rate_limits (account_id, window_start, count, expires_at)
     values (?, ?, 1, ?)
     on conflict(account_id) do update set
       count = case
         when swarm_hosted_chat_rate_limits.window_start = excluded.window_start
           then swarm_hosted_chat_rate_limits.count + 1
         else 1
       end,
       window_start = excluded.window_start,
       expires_at = excluded.expires_at
     returning count`,
  )
    .bind(accountId, windowStart, expiresAt)
    .first<{ count: number }>();
  if (!row) throw new Error('Unable to enforce hosted chat rate limit.');
  if (row.count > configuredRateLimit(env)) {
    throw new HostedChatRateLimitError(
      Math.max(1, Math.ceil((windowStart + CHAT_RATE_WINDOW_MS - now) / 1000)),
    );
  }
}

async function findJobByRequest(
  env: CloudflareHostedBindings,
  accountId: string,
  avatarId: string,
  requestId: string,
): Promise<HostedChatJobRow | null> {
  return env.SWARM_STATE.prepare(
    `select account_id, avatar_id, thread_id, job_id, request_id, status, attempts, max_attempts,
            error_code, error_message, response_message_id, created_at, updated_at, completed_at
     from swarm_hosted_chat_jobs where account_id = ? and avatar_id = ? and request_id = ?`,
  )
    .bind(accountId, avatarId, requestId)
    .first<HostedChatJobRow>();
}

async function sendQueueMessage(env: CloudflareHostedBindings, message: HostedChatQueueMessage): Promise<void> {
  if (!env.SWARM_QUEUE) throw new Error('Hosted chat Queue binding is missing.');
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt += 1) {
    try {
      await env.SWARM_QUEUE.send(message);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Hosted chat Queue send failed.');
}

export async function enqueueHostedChat(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; message: string; requestId: string },
  now = Date.now(),
): Promise<{ jobId: string; replayed: boolean }> {
  assertHostedChatRuntimeReady(env);
  if (!await hostedModelWorkAllowed(env, session.accountId, now)) {
    throw new HostedLifecycleInactiveError();
  }
  if (!input.message.trim() || input.message.length > 4_000) throw new Error('Hosted chat message is invalid.');
  const avatar = await findHostedAvatarRow(env, session.accountId, input.avatarId);
  if (!avatar) throw new HostedChatNotFoundError();

  const platform = createCloudflareHostedPlatform(env);
  if (!(await platform.secrets.hasUserSecret({ accountId: session.accountId }, 'llm-api-key'))) {
    throw new HostedChatMissingKeyError();
  }

  const existing = await findJobByRequest(env, session.accountId, input.avatarId, input.requestId);
  if (existing) return { jobId: existing.job_id, replayed: true };
  await enforceChatRateLimit(env, session.accountId, now);

  const jobId = `job_${randomToken(18)}`;
  const messageId = `message_${randomToken(18)}`;
  const inserted = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_jobs
       (account_id, avatar_id, thread_id, job_id, request_id, status, attempts, max_attempts,
        error_code, error_message, response_message_id, created_at, updated_at, completed_at)
     values (?, ?, ?, ?, ?, 'queued', 0, ?, null, null, null, ?, ?, null)
     on conflict(account_id, avatar_id, request_id) do nothing
     returning account_id, avatar_id, thread_id, job_id, request_id, status, attempts, max_attempts,
               error_code, error_message, response_message_id, created_at, updated_at, completed_at`,
  )
    .bind(
      session.accountId,
      input.avatarId,
      avatar.default_thread_id,
      jobId,
      input.requestId,
      MAX_MODEL_ATTEMPTS,
      now,
      now,
    )
    .first<HostedChatJobRow>();

  if (!inserted) {
    const replay = await findJobByRequest(env, session.accountId, input.avatarId, input.requestId);
    if (!replay) throw new Error('Unable to resolve hosted chat replay.');
    return { jobId: replay.job_id, replayed: true };
  }

  const messageResult = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_messages
       (account_id, avatar_id, thread_id, message_id, request_id, role, content, created_at)
     values (?, ?, ?, ?, ?, 'user', ?, ?)`,
  )
    .bind(
      session.accountId,
      input.avatarId,
      avatar.default_thread_id,
      messageId,
      input.requestId,
      input.message,
      now,
    )
    .run();
  if (!messageResult.success) {
    await markJobDead(env, session.accountId, jobId, 'message_store_failed', SAFE_RUNTIME_ERROR, now);
    throw new Error(messageResult.error ?? 'Unable to store hosted chat message.');
  }

  const queueMessage: HostedChatQueueMessage = {
    type: 'swarm.hosted.chat.request',
    payload: { accountId: session.accountId, avatarId: input.avatarId, jobId },
    enqueuedAt: now,
  };
  try {
    await sendQueueMessage(env, queueMessage);
  } catch {
    await markJobDead(env, session.accountId, jobId, 'queue_unavailable', SAFE_RUNTIME_ERROR, now);
    throw new HostedChatQueueError();
  }
  return { jobId, replayed: false };
}

export class HostedChatNotFoundError extends Error {
  constructor() {
    super('Hosted avatar was not found.');
    this.name = 'HostedChatNotFoundError';
  }
}

export class HostedChatMissingKeyError extends Error {
  constructor() {
    super(SAFE_KEY_ERROR);
    this.name = 'HostedChatMissingKeyError';
  }
}

export class HostedChatQueueError extends Error {
  constructor() {
    super('Hosted chat is temporarily unavailable.');
    this.name = 'HostedChatQueueError';
  }
}

async function findJobById(
  env: CloudflareHostedBindings,
  accountId: string,
  jobId: string,
): Promise<HostedChatJobRow | null> {
  return env.SWARM_STATE.prepare(
    `select account_id, avatar_id, thread_id, job_id, request_id, status, attempts, max_attempts,
            error_code, error_message, response_message_id, created_at, updated_at, completed_at
     from swarm_hosted_chat_jobs where account_id = ? and job_id = ?`,
  )
    .bind(accountId, jobId)
    .first<HostedChatJobRow>();
}

export async function getHostedChatJob(
  env: CloudflareHostedBindings,
  session: HostedSession,
  jobId: string,
): Promise<HostedChatJobStatus | null> {
  const job = await findJobById(env, session.accountId, jobId);
  if (!job) return null;
  const status = job.status === 'completed'
    ? 'completed'
    : job.status === 'dead'
      ? 'failed'
      : job.status === 'processing'
        ? 'processing'
        : 'pending';
  let response: string | undefined;
  if (job.response_message_id) {
    const answer = await env.SWARM_STATE.prepare(
      `select content from swarm_hosted_chat_messages where account_id = ? and message_id = ? and role = 'assistant'`,
    )
      .bind(session.accountId, job.response_message_id)
      .first<{ content: string }>();
    response = answer?.content;
  }
  const history = status === 'completed'
    ? await listHostedChatHistory(env, session, job.avatar_id) ?? undefined
    : undefined;
  return {
    jobId: job.job_id,
    type: 'chat',
    status,
    prompt: '',
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    ...(job.completed_at ? { completedAt: job.completed_at } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(history ? { history } : {}),
    ...(status === 'failed' ? { error: job.error_message || SAFE_RUNTIME_ERROR } : {}),
  };
}

function validQueueMessage(value: unknown): value is HostedChatQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<HostedChatQueueMessage>;
  const payload = message.payload;
  return message.type === 'swarm.hosted.chat.request'
    && !!payload
    && typeof payload.accountId === 'string'
    && payload.accountId.length <= 160
    && typeof payload.avatarId === 'string'
    && payload.avatarId.length <= 160
    && typeof payload.jobId === 'string'
    && payload.jobId.length <= 160;
}

type QueueDisposition = { action: 'ack' } | { action: 'retry'; delaySeconds: number };

async function claimCoordinator(
  env: CloudflareHostedBindings,
  payload: HostedChatQueueMessage['payload'],
): Promise<{ acquired: boolean; stub: { fetch(request: Request): Promise<Response> } }> {
  if (!env.SWARM_AVATAR_COORDINATORS) throw new Error('Hosted avatar coordinator binding is missing.');
  const id = env.SWARM_AVATAR_COORDINATORS.idFromName(`${payload.accountId}:${payload.avatarId}`);
  const stub = env.SWARM_AVATAR_COORDINATORS.get(id);
  const response = await stub.fetch(new Request('https://coordinator.internal/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: payload.jobId }),
  }));
  if (response.status === 409) return { acquired: false, stub };
  if (!response.ok) throw new Error('Hosted avatar coordinator rejected the lease.');
  return { acquired: true, stub };
}

async function releaseCoordinator(stub: { fetch(request: Request): Promise<Response> }, jobId: string): Promise<void> {
  await stub.fetch(new Request('https://coordinator.internal/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  }));
}

async function claimJob(
  env: CloudflareHostedBindings,
  payload: HostedChatQueueMessage['payload'],
  now: number,
): Promise<HostedChatJobRow | null> {
  return env.SWARM_STATE.prepare(
    `update swarm_hosted_chat_jobs
     set status = 'processing', attempts = attempts + 1, updated_at = ?
     where account_id = ? and avatar_id = ? and job_id = ?
       and status in ('queued', 'retry') and attempts < max_attempts
     returning account_id, avatar_id, thread_id, job_id, request_id, status, attempts, max_attempts,
               error_code, error_message, response_message_id, created_at, updated_at, completed_at`,
  )
    .bind(now, payload.accountId, payload.avatarId, payload.jobId)
    .first<HostedChatJobRow>();
}

async function markJobDead(
  env: CloudflareHostedBindings,
  accountId: string,
  jobId: string,
  errorCode: string,
  errorMessage: string,
  now: number,
): Promise<void> {
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_chat_jobs
     set status = 'dead', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
     where account_id = ? and job_id = ? and status != 'completed'`,
  )
    .bind(errorCode, errorMessage, now, now, accountId, jobId)
    .run();
  ensureD1Result(result.success, result.error, 'Unable to record hosted chat failure.');
}

async function recordProcessingFailure(
  env: CloudflareHostedBindings,
  job: HostedChatJobRow,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
  now: number,
): Promise<QueueDisposition> {
  const willRetry = retryable && job.attempts < job.max_attempts;
  const status = willRetry ? 'retry' : 'dead';
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_chat_jobs
     set status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
     where account_id = ? and job_id = ? and status = 'processing'`,
  )
    .bind(
      status,
      errorCode,
      errorMessage,
      now,
      willRetry ? null : now,
      job.account_id,
      job.job_id,
    )
    .run();
  ensureD1Result(result.success, result.error, 'Unable to record hosted chat retry.');
  return willRetry
    ? { action: 'retry', delaySeconds: Math.min(30, 2 ** job.attempts) }
    : { action: 'ack' };
}

async function loadModelMessages(
  env: CloudflareHostedBindings,
  job: HostedChatJobRow,
): Promise<HostedChatMessageRow[]> {
  const result = await env.SWARM_STATE.prepare(
    `select message_id, request_id, role, content, created_at
     from swarm_hosted_chat_messages
     where account_id = ? and avatar_id = ? and thread_id = ?
       and (created_at < ? or request_id = ?)
     order by created_at desc, message_id desc limit ?`,
  )
    .bind(
      job.account_id,
      job.avatar_id,
      job.thread_id,
      job.created_at,
      job.request_id,
      MAX_HISTORY_MESSAGES,
    )
    .all<HostedChatMessageRow>();
  ensureD1Result(result.success, result.error, 'Unable to load hosted chat context.');
  return (result.results ?? []).reverse();
}

async function callOpenRouter(
  env: CloudflareHostedBindings,
  apiKey: string,
  avatar: HostedAvatarRow,
  messages: HostedChatMessageRow[],
  requestId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; content: string } | HostedModelFailure> {
  const endpoint = env.SWARM_OPENROUTER_CHAT_URL?.trim() || 'https://openrouter.ai/api/v1/chat/completions';
  const systemMessages = avatar.persona?.trim()
    ? [{ role: 'system' as const, content: avatar.persona }]
    : [];
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Swarm Hosted',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({
        model: env.SWARM_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
        max_tokens: 512,
        messages: [
          ...systemMessages,
          ...messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
    });
  } catch {
    const failure = openRouterFailure();
    logOpenRouterFailure(requestId, failure);
    return failure;
  }
  if (!response.ok) {
    const failure = openRouterFailure(response.status);
    logOpenRouterFailure(requestId, failure, response.status);
    return failure;
  }
  try {
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return { ok: true, content: content.trim() };
    const failure = openRouterFailure();
    logOpenRouterFailure(requestId, failure, response.status);
    return failure;
  } catch {
    const failure = openRouterFailure();
    logOpenRouterFailure(requestId, failure);
    return failure;
  }
}

export async function generateHostedReply(
  env: CloudflareHostedBindings,
  input: {
    accountId: string;
    avatarId: string;
    threadId: string;
    requestId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; content: string } | HostedModelFailure> {
  if (!await hostedModelWorkAllowed(env, input.accountId)) {
    return {
      ok: false,
      code: 'hosted_lifecycle_inactive',
      message: 'Hosted model work is paused until billing and runtime health recover.',
      retryable: false,
    };
  }
  const avatar = await findHostedAvatarRow(env, input.accountId, input.avatarId);
  if (!avatar) {
    return { ok: false, code: 'avatar_missing', message: SAFE_RUNTIME_ERROR, retryable: false };
  }
  const apiKey = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
    { accountId: input.accountId },
    'llm-api-key',
  );
  if (!apiKey) {
    return { ok: false, code: 'key_missing', message: SAFE_KEY_ERROR, retryable: false };
  }
  const result = await env.SWARM_STATE.prepare(
    `select message_id, request_id, role, content, created_at
     from swarm_hosted_chat_messages
     where account_id = ? and avatar_id = ? and thread_id = ?
     order by created_at desc, message_id desc limit ?`,
  )
    .bind(input.accountId, input.avatarId, input.threadId, MAX_HISTORY_MESSAGES)
    .all<HostedChatMessageRow>();
  ensureD1Result(result.success, result.error, 'Unable to load hosted chat context.');
  return callOpenRouter(
    env,
    apiKey,
    avatar,
    (result.results ?? []).reverse(),
    input.requestId,
    fetchImpl,
  );
}

export async function storeHostedAssistantMessage(
  env: CloudflareHostedBindings,
  input: {
    accountId: string;
    avatarId: string;
    threadId: string;
    requestId: string;
    content: string;
    createdAt: number;
  },
): Promise<void> {
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_messages
       (account_id, avatar_id, thread_id, message_id, request_id, role, content, created_at)
     values (?, ?, ?, ?, ?, 'assistant', ?, ?)
     on conflict(account_id, avatar_id, request_id, role) do nothing`,
  )
    .bind(
      input.accountId,
      input.avatarId,
      input.threadId,
      `message_${randomToken(18)}`,
      input.requestId,
      input.content,
      input.createdAt,
    )
    .run();
  ensureD1Result(result.success, result.error, 'Unable to store hosted assistant message.');
}

async function completeJob(
  env: CloudflareHostedBindings,
  job: HostedChatJobRow,
  content: string,
  now: number,
): Promise<void> {
  const responseMessageId = `message_${randomToken(18)}`;
  await runStatements(env, [
    env.SWARM_STATE.prepare(
      `insert into swarm_hosted_chat_messages
         (account_id, avatar_id, thread_id, message_id, request_id, role, content, created_at)
       values (?, ?, ?, ?, ?, 'assistant', ?, ?)
       on conflict(account_id, avatar_id, request_id, role) do nothing`,
    ).bind(
      job.account_id,
      job.avatar_id,
      job.thread_id,
      responseMessageId,
      job.request_id,
      content,
      now,
    ),
    env.SWARM_STATE.prepare(
      `update swarm_hosted_chat_jobs
       set status = 'completed', error_code = null, error_message = null,
           response_message_id = ?, updated_at = ?, completed_at = ?
       where account_id = ? and job_id = ? and status = 'processing'`,
    ).bind(responseMessageId, now, now, job.account_id, job.job_id),
  ]);
}

async function processClaimedJob(
  env: CloudflareHostedBindings,
  payload: HostedChatQueueMessage['payload'],
  fetchImpl: typeof fetch,
  now: number,
): Promise<QueueDisposition> {
  const job = await claimJob(env, payload, now);
  if (!job) return { action: 'ack' };
  try {
    if (!await hostedModelWorkAllowed(env, job.account_id, now)) {
      return recordProcessingFailure(
        env,
        job,
        'hosted_lifecycle_inactive',
        'Hosted model work is paused until billing and runtime health recover.',
        false,
        now,
      );
    }
    assertHostedChatRuntimeReady(env);
    const avatar = await findHostedAvatarRow(env, job.account_id, job.avatar_id);
    if (!avatar) {
      return recordProcessingFailure(env, job, 'avatar_missing', SAFE_RUNTIME_ERROR, false, now);
    }
    const apiKey = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
      { accountId: job.account_id },
      'llm-api-key',
    );
    if (!apiKey) return recordProcessingFailure(env, job, 'key_missing', SAFE_KEY_ERROR, false, now);
    const messages = await loadModelMessages(env, job);
    const modelResult = await callOpenRouter(env, apiKey, avatar, messages, job.request_id, fetchImpl);
    if (!modelResult.ok) {
      return recordProcessingFailure(
        env,
        job,
        modelResult.code,
        modelResult.message,
        modelResult.retryable,
        now,
      );
    }
    await completeJob(env, job, modelResult.content, now);
    return { action: 'ack' };
  } catch {
    return recordProcessingFailure(env, job, 'runtime_failed', SAFE_RUNTIME_ERROR, true, now);
  }
}

export async function processHostedChatQueueMessage(
  env: CloudflareHostedBindings,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<QueueDisposition> {
  if (!validQueueMessage(value)) return { action: 'ack' };
  const lease = await claimCoordinator(env, value.payload);
  if (!lease.acquired) return { action: 'retry', delaySeconds: 2 };
  try {
    return await processClaimedJob(env, value.payload, fetchImpl, now);
  } finally {
    await releaseCoordinator(lease.stub, value.payload.jobId);
  }
}

export async function processHostedChatQueueBatch(
  batch: CloudflareQueueBatch,
  env: CloudflareHostedBindings,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    try {
      const disposition = await processHostedChatQueueMessage(env, message.body);
      if (disposition.action === 'retry') message.retry({ delaySeconds: disposition.delaySeconds });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 10 });
    }
  }));
}

export async function cleanupHostedChatRuntime(
  env: CloudflareHostedBindings,
  now = Date.now(),
): Promise<void> {
  await runStatements(env, [
    env.SWARM_STATE.prepare(
      'delete from swarm_hosted_chat_rate_limits where expires_at <= ?',
    ).bind(now),
    env.SWARM_STATE.prepare(
      `update swarm_hosted_chat_jobs
       set status = 'dead', error_code = 'worker_interrupted', error_message = ?,
           updated_at = ?, completed_at = ?
       where status = 'processing' and updated_at <= ?`,
    ).bind(SAFE_RUNTIME_ERROR, now, now, now - COORDINATOR_LEASE_MS),
  ]);
}

type CoordinatorLease = { jobId: string; expiresAt: number };

export class HostedAvatarCoordinatorDurableObject {
  constructor(private readonly state: CloudflareDurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    let jobId = '';
    try {
      const body = await request.json() as { jobId?: unknown };
      if (typeof body.jobId === 'string' && body.jobId.length <= 160) jobId = body.jobId;
    } catch {
      return new Response('Invalid request.', { status: 400 });
    }
    if (!jobId) return new Response('jobId is required.', { status: 400 });
    const path = new URL(request.url).pathname;
    return this.state.blockConcurrencyWhile(async () => {
      const lease = await this.state.storage.get<CoordinatorLease>('lease');
      if (path === '/claim') {
        if (lease && lease.jobId !== jobId && lease.expiresAt > Date.now()) {
          return new Response('Avatar is busy.', { status: 409 });
        }
        await this.state.storage.put('lease', { jobId, expiresAt: Date.now() + COORDINATOR_LEASE_MS });
        return new Response(null, { status: 204 });
      }
      if (path === '/release') {
        if (lease?.jobId === jobId) await this.state.storage.delete('lease');
        return new Response(null, { status: 204 });
      }
      return new Response('Not found.', { status: 404 });
    });
  }
}
