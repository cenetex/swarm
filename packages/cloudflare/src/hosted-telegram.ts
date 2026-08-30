import type { HostedSession } from './auth.js';
import { randomToken, sha256 } from './auth.js';
import type { CloudflareHostedBindings } from './bindings.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { generateHostedReply, getHostedAvatar, storeHostedAssistantMessage } from './hosted-chat.js';

const TELEGRAM_API = 'https://api.telegram.org';
const OWNER_BIND_TTL_MS = 24 * 60 * 60 * 1_000;
const GROUP_BIND_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_UPDATE_BYTES = 256 * 1_024;
const MAX_ATTEMPTS = 3;
const TOKEN_SECRET = 'telegram-bot-token';
const WEBHOOK_SECRET = 'telegram-webhook-secret';
const OWNER_CODE_SECRET = 'telegram-owner-bind-code';
const GROUP_CODE_SECRET = 'telegram-group-bind-code';

type TelegramIntegrationRow = {
  account_id: string;
  avatar_id: string;
  integration_id: string;
  bot_user_id: string;
  bot_username: string;
  bot_name: string;
  status: 'binding_required' | 'connected' | 'repair_needed';
  owner_telegram_user_id: string | null;
  owner_bind_code_hash: string | null;
  owner_bind_expires_at: number | null;
  group_bind_code_hash: string;
  group_bind_expires_at: number;
  created_at: number;
  updated_at: number;
};

type TelegramChatRow = {
  integration_id: string;
  account_id: string;
  avatar_id: string;
  chat_id: string;
  chat_type: string;
  thread_id: string;
  title: string | null;
  enabled: number;
  bound_by: string;
  created_at: number;
  updated_at: number;
};

type TelegramUpdateRow = {
  integration_id: string;
  update_id: string;
  account_id: string;
  avatar_id: string;
  chat_id: string | null;
  thread_id: string | null;
  job_id: string | null;
  request_id: string | null;
  status: 'received' | 'ignored' | 'queued' | 'processing' | 'retry' | 'sending' | 'completed' | 'failed' | 'unknown';
  attempts: number;
  max_attempts: number;
  response_text: string | null;
  telegram_message_id: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type TelegramUser = { id?: unknown; is_bot?: unknown; first_name?: unknown; username?: unknown };
type TelegramChat = { id?: unknown; type?: unknown; title?: unknown; username?: unknown; first_name?: unknown };
type TelegramMessage = {
  message_id?: unknown;
  text?: unknown;
  from?: TelegramUser;
  chat?: TelegramChat;
  reply_to_message?: { from?: TelegramUser };
};
type TelegramUpdate = { update_id?: unknown; message?: TelegramMessage; edited_message?: TelegramMessage };

type TelegramApiEnvelope<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};
type TelegramWebhookInfo = { url?: unknown };

export type HostedTelegramStatus = {
  connected: boolean;
  status: 'disconnected' | 'binding_required' | 'connected' | 'repair_needed';
  bot?: { id: string; username: string; name: string };
  ownerBound: boolean;
  ownerBindUrl?: string;
  addToGroupUrl?: string;
};

export type HostedTelegramQueueMessage = {
  type: 'swarm.hosted.telegram.update';
  payload: { integrationId: string; jobId: string };
  enqueuedAt: number;
};

type QueueDisposition = { action: 'ack' } | { action: 'retry'; delaySeconds: number };

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class HostedTelegramConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedTelegramConflictError';
  }
}

export class HostedTelegramNotFoundError extends Error {
  constructor(message = 'Telegram connector was not found.') {
    super(message);
    this.name = 'HostedTelegramNotFoundError';
  }
}

export class HostedTelegramAuthorizationError extends Error {
  constructor() {
    super('Telegram webhook authorization failed.');
    this.name = 'HostedTelegramAuthorizationError';
  }
}

function ensureWrite(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) throw new Error(result.error ?? fallback);
}

function secretScope(accountId: string, avatarId: string) {
  return { accountId, tenantId: avatarId };
}

function integrationSelect(where: string): string {
  return `select account_id, avatar_id, integration_id, bot_user_id, bot_username, bot_name, status,
                 owner_telegram_user_id, owner_bind_code_hash, owner_bind_expires_at,
                 group_bind_code_hash, group_bind_expires_at, created_at, updated_at
          from swarm_hosted_telegram_integrations where ${where}`;
}

async function findIntegrationForOwner(
  env: CloudflareHostedBindings,
  accountId: string,
  avatarId: string,
): Promise<TelegramIntegrationRow | null> {
  return env.SWARM_STATE.prepare(integrationSelect('account_id = ? and avatar_id = ?'))
    .bind(accountId, avatarId)
    .first<TelegramIntegrationRow>();
}

