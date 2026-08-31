import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import type { HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import {
  connectHostedTelegram,
  disconnectHostedTelegram,
  forgetHostedTelegramGroup,
  getHostedTelegramStatus,
  handleHostedTelegramWebhook,
  HostedTelegramAuthorizationError,
  processHostedTelegramQueueMessage,
  setHostedTelegramGroupEnabled,
  type HostedTelegramQueueMessage,
} from './hosted-telegram.js';

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
      '0005_hosted_telegram.sql',
      '0006_portable_public_avatars.sql',
      '0007_hosted_telegram_v2.sql',
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

const session: HostedSession = {
  accountId: 'account-1',
  walletAddress: 'wallet-1',
  expiresAt: 9_999_999,
  sessionHash: 'session-1',
};
const testBotToken = `123456789:${'A'.repeat(36)}`;

function setup() {
  const state = new SqliteD1();
  state.db.exec("insert into swarm_accounts (account_id, created_at) values ('account-1', 1)");
  state.db.exec(`insert into swarm_hosted_avatars
    (account_id, avatar_id, default_thread_id, name, description, persona, status, created_by, created_at, updated_at)
    values ('account-1', 'avatar-1', 'thread-browser', 'Jax', null, null, 'shell', 'wallet-1', 1, 1)`);
  state.db.exec(`insert into swarm_hosted_chat_threads
    (account_id, avatar_id, thread_id, created_at, updated_at)
    values ('account-1', 'avatar-1', 'thread-browser', 1, 1)`);
  const queued: HostedTelegramQueueMessage[] = [];
  const env: CloudflareHostedBindings = {
    SWARM_STATE: state,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    SWARM_QUEUE: { send: async (message) => queued.push(message as HostedTelegramQueueMessage) },
    SWARM_AVATAR_COORDINATORS: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
    SWARM_HOSTED_ENABLED: '1',
    SWARM_PUBLIC_URL: 'https://next.swarm.rati.chat',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(7)),
    SWARM_USER_SECRET_KEY_VERSION: 'v1',
  };
  return { state, env, queued };
}

function telegramSetupFetch(calls: Array<{ method: string; body?: Record<string, unknown> }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').at(-1) ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, ...(body ? { body } : {}) });
    if (method === 'getMe') {
      return Response.json({ ok: true, result: { id: 123456789, is_bot: true, first_name: 'Jax', username: 'JaxSwarmBot' } });
    }
    if (method === 'getWebhookInfo') {
      const registered = calls.find((call) => call.method === 'setWebhook')?.body?.url;
      return Response.json({ ok: true, result: { url: registered } });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
}

async function connect(env: CloudflareHostedBindings, calls: Array<{ method: string; body?: Record<string, unknown> }>) {
  return connectHostedTelegram(env, session, {
    avatarId: 'avatar-1',
    botToken: testBotToken,
    publicOrigin: 'https://next.swarm.rati.chat',
  }, telegramSetupFetch(calls), 1_000);
}

function webhookRequest(secret: string, update: unknown): Request {
  return new Request('https://next.swarm.rati.chat/api/webhooks/telegram/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
}

async function bindOwner(
  env: CloudflareHostedBindings,
  state: SqliteD1,
  now = 2_000,
): Promise<{ integrationId: string; secret: string; ownerId: number }> {
  const connected = await connect(env, []);
  const integration = state.db.query('select integration_id from swarm_hosted_telegram_integrations').get() as {
    integration_id: string;
  };
  const secret = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
    { accountId: 'account-1', tenantId: 'avatar-1' },
    'telegram-webhook-secret',
  );
  const ownerCode = new URL(connected.ownerBindUrl ?? '').searchParams.get('start');
  const ownerId = 77;
  await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(secret ?? '', {
    update_id: now,
    message: { message_id: now, text: `/start ${ownerCode}`, from: { id: ownerId }, chat: { id: ownerId, type: 'private' } },
  }), now);
  return { integrationId: integration.integration_id, secret: secret ?? '', ownerId };
}

async function bindGroup(
  env: CloudflareHostedBindings,
  input: { integrationId: string; secret: string; ownerId: number; chatId: number; updateId: number },
): Promise<void> {
  const status = await getHostedTelegramStatus(env, session, 'avatar-1', input.updateId);
  const groupCode = new URL(status.addToGroupUrl ?? '').searchParams.get('startgroup');
  await handleHostedTelegramWebhook(env, input.integrationId, webhookRequest(input.secret, {
    update_id: input.updateId,
    message: {
      message_id: input.updateId,
      text: `/start@JaxSwarmBot ${groupCode}`,
      from: { id: input.ownerId },
      chat: { id: input.chatId, type: 'supergroup', title: 'Penguin HQ' },
    },
  }), input.updateId);
}

