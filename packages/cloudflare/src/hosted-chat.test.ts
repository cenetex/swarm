import { describe, expect, it } from 'bun:test';
import { HOSTED_SESSION_COOKIE, sha256, type HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
  CloudflareQueue,
} from './bindings.js';
import {
  createHostedAvatar,
  enqueueHostedChat,
  getHostedAvatar,
  getHostedChatJob,
  HostedChatMissingKeyError,
  HostedChatNotFoundError,
  HostedChatQueueError,
  listHostedChatHistory,
  processHostedChatQueueMessage,
  type HostedChatQueueMessage,
} from './hosted-chat.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import worker from './worker.js';

type AvatarRow = {
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
};

type MessageRow = {
  account_id: string;
  avatar_id: string;
  thread_id: string;
  message_id: string;
  request_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
};

type JobRow = {
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

function key(...parts: string[]): string {
  return parts.join('|');
}

class ChatMemoryD1 implements CloudflareD1Database {
  readonly avatars = new Map<string, AvatarRow>();
  readonly messages: MessageRow[] = [];
  readonly jobs = new Map<string, JobRow>();
  readonly secrets = new Map<string, { envelope: string; keyVersion: string }>();
  readonly rateLimits = new Map<string, { windowStart: number; count: number }>();
  readonly sessions = new Map<string, { account_id: string; wallet_address: string; expires_at: number }>();

  prepare(query: string): CloudflareD1PreparedStatement {
    return new ChatMemoryStatement(this, query.replace(/\s+/gu, ' ').trim().toLowerCase());
  }
}

class ChatMemoryStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: ChatMemoryD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.startsWith('select account_id, wallet_address, expires_at from swarm_sessions')) {
      const [sessionHash, now] = this.values as [string, number];
      const sessionRow = this.db.sessions.get(sessionHash);
      return (sessionRow && sessionRow.expires_at > now ? sessionRow : null) as T | null;
    }
    if (this.query.startsWith('select account_id, avatar_id, default_thread_id')) {
      const [accountId, avatarId] = this.values.map(String);
      return (this.db.avatars.get(key(accountId, avatarId)) ?? null) as T | null;
    }
    if (this.query.startsWith('select 1 as present from swarm_user_secrets')) {
      const [accountId, tenantId, name] = this.values.map(String);
      return (this.db.secrets.has(key(accountId, tenantId, name)) ? { present: 1 } : null) as T | null;
    }
    if (this.query.startsWith('select envelope from swarm_user_secrets')) {
      const [accountId, tenantId, name] = this.values.map(String);
      const secret = this.db.secrets.get(key(accountId, tenantId, name));
      return (secret ? { envelope: secret.envelope } : null) as T | null;
    }
    if (this.query.startsWith('insert into swarm_hosted_chat_rate_limits')) {
      const [accountId, windowStart] = this.values as [string, number, number];
      const existing = this.db.rateLimits.get(accountId);
      const count = existing?.windowStart === windowStart ? existing.count + 1 : 1;
      this.db.rateLimits.set(accountId, { windowStart, count });
      return { count } as T;
    }
    if (
      this.query.startsWith('select account_id, avatar_id, thread_id, job_id')
      && this.query.includes('avatar_id = ? and request_id = ?')
    ) {
      const [accountId, avatarId, requestId] = this.values.map(String);
      const job = [...this.db.jobs.values()].find(
        (value) => value.account_id === accountId
          && value.avatar_id === avatarId
          && value.request_id === requestId,
      );
      return (job ?? null) as T | null;
    }
    if (this.query.startsWith('insert into swarm_hosted_chat_jobs')) {
      const [accountId, avatarId, threadId, jobId, requestId, maxAttempts, createdAt, updatedAt] = this.values as [
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      const duplicate = [...this.db.jobs.values()].find(
        (value) => value.account_id === accountId
          && value.avatar_id === avatarId
          && value.request_id === requestId,
      );
      if (duplicate) return null;
      const job: JobRow = {
        account_id: accountId,
        avatar_id: avatarId,
        thread_id: threadId,
        job_id: jobId,
        request_id: requestId,
        status: 'queued',
        attempts: 0,
        max_attempts: maxAttempts,
        error_code: null,
        error_message: null,
        response_message_id: null,
        created_at: createdAt,
        updated_at: updatedAt,
        completed_at: null,
      };
      this.db.jobs.set(key(accountId, jobId), job);
      return job as T;
    }
    if (
      this.query.startsWith('select account_id, avatar_id, thread_id, job_id')
      && this.query.includes('where account_id = ? and job_id = ?')
    ) {
      const [accountId, jobId] = this.values.map(String);
      return (this.db.jobs.get(key(accountId, jobId)) ?? null) as T | null;
    }
    if (this.query.startsWith('update swarm_hosted_chat_jobs set status = \'processing\'')) {
      const [now, accountId, avatarId, jobId] = this.values as [number, string, string, string];
      const job = this.db.jobs.get(key(accountId, jobId));
      if (
        !job
        || job.avatar_id !== avatarId
        || !['queued', 'retry'].includes(job.status)
        || job.attempts >= job.max_attempts
      ) return null;
      job.status = 'processing';
      job.attempts += 1;
      job.updated_at = now;
      return job as T;
    }
    if (this.query.startsWith('select content from swarm_hosted_chat_messages')) {
      const [accountId, messageId] = this.values.map(String);
      const message = this.db.messages.find(
        (value) => value.account_id === accountId
          && value.message_id === messageId
          && value.role === 'assistant',
      );
      return (message ? { content: message.content } : null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ success: boolean; results: T[] }> {
    if (this.query.includes('from swarm_hosted_avatars where account_id = ?')) {
      const accountId = String(this.values[0]);
      return {
        success: true,
        results: [...this.db.avatars.values()]
          .filter((avatar) => avatar.account_id === accountId)
          .sort((left, right) => right.updated_at - left.updated_at) as T[],
      };
    }
    if (this.query.includes('from swarm_hosted_chat_messages')) {
      const [accountId, avatarId, threadId] = this.values.slice(0, 3).map(String);
      const descending = this.query.includes('order by created_at desc');
      const before = descending ? Number(this.values[3]) : Number.POSITIVE_INFINITY;
      const requestId = descending ? String(this.values[4]) : '';
      const limit = descending ? Number(this.values[5]) : 200;
      const rows = this.db.messages
        .filter(
          (message) => message.account_id === accountId
            && message.avatar_id === avatarId
            && message.thread_id === threadId
            && (!descending || message.created_at < before || message.request_id === requestId),
        )
        .sort((left, right) => {
          const timeOrder = left.created_at - right.created_at;
          return descending ? -timeOrder : timeOrder;
        })
        .slice(0, limit);
      return { success: true, results: rows as T[] };
    }
    return { success: true, results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    if (this.query.startsWith('insert into swarm_hosted_avatars')) {
      const [accountId, avatarId, threadId, name, description, createdBy, createdAt, updatedAt] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        number,
        number,
      ];
      this.db.avatars.set(key(accountId, avatarId), {
        account_id: accountId,
        avatar_id: avatarId,
        default_thread_id: threadId,
        name,
        description,
        persona: null,
        status: 'shell',
        created_by: createdBy,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    } else if (this.query.startsWith('insert into swarm_user_secrets')) {
      const [accountId, tenantId, name, envelope, keyVersion] = this.values.map(String);
      this.db.secrets.set(key(accountId, tenantId, name), { envelope, keyVersion });
    } else if (this.query.startsWith('insert into swarm_hosted_chat_messages')) {
      const [accountId, avatarId, threadId, messageId, requestId, content, createdAt] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      const role = this.query.includes("'assistant'") ? 'assistant' : 'user';
      const duplicate = this.db.messages.some(
        (message) => message.account_id === accountId
          && message.avatar_id === avatarId
          && message.request_id === requestId
          && message.role === role,
      );
      if (!duplicate) {
        this.db.messages.push({
          account_id: accountId,
          avatar_id: avatarId,
          thread_id: threadId,
          message_id: messageId,
          request_id: requestId,
          role,
          content,
          created_at: createdAt,
        });
      }
    } else if (this.query.includes("set status = 'completed'")) {
      const [responseMessageId, updatedAt, completedAt, accountId, jobId] = this.values as [
        string,
        number,
        number,
        string,
        string,
      ];
      const job = this.db.jobs.get(key(accountId, jobId));
      if (job?.status === 'processing') {
        job.status = 'completed';
        job.response_message_id = responseMessageId;
        job.error_code = null;
        job.error_message = null;
        job.updated_at = updatedAt;
        job.completed_at = completedAt;
      }
    } else if (this.query.includes("set status = 'dead'")) {
      const [errorCode, errorMessage, updatedAt, completedAt, accountId, jobId] = this.values as [
        string,
        string,
        number,
        number,
        string,
        string,
      ];
      const job = this.db.jobs.get(key(accountId, jobId));
      if (job?.status !== 'completed') {
        job.status = 'dead';
        job.error_code = errorCode;
        job.error_message = errorMessage;
        job.updated_at = updatedAt;
        job.completed_at = completedAt;
      }
    } else if (this.query.startsWith('update swarm_hosted_chat_jobs set status = ?')) {
      const [status, errorCode, errorMessage, updatedAt, completedAt, accountId, jobId] = this.values as [
        'retry' | 'dead',
        string,
        string,
        number,
        number | null,
        string,
        string,
      ];
      const job = this.db.jobs.get(key(accountId, jobId));
      if (job?.status === 'processing') {
        job.status = status;
        job.error_code = errorCode;
        job.error_message = errorMessage;
        job.updated_at = updatedAt;
        job.completed_at = completedAt;
      }
    }
    return { success: true };
  }
}

class MemoryCoordinatorNamespace {
  private readonly leases = new Map<string, string>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const name = String(id);
    return {
      fetch: async (request) => {
        const { jobId } = await request.json() as { jobId: string };
        const path = new URL(request.url).pathname;
        const current = this.leases.get(name);
        if (path === '/claim') {
          if (current && current !== jobId) return new Response(null, { status: 409 });
          this.leases.set(name, jobId);
          return new Response(null, { status: 204 });
        }
        if (path === '/release' && current === jobId) this.leases.delete(name);
        return new Response(null, { status: 204 });
      },
    };
  }
}

function session(accountId: string): HostedSession {
  return {
    accountId,
    walletAddress: accountId.endsWith('a')
      ? '11111111111111111111111111111111'
      : '22222222222222222222222222222222',
    expiresAt: Date.now() + 60_000,
    sessionHash: `${accountId}-session`,
  };
}

function testEnv(db: ChatMemoryD1, queue: CloudflareQueue): CloudflareHostedBindings {
  return {
    SWARM_STATE: db,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
    },
    SWARM_QUEUE: queue,
    SWARM_AVATAR_COORDINATORS: new MemoryCoordinatorNamespace(),
    SWARM_HOSTED_ENABLED: '1',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(7)),
    SWARM_USER_SECRET_KEY_VERSION: 'v1',
  };
}