async function findIntegrationById(
  env: CloudflareHostedBindings,
  integrationId: string,
): Promise<TelegramIntegrationRow | null> {
  return env.SWARM_STATE.prepare(integrationSelect('integration_id = ?'))
    .bind(integrationId)
    .first<TelegramIntegrationRow>();
}

async function telegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new TelegramApiError('Telegram is temporarily unavailable.', 0);
  }
  let envelope: TelegramApiEnvelope<T> = {};
  try {
    envelope = await response.json() as TelegramApiEnvelope<T>;
  } catch {
    // A malformed upstream response is handled as a safe provider failure below.
  }
  if (!response.ok || envelope.ok !== true || envelope.result === undefined) {
    const errorStatus = response.ok && typeof envelope.error_code === 'number'
      ? envelope.error_code
      : response.status;
    throw new TelegramApiError(
      errorStatus >= 500 || errorStatus === 429
        ? 'Telegram is temporarily unavailable.'
        : 'Telegram rejected the bot configuration.',
      errorStatus,
      envelope.parameters?.retry_after,
    );
  }
  return envelope.result;
}

function validateBotToken(value: string): string {
  const token = value.trim();
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/u.test(token)) {
    throw new Error('BotFather token is invalid.');
  }
  return token;
}

function validateBot(result: TelegramUser): { id: string; username: string; name: string } {
  const id = typeof result.id === 'number' || typeof result.id === 'string' ? String(result.id) : '';
  const username = typeof result.username === 'string' ? result.username : '';
  const name = typeof result.first_name === 'string' ? result.first_name.trim() : '';
  if (!id || result.is_bot !== true || !/^[A-Za-z0-9_]{5,32}$/u.test(username)) {
    throw new Error('Telegram did not return a valid bot identity.');
  }
  return { id, username, name: name || username };
}

async function registerWebhook(
  token: string,
  webhookUrl: string,
  webhookSecret: string,
  fetchImpl: typeof fetch,
  dropPendingUpdates: boolean,
): Promise<void> {
  const registered = await telegramApi<boolean>(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'edited_message'],
    ...(dropPendingUpdates ? { drop_pending_updates: true } : {}),
    max_connections: 20,
  }, fetchImpl);
  if (registered !== true) throw new Error('Telegram did not register the webhook.');
  const info = await telegramApi<TelegramWebhookInfo>(token, 'getWebhookInfo', undefined, fetchImpl);
  if (info.url !== webhookUrl) throw new Error('Telegram did not confirm the webhook URL.');
}