const resources: SqliteD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()?.close();
});

describe('hosted Telegram connector', () => {
  it('registers an opaque webhook and stores the BotFather token only as ciphertext', async () => {
    const { state, env } = setup();
    resources.push(state);
    const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const status = await connect(env, calls);

    expect(status).toMatchObject({ connected: true, status: 'binding_required', ownerBound: false });
    expect(JSON.stringify(status)).not.toContain(testBotToken);
    expect(status.ownerBindUrl).toContain('https://t.me/JaxSwarmBot?start=');
    const webhook = calls.find((call) => call.method === 'setWebhook')?.body;
    expect(webhook?.url).toMatch(/^https:\/\/next\.swarm\.rati\.chat\/api\/webhooks\/telegram\/tg_/u);
    expect(webhook?.secret_token).toBeString();
    expect(webhook?.allowed_updates).toEqual(['message', 'edited_message', 'my_chat_member', 'message_reaction']);
    expect(calls.find((call) => call.method === 'setMyCommands')?.body?.commands).toHaveLength(3);
    expect(status.groups).toEqual([]);
    const secretRows = state.db.query('select name, envelope from swarm_user_secrets').all() as Array<{
      name: string;
      envelope: string;
    }>;
    expect(secretRows.map((row) => row.name).sort()).toEqual([
      'telegram-bot-token',
      'telegram-group-bind-code',
      'telegram-owner-bind-code',
      'telegram-webhook-secret',
    ]);
    expect(secretRows.every((row) => !row.envelope.includes(testBotToken))).toBeTrue();
  });

  it('requires the webhook secret, binds one owner, and deduplicates update ids', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    const status = await connect(env, []);
    const integrationId = state.db.query('select integration_id from swarm_hosted_telegram_integrations').get() as {
      integration_id: string;
    };
    await expect(handleHostedTelegramWebhook(
      env,
      integrationId.integration_id,
      webhookRequest('wrong', { update_id: 1 }),
      2_000,
    )).rejects.toBeInstanceOf(HostedTelegramAuthorizationError);

    const secret = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
      { accountId: 'account-1', tenantId: 'avatar-1' },
      'telegram-webhook-secret',
    );
    const ownerCode = new URL(status.ownerBindUrl ?? '').searchParams.get('start');
    const update = {
      update_id: 2,
      message: { message_id: 10, text: `/start ${ownerCode}`, from: { id: 77 }, chat: { id: 77, type: 'private' } },
    };
    await expect(handleHostedTelegramWebhook(
      env,
      integrationId.integration_id,
      webhookRequest(secret ?? '', update),
      2_000,
    )).resolves.toEqual({ status: 'accepted' });
    await expect(handleHostedTelegramWebhook(
      env,
      integrationId.integration_id,
      webhookRequest(secret ?? '', update),
      2_001,
    )).resolves.toEqual({ status: 'duplicate' });
    expect(queued).toHaveLength(1);
    await expect(getHostedTelegramStatus(env, session, 'avatar-1', 2_001)).resolves.toMatchObject({
      ownerBound: true,
      status: 'connected',
    });
  });

  it('keeps Telegram chats isolated and does not retry an ambiguous delivery', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-user-key',
    );
    const connected = await connect(env, []);
    const integration = state.db.query('select integration_id from swarm_hosted_telegram_integrations').get() as {
      integration_id: string;
    };
    const secret = await createCloudflareHostedPlatform(env).secrets.getUserSecret(
      { accountId: 'account-1', tenantId: 'avatar-1' },
      'telegram-webhook-secret',
    );
    const ownerCode = new URL(connected.ownerBindUrl ?? '').searchParams.get('start');
    await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(secret ?? '', {
      update_id: 10,
      message: { message_id: 1, text: `/start ${ownerCode}`, from: { id: 77 }, chat: { id: 77, type: 'private' } },
    }), 3_000);
    queued.length = 0;
    const bound = await getHostedTelegramStatus(env, session, 'avatar-1', 3_001);
    const groupCode = new URL(bound.addToGroupUrl ?? '').searchParams.get('startgroup');
    for (const [updateId, chatId] of [[11, -1001], [12, -1002]] as const) {
      await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(secret ?? '', {
        update_id: updateId,
        message: {
          message_id: updateId,
          text: `/start@JaxSwarmBot ${groupCode}`,
          from: { id: 77 },
          chat: { id: chatId, type: 'supergroup', title: `Group ${chatId}` },
        },
      }), 3_000 + updateId);
    }
    const threads = state.db.query(
      'select chat_id, thread_id from swarm_hosted_telegram_chats where chat_type = ? order by chat_id',
    ).all('supergroup') as Array<{ chat_id: string; thread_id: string }>;
    expect(threads).toHaveLength(2);
    expect(threads[0]?.thread_id).not.toBe(threads[1]?.thread_id);

    queued.length = 0;
    await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(secret ?? '', {
      update_id: 20,
      message: {
        message_id: 20,
        text: '@JaxSwarmBot hello',
        from: { id: 77 },
        chat: { id: -1001, type: 'supergroup' },
      },
    }), 4_000);
    expect(queued).toHaveLength(1);
    let sendAttempts = 0;
    const ambiguousFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        return Response.json({ choices: [{ message: { content: 'Hello from Jax' } }] });
      }
      if (url.endsWith('/sendMessage')) {
        sendAttempts += 1;
        throw new Error('connection reset after request write');
      }
      throw new Error('Unexpected request');
    }) as typeof fetch;
    await expect(processHostedTelegramQueueMessage(env, queued[0], ambiguousFetch, 5_000))
      .resolves.toEqual({ action: 'ack' });
    await expect(processHostedTelegramQueueMessage(env, queued[0], ambiguousFetch, 5_001))
      .resolves.toEqual({ action: 'ack' });
    expect(sendAttempts).toBe(1);
    const delivery = state.db.query(
      'select status, error_code from swarm_hosted_telegram_updates where update_id = ?',
    ).get('20') as { status: string; error_code: string };
    expect(delivery).toEqual({ status: 'unknown', error_code: 'telegram_delivery_unknown' });
  });

  it('retries a definite Telegram rate limit with the requested delay and then completes once', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-user-key',
    );
    const connected = await connect(env, []);
    const integration = state.db.query('select integration_id from swarm_hosted_telegram_integrations').get() as {
      integration_id: string;
    };
    const connectorSecrets = createCloudflareHostedPlatform(env).secrets;
    const webhookSecret = await connectorSecrets.getUserSecret(
      { accountId: 'account-1', tenantId: 'avatar-1' },
      'telegram-webhook-secret',
    );
    const ownerCode = new URL(connected.ownerBindUrl ?? '').searchParams.get('start');
    await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(webhookSecret ?? '', {
      update_id: 30,
      message: { message_id: 30, text: `/start ${ownerCode}`, from: { id: 77 }, chat: { id: 77, type: 'private' } },
    }), 6_000);
    queued.length = 0;
    await handleHostedTelegramWebhook(env, integration.integration_id, webhookRequest(webhookSecret ?? '', {
      update_id: 31,
      message: { message_id: 31, text: 'hello', from: { id: 77 }, chat: { id: 77, type: 'private' } },
    }), 6_100);
    let sendAttempts = 0;
    const rateLimitedFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        return Response.json({ choices: [{ message: { content: 'One answer' } }] });
      }
      if (url.endsWith('/sendMessage')) {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return Response.json(
            { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
            { status: 429 },
          );
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      throw new Error('Unexpected request');
    }) as typeof fetch;
    await expect(processHostedTelegramQueueMessage(env, queued[0], rateLimitedFetch, 7_000))
      .resolves.toEqual({ action: 'retry', delaySeconds: 7 });
    await expect(processHostedTelegramQueueMessage(env, queued[0], rateLimitedFetch, 7_100))
      .resolves.toEqual({ action: 'ack' });
    expect(sendAttempts).toBe(2);
    expect(state.db.query(
      'select status, telegram_message_id from swarm_hosted_telegram_updates where update_id = ?',
    ).get('31')).toEqual({ status: 'completed', telegram_message_id: '900' });
    expect(state.db.query(
      "select count(*) as count from swarm_hosted_chat_messages where request_id like 'telegram_%' and role = 'assistant'",
    ).get()).toEqual({ count: 1 });
  });

  it('keeps replies and reactions inside the source forum topic and accepts caption prompts', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-user-key',
    );
    const owner = await bindOwner(env, state, 8_000);
    queued.length = 0;
    await bindGroup(env, { ...owner, chatId: -1001, updateId: 8_100 });
    queued.length = 0;

    await expect(handleHostedTelegramWebhook(env, owner.integrationId, webhookRequest(owner.secret, {
      update_id: 8_200,
      message: {
        message_id: 501,
        message_thread_id: 42,
        caption: '@JaxSwarmBot explain this photo caption',
        from: { id: 88 },
        chat: { id: -1001, type: 'supergroup', title: 'Penguin HQ' },
      },
    }), 8_200)).resolves.toEqual({ status: 'accepted' });
    expect(queued).toHaveLength(1);

    const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const telegramFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        return Response.json({ choices: [{ message: { content: 'Topic answer' } }] });
      }
      const method = url.split('/').at(-1) ?? '';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ method, ...(body ? { body } : {}) });
      return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 900 } : true });
    }) as typeof fetch;
    await expect(processHostedTelegramQueueMessage(env, queued[0], telegramFetch, 8_300))
      .resolves.toEqual({ action: 'ack' });

    const send = calls.find((call) => call.method === 'sendMessage')?.body;
    expect(send).toMatchObject({
      chat_id: '-1001',
      message_thread_id: 42,
      reply_parameters: { message_id: 501, allow_sending_without_reply: true },
    });
    expect(calls.find((call) => call.method === 'sendChatAction')?.body).toMatchObject({
      chat_id: '-1001',
      message_thread_id: 42,
      action: 'typing',
    });
    expect(calls.filter((call) => call.method === 'setMessageReaction').map((call) => call.body?.reaction))
      .toEqual([
        [{ type: 'emoji', emoji: '👀' }],
        [{ type: 'emoji', emoji: '👍' }],
      ]);
    expect(state.db.query(
      'select message_thread_id from swarm_hosted_telegram_topics where integration_id = ?',
    ).all(owner.integrationId)).toEqual([{ message_thread_id: '42' }]);

    queued.length = 0;
    await handleHostedTelegramWebhook(env, owner.integrationId, webhookRequest(owner.secret, {
      update_id: 8_201,
      message: {
        message_id: 502,
        message_thread_id: 43,
        text: 'another topic',
        from: { id: 88 },
        chat: { id: -1001, type: 'supergroup' },
        reply_to_message: { from: { id: 123456789, is_bot: true } },
      },
    }), 8_400);
    expect(state.db.query(
      'select message_thread_id from swarm_hosted_telegram_topics where integration_id = ? order by message_thread_id',
    ).all(owner.integrationId)).toEqual([{ message_thread_id: '42' }, { message_thread_id: '43' }]);
  });

  it('tracks membership and lets the hosted owner pause, enable, and forget a group', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    const owner = await bindOwner(env, state, 9_000);
    queued.length = 0;
    await bindGroup(env, { ...owner, chatId: -1001, updateId: 9_100 });
    queued.length = 0;

    await expect(handleHostedTelegramWebhook(env, owner.integrationId, webhookRequest(owner.secret, {
      update_id: 9_200,
      my_chat_member: {
        chat: { id: -1001, type: 'supergroup', title: 'Penguin HQ' },
        from: { id: owner.ownerId },
        new_chat_member: { status: 'kicked', user: { id: 123456789, is_bot: true } },
      },
    }), 9_200)).resolves.toEqual({ status: 'accepted' });
    expect(queued).toHaveLength(0);
    await expect(getHostedTelegramStatus(env, session, 'avatar-1', 9_201)).resolves.toMatchObject({
      groups: [{ chatId: '-1001', title: 'Penguin HQ', enabled: false, membershipStatus: 'kicked' }],
    });

    await expect(setHostedTelegramGroupEnabled(env, session, {
      avatarId: 'avatar-1',
      chatId: '-1001',
      enabled: true,
    }, 9_300)).resolves.toMatchObject({ groups: [{ chatId: '-1001', enabled: true }] });
    await expect(forgetHostedTelegramGroup(env, session, {
      avatarId: 'avatar-1',
      chatId: '-1001',
    }, 9_400)).resolves.toMatchObject({ groups: [] });
  });

  it('rejects BotFather bots that cannot join groups', async () => {
    const { state, env } = setup();
    resources.push(state);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const method = String(input).split('/').at(-1);
      if (method === 'getMe') {
        return Response.json({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'Jax',
            username: 'JaxSwarmBot',
            can_join_groups: false,
          },
        });
      }
      throw new Error('Webhook setup must not run for a private-only bot.');
    }) as typeof fetch;
    await expect(connectHostedTelegram(env, session, {
      avatarId: 'avatar-1',
      botToken: testBotToken,
      publicOrigin: 'https://next.swarm.rati.chat',
    }, fetchImpl, 10_000)).rejects.toThrow(/setjoingroups/iu);
    expect(state.db.query('select count(*) as count from swarm_hosted_telegram_integrations').get())
      .toEqual({ count: 0 });
  });

  it('removes the webhook, encrypted secrets, and connector metadata on disconnect', async () => {
    const { state, env } = setup();
    resources.push(state);
    await connect(env, []);
    const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
    await expect(disconnectHostedTelegram(env, session, 'avatar-1', telegramSetupFetch(calls)))
      .resolves.toEqual({ disconnected: true, webhookRemoved: true });
    expect(calls.some((call) => call.method === 'deleteWebhook')).toBeTrue();
    expect(state.db.query('select count(*) as count from swarm_user_secrets').get()).toEqual({ count: 0 });
    expect(state.db.query('select count(*) as count from swarm_hosted_telegram_integrations').get()).toEqual({ count: 0 });
  });
});
