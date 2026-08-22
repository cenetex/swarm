import { CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN, parseHostingStatus } from '@swarm/core';
import type { CloudflareHostedBindings, CloudflareQueueBatch } from './bindings.js';
import {
  assertSameOrigin,
  clearHostedSessionCookie,
  cleanupExpiredHostedAuth,
  createWalletChallenge,
  deleteHostedSession,
  getHostedSession,
  hostedPublicOrigin,
  HostedOriginError,
  HostedRateLimitError,
  hostedSessionCookie,
  verifyWalletChallenge,
} from './auth.js';
import {
  beginOpenRouterConnect,
  completeOpenRouterConnect,
  disconnectOpenRouter,
  getOpenRouterConnectionStatus,
} from './openrouter.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { isHostedSecretKeyValid } from './secret-crypto.js';
import {
  clearHostedChatHistory,
  cleanupHostedChatRuntime,
  createHostedAvatar,
  enqueueHostedChat,
  getHostedAvatar,
  getHostedChatJob,
  HostedAvatarCoordinatorDurableObject,
  HostedChatConfigurationError,
  HostedChatMissingKeyError,
  HostedChatNotFoundError,
  HostedChatQueueError,
  HostedChatRateLimitError,
  listHostedAvatars,
  listHostedChatHistory,
  processHostedChatQueueBatch,
} from './hosted-chat.js';

export { HostedAvatarCoordinatorDurableObject };

type ScheduledController = {
  scheduledTime: number;
  cron: string;
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(init.headers ?? {}),
    },
  });
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 16_384) throw new Error('Request body is too large.');
  const text = await request.text();
  if (text.length > 16_384) throw new Error('Request body is too large.');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Invalid JSON request body.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required.');
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return value.trim() || undefined;
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function openRouterReturnUrl(env: CloudflareHostedBindings, request: Request, result: 'connected' | 'error'): string {
  const configuredPath = env.SWARM_OPENROUTER_RETURN_PATH?.trim() || '/?ai=openrouter';
  const path = configuredPath.startsWith('/') && !configuredPath.startsWith('//') ? configuredPath : '/?ai=openrouter';
  const url = new URL(path, hostedPublicOrigin(env, request));
  url.searchParams.set('openrouter', result);
  return url.toString();
}