async function codeMatches(code: string, expectedHash: string | null): Promise<boolean> {
  if (!expectedHash || !code || code.length > 128) return false;
  return timingSafeEqual(await sha256(code), expectedHash);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function statusFromRow(
  env: CloudflareHostedBindings,
  row: TelegramIntegrationRow,
  now: number,
): Promise<HostedTelegramStatus> {
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(row.account_id, row.avatar_id);
  const ownerCode = !row.owner_telegram_user_id && (row.owner_bind_expires_at ?? 0) > now
    ? await secrets.getUserSecret(scope, OWNER_CODE_SECRET)
    : null;
  const groupCode = row.owner_telegram_user_id && row.group_bind_expires_at > now
    ? await secrets.getUserSecret(scope, GROUP_CODE_SECRET)
    : null;
  return {
    connected: true,
    status: row.status,
    bot: { id: row.bot_user_id, username: row.bot_username, name: row.bot_name },
    ownerBound: !!row.owner_telegram_user_id,
    ...(ownerCode ? { ownerBindUrl: `https://t.me/${row.bot_username}?start=${ownerCode}` } : {}),
    ...(groupCode ? { addToGroupUrl: `https://t.me/${row.bot_username}?startgroup=${groupCode}` } : {}),
  };
}

export async function getHostedTelegramStatus(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  now = Date.now(),
): Promise<HostedTelegramStatus> {
  const row = await findIntegrationForOwner(env, session.accountId, avatarId);
  return row
    ? statusFromRow(env, row, now)
    : { connected: false, status: 'disconnected', ownerBound: false };
}

export async function connectHostedTelegram(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; botToken: string; publicOrigin: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<HostedTelegramStatus> {
  if (!(await getHostedAvatar(env, session, input.avatarId))) {
    throw new HostedTelegramNotFoundError('Hosted avatar was not found.');
  }
  const existing = await findIntegrationForOwner(env, session.accountId, input.avatarId);
  if (existing) throw new HostedTelegramConflictError('This avatar already has a Telegram bot.');
  const token = validateBotToken(input.botToken);
  const bot = validateBot(await telegramApi<TelegramUser>(token, 'getMe', undefined, fetchImpl));
  const used = await env.SWARM_STATE.prepare(
    'select account_id from swarm_hosted_telegram_integrations where bot_user_id = ?',
  ).bind(bot.id).first<{ account_id: string }>();
  if (used) throw new HostedTelegramConflictError('This Telegram bot is already connected to another avatar.');

  const integrationId = `tg_${randomToken(24)}`;
  const webhookSecret = randomToken(32);
  const ownerCode = randomToken(18);
  const groupCode = randomToken(18);
  const webhookUrl = `${new URL(input.publicOrigin).origin}/api/webhooks/telegram/${integrationId}`;
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(session.accountId, input.avatarId);
  const ownerCodeHash = await sha256(ownerCode);
  const groupCodeHash = await sha256(groupCode);
  const claim = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_telegram_integrations
       (account_id, avatar_id, integration_id, bot_user_id, bot_username, bot_name, status,
        owner_telegram_user_id, owner_bind_code_hash, owner_bind_expires_at,
        group_bind_code_hash, group_bind_expires_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'repair_needed', null, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    session.accountId,
    input.avatarId,
    integrationId,
    bot.id,
    bot.username,
    bot.name,
    ownerCodeHash,
    now + OWNER_BIND_TTL_MS,
    groupCodeHash,
    now + GROUP_BIND_TTL_MS,
    now,
    now,
  ).run();
  if (!claim.success) {
    throw new HostedTelegramConflictError('This Telegram bot or avatar is already connected.');
  }
  try {
    await secrets.putUserSecret(scope, TOKEN_SECRET, token);
    await secrets.putUserSecret(scope, WEBHOOK_SECRET, webhookSecret);
    await secrets.putUserSecret(scope, OWNER_CODE_SECRET, ownerCode);
    await secrets.putUserSecret(scope, GROUP_CODE_SECRET, groupCode);
    await registerWebhook(token, webhookUrl, webhookSecret, fetchImpl, true);
    const activated = await env.SWARM_STATE.prepare(
      `update swarm_hosted_telegram_integrations set status = 'binding_required', updated_at = ?
       where account_id = ? and avatar_id = ? and integration_id = ?`,
    ).bind(now, session.accountId, input.avatarId, integrationId).run();
    ensureWrite(activated, 'Unable to activate Telegram connector.');
  } catch (error) {
    await Promise.allSettled([
      secrets.deleteUserSecret(scope, TOKEN_SECRET),
      secrets.deleteUserSecret(scope, WEBHOOK_SECRET),
      secrets.deleteUserSecret(scope, OWNER_CODE_SECRET),
      secrets.deleteUserSecret(scope, GROUP_CODE_SECRET),
      telegramApi<boolean>(token, 'deleteWebhook', { drop_pending_updates: true }, fetchImpl),
    ]);
    await env.SWARM_STATE.prepare(
      'delete from swarm_hosted_telegram_integrations where account_id = ? and avatar_id = ? and integration_id = ?',
    ).bind(session.accountId, input.avatarId, integrationId).run();
    throw error;
  }
  const row = await findIntegrationForOwner(env, session.accountId, input.avatarId);
  if (!row) throw new Error('Telegram connector was not stored.');
  return statusFromRow(env, row, now);
}

export async function repairHostedTelegram(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; publicOrigin: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<HostedTelegramStatus> {
  const row = await findIntegrationForOwner(env, session.accountId, input.avatarId);
  if (!row) throw new HostedTelegramNotFoundError();
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(row.account_id, row.avatar_id);
  let token: string | null = null;
  try {
    token = await secrets.getUserSecret(scope, TOKEN_SECRET);
  } catch {
    // Report the safe reconnect path instead of exposing an envelope failure.
  }
  const webhookSecret = await secrets.getUserSecret(scope, WEBHOOK_SECRET);
  if (!token || !webhookSecret) throw new HostedTelegramConflictError('Telegram credentials are missing. Disconnect and reconnect the bot.');
  const bot = validateBot(await telegramApi<TelegramUser>(token, 'getMe', undefined, fetchImpl));
  if (bot.id !== row.bot_user_id) throw new HostedTelegramConflictError('The Telegram bot token no longer matches this connector.');
  await registerWebhook(
    token,
    `${new URL(input.publicOrigin).origin}/api/webhooks/telegram/${row.integration_id}`,
    webhookSecret,
    fetchImpl,
    false,
  );
  const ownerCode = row.owner_telegram_user_id ? null : randomToken(18);
  const groupCode = randomToken(18);
  if (ownerCode) await secrets.putUserSecret(scope, OWNER_CODE_SECRET, ownerCode);
  await secrets.putUserSecret(scope, GROUP_CODE_SECRET, groupCode);
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_telegram_integrations
     set status = ?, bot_username = ?, bot_name = ?, owner_bind_code_hash = ?,
         owner_bind_expires_at = ?, group_bind_code_hash = ?, group_bind_expires_at = ?, updated_at = ?
     where account_id = ? and avatar_id = ?`,
  ).bind(
    row.owner_telegram_user_id ? 'connected' : 'binding_required',
    bot.username,
    bot.name,
    ownerCode ? await sha256(ownerCode) : null,
    ownerCode ? now + OWNER_BIND_TTL_MS : null,
    await sha256(groupCode),
    now + GROUP_BIND_TTL_MS,
    now,
    row.account_id,
    row.avatar_id,
  ).run();
  ensureWrite(result, 'Unable to repair Telegram connector.');
  const repaired = await findIntegrationForOwner(env, row.account_id, row.avatar_id);
  if (!repaired) throw new HostedTelegramNotFoundError();
  return statusFromRow(env, repaired, now);
}

export async function disconnectHostedTelegram(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ disconnected: true; webhookRemoved: boolean }> {
  const row = await findIntegrationForOwner(env, session.accountId, avatarId);
  if (!row) return { disconnected: true, webhookRemoved: true };
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(row.account_id, row.avatar_id);
  let token: string | null = null;
  try {
    token = await secrets.getUserSecret(scope, TOKEN_SECRET);
  } catch {
    // A corrupt envelope must not prevent local connector cleanup.
  }
  let webhookRemoved = false;
  if (token) {
    try {
      await telegramApi<boolean>(token, 'deleteWebhook', { drop_pending_updates: true }, fetchImpl);
      webhookRemoved = true;
    } catch {
      // Removing the local secret makes any remaining remote webhook harmless.
    }
  }
  await Promise.all([
    secrets.deleteUserSecret(scope, TOKEN_SECRET),
    secrets.deleteUserSecret(scope, WEBHOOK_SECRET),
    secrets.deleteUserSecret(scope, OWNER_CODE_SECRET),
    secrets.deleteUserSecret(scope, GROUP_CODE_SECRET),
  ]);
  const result = await env.SWARM_STATE.prepare(
    'delete from swarm_hosted_telegram_integrations where account_id = ? and avatar_id = ?',
  ).bind(row.account_id, row.avatar_id).run();
  ensureWrite(result, 'Unable to remove Telegram connector.');
  return { disconnected: true, webhookRemoved };
}

async function parseUpdate(request: Request): Promise<TelegramUpdate> {
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(length) && length > MAX_UPDATE_BYTES) throw new Error('Telegram update is too large.');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_UPDATE_BYTES) throw new Error('Telegram update is too large.');
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Telegram update is invalid.');
  return value as TelegramUpdate;
}

function startCode(text: string, botUsername: string): string | null {
  const match = text.trim().match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s+([A-Za-z0-9_-]{1,128}))?$/u);
  if (!match) return null;
  if (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase()) return null;
  return match[2] ?? '';
}

function addressedToBot(message: TelegramMessage, text: string, row: TelegramIntegrationRow): boolean {
  if (new RegExp(`^/[A-Za-z0-9_]+@${row.bot_username}(?:\\s|$)`, 'iu').test(text)) return true;
  if (text.toLowerCase().includes(`@${row.bot_username.toLowerCase()}`)) return true;
  const repliedTo = message.reply_to_message?.from?.id;
  return (typeof repliedTo === 'number' || typeof repliedTo === 'string') && String(repliedTo) === row.bot_user_id;
}

function promptText(text: string, username: string): string {
  return text.replace(new RegExp(`@${username}`, 'giu'), '').trim();
}

async function findTelegramChat(
  env: CloudflareHostedBindings,
  integrationId: string,
  chatId: string,
): Promise<TelegramChatRow | null> {
  return env.SWARM_STATE.prepare(
    `select integration_id, account_id, avatar_id, chat_id, chat_type, thread_id, title,
            enabled, bound_by, created_at, updated_at
     from swarm_hosted_telegram_chats where integration_id = ? and chat_id = ?`,
  ).bind(integrationId, chatId).first<TelegramChatRow>();
}

async function ensureTelegramChat(
  env: CloudflareHostedBindings,
  row: TelegramIntegrationRow,
  message: TelegramMessage,
  boundBy: string,
  now: number,
): Promise<TelegramChatRow> {
  const chatId = String(message.chat?.id ?? '');
  const existing = await findTelegramChat(env, row.integration_id, chatId);
  if (existing) return existing;
  const threadId = `thread_tg_${randomToken(12)}`;
  const chatType = typeof message.chat?.type === 'string' ? message.chat.type : 'unknown';
  const titleValue = message.chat?.title ?? message.chat?.username ?? message.chat?.first_name;
  const title = typeof titleValue === 'string' ? titleValue.slice(0, 200) : null;
  const threadResult = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_threads (account_id, avatar_id, thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?) on conflict(account_id, avatar_id, thread_id) do nothing`,
  ).bind(row.account_id, row.avatar_id, threadId, now, now).run();
  ensureWrite(threadResult, 'Unable to create Telegram chat thread.');
  const chatResult = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_telegram_chats
       (integration_id, account_id, avatar_id, chat_id, chat_type, thread_id, title,
        enabled, bound_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     on conflict(integration_id, chat_id) do nothing`,
  ).bind(
    row.integration_id,
    row.account_id,
    row.avatar_id,
    chatId,
    chatType,
    threadId,
    title,
    boundBy,
    now,
    now,
  ).run();
  ensureWrite(chatResult, 'Unable to bind Telegram chat.');
  const created = await findTelegramChat(env, row.integration_id, chatId);
  if (!created) throw new Error('Telegram chat binding was not stored.');
  return created;
}

async function updateReserved(
  env: CloudflareHostedBindings,
  integrationId: string,
  updateId: string,
  fields: {
    status: TelegramUpdateRow['status'];
    chatId?: string;
    threadId?: string;
    jobId?: string;
    requestId?: string;
    responseText?: string;
    errorCode?: string;
    completedAt?: number;
  },
  now: number,
): Promise<void> {
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_telegram_updates
     set status = ?, chat_id = ?, thread_id = ?, job_id = ?, request_id = ?, response_text = ?,
         error_code = ?, updated_at = ?, completed_at = ?
     where integration_id = ? and update_id = ?`,
  ).bind(
    fields.status,
    fields.chatId ?? null,
    fields.threadId ?? null,
    fields.jobId ?? null,
    fields.requestId ?? null,
    fields.responseText ?? null,
    fields.errorCode ?? null,
    now,
    fields.completedAt ?? null,
    integrationId,
    updateId,
  ).run();
  ensureWrite(result, 'Unable to update Telegram delivery state.');
}

async function queueTelegramUpdate(
  env: CloudflareHostedBindings,
  row: TelegramIntegrationRow,
  updateId: string,
  chat: TelegramChatRow,
  input: { prompt?: string; responseText?: string },
  now: number,
): Promise<void> {
  if (!env.SWARM_QUEUE) throw new Error('Hosted Telegram Queue binding is missing.');
  const jobId = `job_tg_${randomToken(18)}`;
  const requestId = `telegram_${row.integration_id}_${updateId}`;
  if (input.prompt) {
    const result = await env.SWARM_STATE.prepare(
      `insert into swarm_hosted_chat_messages
         (account_id, avatar_id, thread_id, message_id, request_id, role, content, created_at)
       values (?, ?, ?, ?, ?, 'user', ?, ?)
       on conflict(account_id, avatar_id, request_id, role) do nothing`,
    ).bind(
      row.account_id,
      row.avatar_id,
      chat.thread_id,
      `message_${randomToken(18)}`,
      requestId,
      input.prompt,
      now,
    ).run();
    ensureWrite(result, 'Unable to store Telegram message.');
  }
  await updateReserved(env, row.integration_id, updateId, {
    status: 'queued',
    chatId: chat.chat_id,
    threadId: chat.thread_id,
    jobId,
    requestId,
    ...(input.responseText ? { responseText: input.responseText } : {}),
  }, now);
  const queueMessage: HostedTelegramQueueMessage = {
    type: 'swarm.hosted.telegram.update',
    payload: { integrationId: row.integration_id, jobId },
    enqueuedAt: now,
  };
  try {
    await env.SWARM_QUEUE.send(queueMessage);
  } catch (error) {
    await updateReserved(env, row.integration_id, updateId, {
      status: 'retry',
      chatId: chat.chat_id,
      threadId: chat.thread_id,
      jobId,
      requestId,
      ...(input.responseText ? { responseText: input.responseText } : {}),
      errorCode: 'queue_unavailable',
    }, now);
    throw error;
  }
}

export async function handleHostedTelegramWebhook(
  env: CloudflareHostedBindings,
  integrationId: string,
  request: Request,
  now = Date.now(),
): Promise<{ status: 'accepted' | 'duplicate' | 'ignored' }> {
  const row = await findIntegrationById(env, integrationId);
  if (!row) throw new HostedTelegramNotFoundError();
  const secret = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
    secretScope(row.account_id, row.avatar_id),
    WEBHOOK_SECRET,
  );
  const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!secret || !timingSafeEqual(supplied, secret)) {
    throw new HostedTelegramAuthorizationError();
  }
  const update = await parseUpdate(request);
  if (typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id)) {
    throw new Error('Telegram update id is invalid.');
  }
  const updateId = String(update.update_id);
  const reserved = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_telegram_updates
       (integration_id, update_id, account_id, avatar_id, chat_id, thread_id, job_id, request_id,
        status, attempts, max_attempts, response_text, telegram_message_id, error_code,
        created_at, updated_at, completed_at)
     values (?, ?, ?, ?, null, null, null, null, 'received', 0, ?, null, null, null, ?, ?, null)
     on conflict(integration_id, update_id) do nothing returning update_id`,
  ).bind(row.integration_id, updateId, row.account_id, row.avatar_id, MAX_ATTEMPTS, now, now)
    .first<{ update_id: string }>();
  if (!reserved) {
    const replay = await env.SWARM_STATE.prepare(
      `select integration_id, update_id, account_id, avatar_id, chat_id, thread_id, job_id, request_id,
              status, attempts, max_attempts, response_text, telegram_message_id, error_code,
              created_at, updated_at, completed_at
       from swarm_hosted_telegram_updates where integration_id = ? and update_id = ?`,
    ).bind(row.integration_id, updateId).first<TelegramUpdateRow>();
    if (replay?.status === 'retry' && replay.job_id && env.SWARM_QUEUE) {
      await env.SWARM_QUEUE.send({
        type: 'swarm.hosted.telegram.update',
        payload: { integrationId: row.integration_id, jobId: replay.job_id },
        enqueuedAt: now,
      } satisfies HostedTelegramQueueMessage);
      return { status: 'accepted' };
    }
    if (replay?.status !== 'received' || replay.updated_at > now - 5_000) {
      return { status: 'duplicate' };
    }
  }
  const message = update.message ?? update.edited_message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const fromIdValue = message?.from?.id;
  const chatIdValue = message?.chat?.id;
  if (!message || !text || (typeof fromIdValue !== 'number' && typeof fromIdValue !== 'string')
    || (typeof chatIdValue !== 'number' && typeof chatIdValue !== 'string')) {
    await updateReserved(env, row.integration_id, updateId, { status: 'ignored', completedAt: now }, now);
    return { status: 'ignored' };
  }
  const fromId = String(fromIdValue);
  const chatType = typeof message.chat?.type === 'string' ? message.chat.type : '';
  const code = startCode(text, row.bot_username);

  if (!row.owner_telegram_user_id && chatType === 'private' && code !== null
    && (row.owner_bind_expires_at ?? 0) > now && await codeMatches(code, row.owner_bind_code_hash)) {
    const bound = await env.SWARM_STATE.prepare(
      `update swarm_hosted_telegram_integrations
       set owner_telegram_user_id = ?, owner_bind_code_hash = null, owner_bind_expires_at = null,
           status = 'connected', updated_at = ?
       where integration_id = ? and owner_telegram_user_id is null
       returning owner_telegram_user_id`,
    ).bind(fromId, now, row.integration_id).first<{ owner_telegram_user_id: string }>();
    if (!bound || bound.owner_telegram_user_id !== fromId) {
      await updateReserved(env, row.integration_id, updateId, { status: 'ignored', completedAt: now }, now);
      return { status: 'ignored' };
    }
    await createCloudflareHostedPlatform(env).secrets.deleteUserSecret(
      secretScope(row.account_id, row.avatar_id),
      OWNER_CODE_SECRET,
    );
    const chat = await ensureTelegramChat(env, { ...row, owner_telegram_user_id: fromId }, message, fromId, now);
    await queueTelegramUpdate(env, row, updateId, chat, {
      responseText: `Connected to ${row.bot_name}. Return to Swarm to add this bot to a group, or message it here.`,
    }, now);
    return { status: 'accepted' };
  }

  if (row.owner_telegram_user_id && chatType !== 'private' && fromId === row.owner_telegram_user_id
    && code !== null && row.group_bind_expires_at > now && await codeMatches(code, row.group_bind_code_hash)) {
    const chat = await ensureTelegramChat(env, row, message, fromId, now);
    await queueTelegramUpdate(env, row, updateId, chat, {
      responseText: `${row.bot_name} is connected here. Mention @${row.bot_username} or reply to the bot to chat.`,
    }, now);
    return { status: 'accepted' };
  }

  if (!row.owner_telegram_user_id || (chatType === 'private' && fromId !== row.owner_telegram_user_id)) {
    await updateReserved(env, row.integration_id, updateId, { status: 'ignored', completedAt: now }, now);
    return { status: 'ignored' };
  }
  const chatId = String(chatIdValue);
  const chat = chatType === 'private'
    ? await ensureTelegramChat(env, row, message, fromId, now)
    : await findTelegramChat(env, row.integration_id, chatId);
  if (!chat || chat.enabled !== 1 || (chatType !== 'private' && !addressedToBot(message, text, row))) {
    await updateReserved(env, row.integration_id, updateId, { status: 'ignored', completedAt: now }, now);
    return { status: 'ignored' };
  }
  const prompt = promptText(text, row.bot_username);
  if (!prompt || prompt.length > 4_000) {
    await updateReserved(env, row.integration_id, updateId, { status: 'ignored', completedAt: now }, now);
    return { status: 'ignored' };
  }
  await queueTelegramUpdate(env, row, updateId, chat, { prompt }, now);
  return { status: 'accepted' };
}

function validQueueMessage(value: unknown): value is HostedTelegramQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<HostedTelegramQueueMessage>;
  return message.type === 'swarm.hosted.telegram.update'
    && !!message.payload
    && typeof message.payload.integrationId === 'string'
    && message.payload.integrationId.length <= 160
    && typeof message.payload.jobId === 'string'
    && message.payload.jobId.length <= 160;
}

async function findUpdateByJob(
  env: CloudflareHostedBindings,
  integrationId: string,
  jobId: string,
): Promise<TelegramUpdateRow | null> {
  return env.SWARM_STATE.prepare(
    `select integration_id, update_id, account_id, avatar_id, chat_id, thread_id, job_id, request_id,
            status, attempts, max_attempts, response_text, telegram_message_id, error_code,
            created_at, updated_at, completed_at
     from swarm_hosted_telegram_updates where integration_id = ? and job_id = ?`,
  ).bind(integrationId, jobId).first<TelegramUpdateRow>();
}

async function claimUpdate(
  env: CloudflareHostedBindings,
  integrationId: string,
  jobId: string,
  now: number,
): Promise<TelegramUpdateRow | null> {
  return env.SWARM_STATE.prepare(
    `update swarm_hosted_telegram_updates
     set status = 'processing', attempts = attempts + 1, updated_at = ?
     where integration_id = ? and job_id = ? and status in ('queued', 'retry') and attempts < max_attempts
     returning integration_id, update_id, account_id, avatar_id, chat_id, thread_id, job_id, request_id,
               status, attempts, max_attempts, response_text, telegram_message_id, error_code,
               created_at, updated_at, completed_at`,
  ).bind(now, integrationId, jobId).first<TelegramUpdateRow>();
}

async function setJobState(
  env: CloudflareHostedBindings,
  job: TelegramUpdateRow,
  status: TelegramUpdateRow['status'],
  now: number,
  errorCode: string | null = null,
  messageId: string | null = null,
): Promise<void> {
  const terminal = status === 'completed' || status === 'failed' || status === 'unknown';
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_telegram_updates
     set status = ?, error_code = ?, telegram_message_id = ?, updated_at = ?, completed_at = ?
     where integration_id = ? and job_id = ?`,
  ).bind(status, errorCode, messageId, now, terminal ? now : null, job.integration_id, job.job_id).run();
  ensureWrite(result, 'Unable to record Telegram delivery state.');
}

