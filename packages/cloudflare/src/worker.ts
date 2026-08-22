import { CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN, parseHostingStatus } from '@swarm/core';
import type { CloudflareHostedBindings } from './bindings.js';
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
      if (error instanceof HostedOriginError) {
        return json({ error: detail }, { status: 403 });
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
    const platform = createCloudflareHostedPlatform(env);
    await platform.queues.send('default', {
      type: 'swarm.cron.tick',
      payload: {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      },
    });
  },
};