function hostedConfigurationReady(env: CloudflareHostedBindings): boolean {
  if (
    env.SWARM_HOSTED_ENABLED !== '1' ||
    !env.SWARM_PUBLIC_URL ||
    !isHostedSecretKeyValid(env.SWARM_USER_SECRET_KEK)
  ) {
    return false;
  }
  try {
    const publicUrl = new URL(env.SWARM_PUBLIC_URL);
    return env.SWARM_ENV !== 'production' || publicUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostedChatConfigurationReady(env: CloudflareHostedBindings): boolean {
  return hostedConfigurationReady(env) && !!env.SWARM_QUEUE && !!env.SWARM_AVATAR_COORDINATORS;
}

async function handleRequest(request: Request, env: CloudflareHostedBindings): Promise<Response> {
  const url = new URL(request.url);
  const platform = createCloudflareHostedPlatform(env);
  if (url.pathname === '/health' && request.method === 'GET') {
    return json({
      status: 'ok',
      backend: platform.descriptor.kind,
      mode: platform.descriptor.mode,
      capabilities: platform.descriptor.capabilities,
      environment: env.SWARM_ENV ?? 'development',
    });
  }
  if (url.pathname === '/api/hosting/status' && request.method === 'GET') {
    const configured = hostedConfigurationReady(env);
    return json(
      parseHostingStatus({
        mode: 'local',
        local: {
          available: false,
          running: false,
          label: 'This device',
          detail: 'Local mode runs from the native app and is not managed by this hosted Worker.',
        },
        hosted: {
          available: configured,
          configured,
          label: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.label,
          priceUsdMonthly: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.priceUsdMonthly,
          provider: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.provider,
          architecture: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.architecture,
          status: configured ? 'available' : 'not-configured',
          entitlement: 'none',
          plan: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN,
          detail: configured
            ? 'Hosted runtime is ready for wallet sign-in and entitlement activation.'
            : 'Hosted runtime requires its public URL and encrypted secret keyring.',
        },
      }),
    );
  }

  if (env.SWARM_ENV === 'production' && !hostedConfigurationReady(env)) {
    return json({ error: 'Hosted runtime is not configured.' }, { status: 503 });
  }

  if (
    (url.pathname === '/api/auth/wallet/challenge' || url.pathname === '/api/auth/challenge') &&
    request.method === 'POST'
  ) {
    assertSameOrigin(env, request);
    const body = await readJsonObject(request);
    return json(await createWalletChallenge(env, request, stringField(body, 'walletAddress')));
  }

  if (
    (url.pathname === '/api/auth/wallet/verify' || url.pathname === '/api/auth/verify') &&
    request.method === 'POST'
  ) {
    assertSameOrigin(env, request);
    const body = await readJsonObject(request);
    const walletAddress =
      typeof body.walletAddress === 'string' ? body.walletAddress.trim() : stringField(body, 'publicKey');
    const session = await verifyWalletChallenge(env, {
      walletAddress,
      nonce: stringField(body, 'nonce'),
      signature: stringField(body, 'signature'),
    });
    if (!session) return json({ error: 'Wallet challenge is invalid or expired.' }, { status: 401 });
    return json(
      {
        success: true,
        authenticated: true,
        accountId: session.accountId,
        walletAddress: session.walletAddress,
        expiresAt: session.expiresAt,
        session: { expiresAt: session.expiresAt },
        account: {
          accountId: session.accountId,
          role: 'user',
          identities: [{ type: 'wallet', providerId: session.walletAddress }],
        },
        user: { walletAddress: session.walletAddress },
      },
      {
        headers: { 'Set-Cookie': hostedSessionCookie(session.sessionToken) },
      },
    );
  }

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ authenticated: false }, { status: 401 });
    return json({
      authenticated: true,
      accountId: session.accountId,
      walletAddress: session.walletAddress,
      expiresAt: session.expiresAt,
      authProvider: 'wallet',
      account: {
        accountId: session.accountId,
        role: 'user',
        identities: [{ type: 'wallet', providerId: session.walletAddress }],
      },
      user: {
        id: session.walletAddress,
        walletAddress: session.walletAddress,
      },
    });
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    assertSameOrigin(env, request);
    await deleteHostedSession(env, request);
    return json(
      { authenticated: false },
      {
        headers: { 'Set-Cookie': clearHostedSessionCookie() },
      },
    );
  }

  if (url.pathname === '/api/auth/openrouter' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const callbackUrl = `${hostedPublicOrigin(env, request)}/api/auth/openrouter/callback`;
    return redirect(await beginOpenRouterConnect(env, session, callbackUrl));
  }

  if (url.pathname === '/api/auth/openrouter/callback' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return redirect(openRouterReturnUrl(env, request, 'error'));
    try {
      const connected = await completeOpenRouterConnect({
        env,
        session,
        secrets: platform.secrets,
        code: url.searchParams.get('code') ?? '',
        state: url.searchParams.get('state') ?? '',
      });
      return redirect(openRouterReturnUrl(env, request, connected ? 'connected' : 'error'));
    } catch {
      return redirect(openRouterReturnUrl(env, request, 'error'));
    }
  }

  if (url.pathname === '/api/auth/openrouter/status' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    return json(await getOpenRouterConnectionStatus(platform.secrets, session));
  }

  if (url.pathname === '/api/llm/status' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const status = await getOpenRouterConnectionStatus(platform.secrets, session);
    return json({
      configured: status.connected,
      provider: status.provider,
      selectedProvider: status.provider,
      openrouter: { configured: status.connected },
      ollama: { available: false, endpoint: '' },
    });
  }

  if (url.pathname === '/api/secrets/llm-api-key' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const exists = await platform.secrets.hasUserSecret({ accountId: session.accountId }, 'llm-api-key');
    return json({ name: 'llm-api-key', exists });
  }

  if (url.pathname === '/api/secrets/llm-api-key' && request.method === 'POST') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const body = await readJsonObject(request);
    const value = stringField(body, 'value');
    if (value.length > 16_384) return json({ error: 'AI API key is too large.' }, { status: 400 });
    const scope = { accountId: session.accountId };
    await platform.secrets.putUserSecret(scope, 'llm-api-key', value);
    await platform.secrets.putUserSecret(scope, 'llm-provider', 'openrouter');
    return json({ name: 'llm-api-key', exists: true, provider: 'openrouter' });
  }

  if (url.pathname === '/api/llm/provider' && request.method === 'DELETE') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    await disconnectOpenRouter(platform.secrets, session);
    return json({
      configured: false,
      provider: null,
      selectedProvider: null,
      openrouter: { configured: false },
      ollama: { available: false, endpoint: '' },
    });
  }

  if (url.pathname === '/api/auth/openrouter' && request.method === 'DELETE') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    await disconnectOpenRouter(platform.secrets, session);
    return json({ connected: false, provider: null });
  }

  if (url.pathname === '/api/avatars' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    return json(await listHostedAvatars(env, session));
  }

  if (url.pathname === '/api/avatars' && request.method === 'POST') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    if (!hostedChatConfigurationReady(env)) {
      return json({ error: 'Hosted chat is not configured.' }, { status: 503 });
    }
    const body = await readJsonObject(request);
    const name = stringField(body, 'name');
    const description = optionalStringField(body, 'description');
    if (name.length > 80) return json({ error: 'Avatar name is too large.' }, { status: 400 });
    if ((description?.length ?? 0) > 1_000) return json({ error: 'Avatar description is too large.' }, { status: 400 });
    return json(await createHostedAvatar(env, session, { name, ...(description ? { description } : {}) }), {
      status: 201,
    });
  }

  const avatarMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)$/u);
  if (avatarMatch && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = decodeURIComponent(avatarMatch[1] ?? '');
    if (!validResourceId(avatarId)) return json({ error: 'Avatar id is invalid.' }, { status: 400 });
    const avatar = await getHostedAvatar(env, session, avatarId);
    return avatar ? json(avatar) : json({ error: 'Hosted avatar was not found.' }, { status: 404 });
  }

  if (url.pathname === '/api/chat' && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = url.searchParams.get('avatarId')?.trim() ?? '';
    if (!validResourceId(avatarId)) return json({ error: 'avatarId is required.' }, { status: 400 });
    const history = await listHostedChatHistory(env, session, avatarId);
    return history ? json({ history }) : json({ error: 'Hosted avatar was not found.' }, { status: 404 });
  }

  if (url.pathname === '/api/chat' && request.method === 'DELETE') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = url.searchParams.get('avatarId')?.trim() ?? '';
    if (!validResourceId(avatarId)) return json({ error: 'avatarId is required.' }, { status: 400 });
    const cleared = await clearHostedChatHistory(env, session, avatarId);
    return cleared ? json({ success: true }) : json({ error: 'Hosted avatar was not found.' }, { status: 404 });
  }

  if (url.pathname === '/api/chat' && request.method === 'POST') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    if (!hostedChatConfigurationReady(env)) {
      return json({ error: 'Hosted chat is not configured.' }, { status: 503 });
    }
    const body = await readJsonObject(request);
    const message = stringField(body, 'message');
    if (message.length > 4_000) return json({ error: 'Chat message is too large.' }, { status: 400 });
    const avatarValue = body.avatar;
    const avatarId = avatarValue && typeof avatarValue === 'object' && !Array.isArray(avatarValue)
      ? optionalStringField(avatarValue as Record<string, unknown>, 'id')
      : optionalStringField(body, 'avatarId');
    if (!avatarId || !validResourceId(avatarId)) return json({ error: 'avatar.id is required.' }, { status: 400 });
    const providedRequestId = optionalStringField(body, 'requestId');
    const requestId = providedRequestId ?? `request_${crypto.randomUUID()}`;
    if (!validResourceId(requestId)) return json({ error: 'requestId is invalid.' }, { status: 400 });
    const queued = await enqueueHostedChat(env, session, { avatarId, message, requestId });
    return json(
      {
        jobId: queued.jobId,
        type: 'chat',
        status: 'pending',
        requestId,
        replayed: queued.replayed,
      },
      { status: 202 },
    );
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/u);
  if (jobMatch && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const jobId = decodeURIComponent(jobMatch[1] ?? '');
    if (!validResourceId(jobId)) return json({ error: 'Job id is invalid.' }, { status: 400 });
    const job = await getHostedChatJob(env, session, jobId);
    return job ? json(job) : json({ error: 'Hosted chat job was not found.' }, { status: 404 });
  }

  return json({ error: 'Cloudflare hosted Swarm route not implemented yet' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: CloudflareHostedBindings): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown hosted error.';
      if (error instanceof HostedRateLimitError) {
        return json(
          { error: detail, retryAfter: error.retryAfter },
          {
            status: 429,
            headers: { 'Retry-After': String(error.retryAfter) },
          },
        );
      }
      if (error instanceof HostedChatRateLimitError) {
        return json(
          { error: detail, retryAfter: error.retryAfter, limitType: 'messages' },
          {
            status: 429,
            headers: { 'Retry-After': String(error.retryAfter) },
          },
        );
      }
      if (error instanceof HostedOriginError) {
        return json({ error: detail }, { status: 403 });
      }
      if (error instanceof HostedChatNotFoundError) return json({ error: detail }, { status: 404 });
      if (error instanceof HostedChatMissingKeyError) return json({ error: detail }, { status: 409 });
      if (error instanceof HostedChatQueueError || error instanceof HostedChatConfigurationError) {
        return json({ error: detail }, { status: 503 });
      }
      const isClientError = /required|invalid|base58|32 bytes|too large|JSON object|Cross-origin/iu.test(detail);
      return json(
        {
          error: isClientError || env.SWARM_ENV !== 'production' ? detail : 'Hosted request failed.',
        },
        { status: isClientError ? 400 : 500 },
      );
    }
  },

  async scheduled(controller: ScheduledController, env: CloudflareHostedBindings): Promise<void> {
    await cleanupExpiredHostedAuth(env, controller.scheduledTime);
    await cleanupHostedChatRuntime(env, controller.scheduledTime);
    const platform = createCloudflareHostedPlatform(env);
    await platform.queues.send('default', {
      type: 'swarm.cron.tick',
      payload: {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      },
    });
  },

  async queue(batch: CloudflareQueueBatch, env: CloudflareHostedBindings): Promise<void> {
    await processHostedChatQueueBatch(batch, env);
  },
};