async function claimCoordinator(
  env: CloudflareHostedBindings,
  job: TelegramUpdateRow,
): Promise<{ acquired: boolean; stub: { fetch(request: Request): Promise<Response> } }> {
  if (!env.SWARM_AVATAR_COORDINATORS) throw new Error('Hosted avatar coordinator binding is missing.');
  const id = env.SWARM_AVATAR_COORDINATORS.idFromName(`${job.account_id}:${job.avatar_id}`);
  const stub = env.SWARM_AVATAR_COORDINATORS.get(id);
  const response = await stub.fetch(new Request('https://coordinator.internal/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.job_id }),
  }));
  return response.status === 409 ? { acquired: false, stub } : { acquired: response.ok, stub };
}

async function releaseCoordinator(
  stub: { fetch(request: Request): Promise<Response> },
  jobId: string,
): Promise<void> {
  await stub.fetch(new Request('https://coordinator.internal/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  }));
}

async function retryOrFail(
  env: CloudflareHostedBindings,
  job: TelegramUpdateRow,
  errorCode: string,
  retryable: boolean,
  now: number,
  retryAfter?: number,
): Promise<QueueDisposition> {
  if (retryable && job.attempts < job.max_attempts) {
    await setJobState(env, job, 'retry', now, errorCode);
    return { action: 'retry', delaySeconds: Math.min(60, Math.max(retryAfter ?? 2 ** job.attempts, 1)) };
  }
  await setJobState(env, job, 'failed', now, errorCode);
  return { action: 'ack' };
}

export async function processHostedTelegramQueueMessage(
  env: CloudflareHostedBindings,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<QueueDisposition> {
  if (!validQueueMessage(value)) return { action: 'ack' };
  const pending = await findUpdateByJob(env, value.payload.integrationId, value.payload.jobId);
  if (!pending) return { action: 'ack' };
  const lease = await claimCoordinator(env, pending);
  if (!lease.acquired) return { action: 'retry', delaySeconds: 2 };
  try {
    const job = await claimUpdate(env, value.payload.integrationId, value.payload.jobId, now);
    if (!job || !job.chat_id || !job.thread_id || !job.request_id || !job.job_id) return { action: 'ack' };
    const token = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
      secretScope(job.account_id, job.avatar_id),
      TOKEN_SECRET,
    );
    if (!token) return retryOrFail(env, job, 'telegram_token_missing', false, now);
    let content = job.response_text;
    let storeInHistory = false;
    if (!content) {
      const model = await generateHostedReply(env, {
        accountId: job.account_id,
        avatarId: job.avatar_id,
        threadId: job.thread_id,
        requestId: job.request_id,
      }, fetchImpl);
      if (!model.ok) return retryOrFail(env, job, model.code, model.retryable, now);
      content = model.content;
      storeInHistory = true;
    }
    await setJobState(env, job, 'sending', now);
    let sent: { message_id?: unknown };
    try {
      sent = await telegramApi<{ message_id?: unknown }>(token, 'sendMessage', {
        chat_id: job.chat_id,
        text: content.slice(0, 4_000),
        disable_web_page_preview: true,
      }, fetchImpl);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status !== 0) {
        if (error.status >= 500) {
          await setJobState(env, job, 'unknown', now, 'telegram_delivery_unknown');
          return { action: 'ack' };
        }
        return retryOrFail(
          env,
          job,
          'telegram_send_failed',
          error.status === 429,
          now,
          error.retryAfter,
        );
      }
      await setJobState(env, job, 'unknown', now, 'telegram_delivery_unknown');
      return { action: 'ack' };
    }
    const messageId = typeof sent.message_id === 'number' || typeof sent.message_id === 'string'
      ? String(sent.message_id)
      : null;
    if (storeInHistory) {
      await storeHostedAssistantMessage(env, {
        accountId: job.account_id,
        avatarId: job.avatar_id,
        threadId: job.thread_id,
        requestId: job.request_id,
        content,
        createdAt: now,
      });
    }
    await setJobState(env, job, 'completed', now, null, messageId);
    return { action: 'ack' };
  } catch {
    const latest = await findUpdateByJob(env, value.payload.integrationId, value.payload.jobId);
    if (latest?.status === 'sending') {
      await setJobState(env, latest, 'unknown', now, 'delivery_state_unknown');
      return { action: 'ack' };
    }
    return latest ? retryOrFail(env, latest, 'telegram_runtime_failed', true, now) : { action: 'ack' };
  } finally {
    await releaseCoordinator(lease.stub, value.payload.jobId);
  }
}

export async function cleanupHostedTelegramRuntime(
  env: CloudflareHostedBindings,
  now = Date.now(),
): Promise<void> {
  const retentionCutoff = now - 7 * 24 * 60 * 60 * 1_000;
  const cleanup = await env.SWARM_STATE.prepare(
    `delete from swarm_hosted_telegram_updates
     where created_at <= ? and status in ('ignored', 'completed', 'failed', 'unknown')`,
  ).bind(retentionCutoff).run();
  ensureWrite(cleanup, 'Unable to clean Telegram delivery state.');
  const interrupted = await env.SWARM_STATE.prepare(
    `update swarm_hosted_telegram_updates
     set status = 'unknown', error_code = 'worker_interrupted', updated_at = ?, completed_at = ?
     where status in ('processing', 'sending') and updated_at <= ?`,
  ).bind(now, now, now - 120_000).run();
  ensureWrite(interrupted, 'Unable to recover Telegram delivery state.');
}