async function configuredAvatar(env: CloudflareHostedBindings, owner: HostedSession) {
  await createCloudflareHostedPlatform(env).secrets.putUserSecret(
    { accountId: owner.accountId },
    'llm-api-key',
    'sk-secret-user-key',
  );
  return createHostedAvatar(env, owner, { name: 'Ada', description: 'A careful assistant.' }, 1_000);
}

describe('Cloudflare hosted chat runtime', () => {
  it('serves the authenticated avatar, async chat, job, and history routes', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    env.SWARM_HOSTED_ENABLED = '1';
    env.SWARM_PUBLIC_URL = 'https://swarm.example';
    const owner = session('acct-a');
    const token = 'hosted-session-token';
    db.sessions.set(await sha256(token), {
      account_id: owner.accountId,
      wallet_address: owner.walletAddress,
      expires_at: Date.now() + 60_000,
    });
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: owner.accountId },
      'llm-api-key',
      'sk-secret-user-key',
    );
    const headers = {
      Cookie: `${HOSTED_SESSION_COOKIE}=${token}`,
      Origin: 'https://swarm.example',
      'Content-Type': 'application/json',
    };
    const avatarResponse = await worker.fetch(
      new Request('https://swarm.example/api/avatars', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Ada' }),
      }),
      env,
    );
    expect(avatarResponse.status).toBe(201);
    const avatar = await avatarResponse.json() as { avatarId: string };

    const chatResponse = await worker.fetch(
      new Request('https://swarm.example/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId: 'route-request',
          message: 'Hello',
          avatar: { id: avatar.avatarId, name: 'Ada' },
          history: [],
        }),
      }),
      env,
    );
    expect(chatResponse.status).toBe(202);
    const accepted = await chatResponse.json() as { jobId: string };
    await processHostedChatQueueMessage(
      env,
      sent[0],
      (async () => Response.json({ choices: [{ message: { content: 'Hello back.' } }] })) as typeof fetch,
    );

    const jobResponse = await worker.fetch(
      new Request(`https://swarm.example/api/jobs/${accepted.jobId}`, { headers }),
      env,
    );
    expect(await jobResponse.json()).toMatchObject({ status: 'completed', response: 'Hello back.' });
    const historyResponse = await worker.fetch(
      new Request(`https://swarm.example/api/chat?avatarId=${avatar.avatarId}`, { headers }),
      env,
    );
    expect(await historyResponse.json()).toEqual({
      history: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello back.' },
      ],
    });
  });

  it('stores a Queue-processed answer and replays one request without a second model call', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);
    const avatarRow = db.avatars.get(key(owner.accountId, avatar.avatarId));
    if (!avatarRow) throw new Error('Expected configured avatar.');
    avatarRow.persona = 'Be curious, playful, and direct.';

    const first = await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Hello', requestId: 'request-1' },
      2_000,
    );
    const replay = await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Hello again', requestId: 'request-1' },
      2_001,
    );
    expect(replay).toEqual({ jobId: first.jobId, replayed: true });
    expect(sent).toHaveLength(1);

    let modelCalls = 0;
    let authorization = '';
    let modelRequest = '';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      modelCalls += 1;
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      modelRequest = String(init?.body ?? '');
      return Response.json({ choices: [{ message: { content: 'Hello from Ada.' } }] });
    }) as typeof fetch;
    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl, 3_000)).resolves.toEqual({ action: 'ack' });
    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl, 3_001)).resolves.toEqual({ action: 'ack' });

    const job = await getHostedChatJob(env, owner, first.jobId);
    expect(job).toMatchObject({ status: 'completed', response: 'Hello from Ada.' });
    expect(job?.history).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello from Ada.' },
    ]);
    expect(modelCalls).toBe(1);
    expect(authorization).toBe('Bearer sk-secret-user-key');
    const request = JSON.parse(modelRequest) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.model).toBe('openrouter/free');
    expect(request.messages).toEqual([
      { role: 'system', content: 'Be curious, playful, and direct.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(JSON.stringify({ job, sent, db: [...db.jobs.values()] })).not.toContain('sk-secret-user-key');
  });

  it('sends no system message when the avatar has no persona', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);
    await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Hello', requestId: 'request-1' },
    );

    let modelRequest = '';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      modelRequest = String(init?.body ?? '');
      return Response.json({ choices: [{ message: { content: 'Hello.' } }] });
    }) as typeof fetch;
    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl)).resolves.toEqual({ action: 'ack' });

    const request = JSON.parse(modelRequest) as { messages: Array<{ role: string; content: string }> };
    expect(request.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('fails before enqueue when the account has no OpenRouter key', async () => {
    const db = new ChatMemoryD1();
    const sent: unknown[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message) });
    const owner = session('acct-a');
    const avatar = await createHostedAvatar(env, owner, { name: 'Ada' });

    await expect(
      enqueueHostedChat(env, owner, { avatarId: avatar.avatarId, message: 'Hello', requestId: 'request-1' }),
    ).rejects.toBeInstanceOf(HostedChatMissingKeyError);
    expect(sent).toHaveLength(0);
    expect(db.jobs.size).toBe(0);
  });

  it('keeps avatar, history, jobs, and secrets inside the owning account', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const stranger = session('acct-b');
    const avatar = await configuredAvatar(env, owner);
    const queued = await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Private', requestId: 'private-request' },
    );

    await expect(getHostedAvatar(env, stranger, avatar.avatarId)).resolves.toBeNull();
    await expect(listHostedChatHistory(env, stranger, avatar.avatarId)).resolves.toBeNull();
    await expect(getHostedChatJob(env, stranger, queued.jobId)).resolves.toBeNull();
    await expect(
      enqueueHostedChat(env, stranger, { avatarId: avatar.avatarId, message: 'Steal', requestId: 'steal-request' }),
    ).rejects.toBeInstanceOf(HostedChatNotFoundError);
  });

  it('serializes two jobs for one avatar through the coordinator', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);
    await enqueueHostedChat(env, owner, { avatarId: avatar.avatarId, message: 'One', requestId: 'request-1' });
    await enqueueHostedChat(env, owner, { avatarId: avatar.avatarId, message: 'Two', requestId: 'request-2' });

    let releaseModel = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const modelBodies: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      modelBodies.push(String(init?.body));
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await gate;
      activeCalls -= 1;
      return Response.json({ choices: [{ message: { content: 'Done' } }] });
    }) as typeof fetch;

    const first = processHostedChatQueueMessage(env, sent[0], fetchImpl);
    await Promise.resolve();
    const second = await processHostedChatQueueMessage(env, sent[1], fetchImpl);
    expect(second).toEqual({ action: 'retry', delaySeconds: 2 });
    releaseModel();
    await first;
    await processHostedChatQueueMessage(env, sent[1], fetchImpl);
    expect(maxActiveCalls).toBe(1);
    expect(modelBodies[0]).toContain('One');
    expect(modelBodies[0]).not.toContain('Two');
    expect(modelBodies[1]).toContain('Two');
  });

  it('uses bounded retries, then stores a safe dead state', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);
    const queued = await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Fail safely', requestId: 'request-1' },
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('upstream secret detail', { status: 503 });
    }) as typeof fetch;

    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl)).resolves.toMatchObject({ action: 'retry' });
    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl)).resolves.toMatchObject({ action: 'retry' });
    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl)).resolves.toEqual({ action: 'ack' });

    const job = await getHostedChatJob(env, owner, queued.jobId);
    expect(calls).toBe(3);
    expect(job).toMatchObject({
      status: 'failed',
      error: 'The AI provider is temporarily unavailable. Try again later.',
    });
    expect(JSON.stringify(job)).not.toContain('upstream secret detail');
  });

  it('turns a payment rejection into a useful error without exposing provider details', async () => {
    const db = new ChatMemoryD1();
    const sent: HostedChatQueueMessage[] = [];
    const env = testEnv(db, { send: async (message) => sent.push(message as HostedChatQueueMessage) });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);
    const queued = await enqueueHostedChat(
      env,
      owner,
      { avatarId: avatar.avatarId, message: 'Use a paid model', requestId: 'request-1' },
    );
    const fetchImpl = (async () => new Response('private provider billing detail', {
      status: 402,
    })) as typeof fetch;

    await expect(processHostedChatQueueMessage(env, sent[0], fetchImpl)).resolves.toEqual({ action: 'ack' });

    const job = await getHostedChatJob(env, owner, queued.jobId);
    expect(job).toMatchObject({
      status: 'failed',
      error: 'This OpenRouter model needs credits. Add credits or choose a free model, then try again.',
    });
    expect(db.jobs.get(`${owner.accountId}|${queued.jobId}`)).toMatchObject({
      error_code: 'model_payment_required',
    });
    expect(JSON.stringify(job)).not.toContain('private provider billing detail');
  });

  it('bounds initial Queue send attempts and records a safe failure', async () => {
    const db = new ChatMemoryD1();
    let sendCalls = 0;
    const env = testEnv(db, {
      send: async () => {
        sendCalls += 1;
        throw new Error('queue internals');
      },
    });
    const owner = session('acct-a');
    const avatar = await configuredAvatar(env, owner);

    await expect(
      enqueueHostedChat(env, owner, { avatarId: avatar.avatarId, message: 'Hello', requestId: 'request-1' }),
    ).rejects.toBeInstanceOf(HostedChatQueueError);
    expect(sendCalls).toBe(3);
    expect([...db.jobs.values()][0]).toMatchObject({
      status: 'dead',
      error_message: 'Hosted chat could not process this message. Try again later.',
    });
    expect(JSON.stringify([...db.jobs.values()])).not.toContain('queue internals');
  });
});
