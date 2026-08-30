import {
  canonicalPortableAvatarJson,
  CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN,
  parseHostingStatus,
  portableAvatarNftMetadata,
} from '@swarm/core/hosted';
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
  approveMobileWalletPairing,
  consumeMobileWalletPairing,
  createMobileWalletChallenge,
  createMobileWalletPairing,
} from './mobile-auth.js';
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
  enqueueHostedChat,
  getHostedAvatar,
  getHostedChatJob,
  HostedAvatarCoordinatorDurableObject,
  HostedChatConfigurationError,
  HostedChatMissingKeyError,
  HostedChatNotFoundError,
  HostedChatQueueError,
  HostedChatRateLimitError,
  listHostedChatHistory,
  processHostedChatQueueMessage,
} from './hosted-chat.js';
import {
  cleanupHostedTelegramRuntime,
  connectHostedTelegram,
  disconnectHostedTelegram,
  getHostedTelegramStatus,
  handleHostedTelegramWebhook,
  HostedTelegramAuthorizationError,
  HostedTelegramConflictError,
  HostedTelegramNotFoundError,
  processHostedTelegramQueueMessage,
  repairHostedTelegram,
} from './hosted-telegram.js';
import {
  createPortableHostedAvatar,
  getOwnedPortableRevision,
  getPublicAvatar,
  getPublicRevision,
  importPortableHostedAvatar,
  listOwnedPortableAvatars,
  listPublicAvatars,
  PortableAvatarAuthorizationError,
  PortableAvatarConflictError,
  updatePortableAvatarPublication,
} from './portable-avatars.js';

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

async function readJsonObject(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('Request body is too large.');
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

function optionalBooleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) throw new Error('Mobile pairing token is required.');
  return authorization.slice('Bearer '.length).trim();
}

function authenticatedWalletPayload(session: {
  accountId: string;
  walletAddress: string;
  expiresAt: number;
}): Record<string, unknown> {
  return {
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
  };
}

function openRouterReturnUrl(env: CloudflareHostedBindings, request: Request, result: 'connected' | 'error'): string {
  const configuredPath = env.SWARM_OPENROUTER_RETURN_PATH?.trim() || '/studio?ai=openrouter';
  const path = configuredPath.startsWith('/') && !configuredPath.startsWith('//')
    ? configuredPath
    : '/studio?ai=openrouter';
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

function securedAssetResponse(response: Response, env: CloudflareHostedBindings): Response {
  const headers = new Headers(response.headers);
  const contentType = headers.get('Content-Type') ?? '';
  headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'self' https://connect.solflare.com",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "form-action 'self' https://openrouter.ai",
  ].join('; '));
  headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (contentType.includes('text/html')) headers.set('Cache-Control', 'no-store');
  if (env.SWARM_ENV !== 'production') headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function avatarProjectAssetResponse(
  request: Request,
  env: CloudflareHostedBindings,
  slug: string,
): Promise<Response | null> {
  if (!env.SWARM_ASSETS) return null;
  const project = await getPublicAvatar(env, slug);
  if (!project) return null;
  const assetResponse = await env.SWARM_ASSETS.fetch(request);
  const contentType = assetResponse.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/html')) return securedAssetResponse(assetResponse, env);
  const title = escapeHtml(`${project.name} — Swarm`);
  const description = escapeHtml(project.description || `Explore ${project.name} on Swarm.`);
  const canonicalUrl = escapeHtml(`${hostedPublicOrigin(env, request)}/a/${project.slug}`);
  let html = await assetResponse.text();
  html = html
    .replace(/<title>[^<]*<\/title>/iu, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/iu, `<meta name="description" content="${description}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/>/iu, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/>/iu, `<meta property="og:description" content="${description}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/>/iu, `<meta name="twitter:title" content="${title}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*"\s*\/>/iu, `<meta name="twitter:description" content="${description}" />`)
    .replace(/\s*<meta property="og:image" content="[^"]*"\s*\/>/iu, '')
    .replace(/\s*<meta name="twitter:image" content="[^"]*"\s*\/>/iu, '')
    .replace('</head>', `<link rel="canonical" href="${canonicalUrl}" /></head>`);
  const headers = new Headers(assetResponse.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  return securedAssetResponse(new Response(html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  }), env);
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

  if (url.pathname === '/api/public/avatars' && request.method === 'GET') {
    return json(await listPublicAvatars(env), {
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    });
  }

  const publicAvatarMatch = url.pathname.match(
    /^\/api\/public\/avatars\/([^/]+)(?:\/(bundle|nft-metadata))?$/u,
  );
  if (publicAvatarMatch && request.method === 'GET') {
    const slugOrId = decodeURIComponent(publicAvatarMatch[1] ?? '');
    if (!validResourceId(slugOrId)) return json({ error: 'Avatar id is invalid.' }, { status: 400 });
    const project = await getPublicAvatar(env, slugOrId);
    if (!project) return json({ error: 'Public avatar was not found.' }, { status: 404 });
    const action = publicAvatarMatch[2];
    if (action === 'bundle') {
      return new Response(canonicalPortableAvatarJson(project.bundle), {
        headers: {
          'Content-Type': 'application/vnd.swarm.avatar+json',
          'Content-Disposition': `attachment; filename="${project.slug}-${project.sha256.slice(0, 12)}.swarm-avatar.json"`,
          'Cache-Control': 'public, max-age=300, immutable',
          ETag: `"${project.sha256}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (action === 'nft-metadata') {
      const origin = hostedPublicOrigin(env, request);
      const bundleUrl = `${origin}/api/public/revisions/${encodeURIComponent(project.revisionId)}.json`;
      return json(
        portableAvatarNftMetadata(
          { revisionId: project.revisionId, sha256: project.sha256, bundle: project.bundle },
          bundleUrl,
          `${origin}/a/${project.slug}`,
        ),
        { headers: { 'Cache-Control': 'public, max-age=300' } },
      );
    }
    return json(project, {
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    });
  }

  const publicRevisionMatch = url.pathname.match(/^\/api\/public\/revisions\/([^/]+)\.json$/u);
  if (publicRevisionMatch && request.method === 'GET') {
    const revisionId = decodeURIComponent(publicRevisionMatch[1] ?? '');
    const revision = await getPublicRevision(env, revisionId);
    if (!revision) return json({ error: 'Public avatar revision was not found.' }, { status: 404 });
    return new Response(canonicalPortableAvatarJson(revision.bundle), {
      headers: {
        'Content-Type': 'application/vnd.swarm.avatar+json',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"${revision.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
    const origin = hostedPublicOrigin(env, request);
    const avatars = await listPublicAvatars(env);
    const locations = [origin, ...avatars.map((avatar) => `${origin}/a/${avatar.slug}`)];
    const document = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...locations.map((location) => `<url><loc>${location}</loc></url>`),
      '</urlset>',
    ].join('');
    return new Response(document, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const telegramWebhookMatch = url.pathname.match(/^\/api\/webhooks\/telegram\/([A-Za-z0-9_-]{24,80})$/u);
  if (telegramWebhookMatch && request.method === 'POST') {
    const integrationId = telegramWebhookMatch[1] ?? '';
    return json(await handleHostedTelegramWebhook(env, integrationId, request));
  }

  if (url.pathname === '/api/auth/mobile/start' && request.method === 'POST') {
    assertSameOrigin(env, request);
    return json(await createMobileWalletPairing(env, request), { status: 201 });
  }

  const mobileAuthMatch = url.pathname.match(
    /^\/api\/auth\/mobile\/([A-Za-z0-9_-]{24,64})(?:\/(challenge|verify))?$/u,
  );
  if (mobileAuthMatch) {
    const pairingId = mobileAuthMatch[1] ?? '';
    const action = mobileAuthMatch[2];
    if (!action && request.method === 'GET') {
      const result = await consumeMobileWalletPairing(env, pairingId, bearerToken(request));
      if (result.status === 'not-found') return json({ status: result.status }, { status: 404 });
      if (result.status === 'expired') return json({ status: result.status }, { status: 410 });
      if (result.status === 'pending') return json(result, { status: 202 });
      return json(authenticatedWalletPayload(result.session), {
        headers: { 'Set-Cookie': hostedSessionCookie(result.session.sessionToken) },
      });
    }
    if (action === 'challenge' && request.method === 'POST') {
      assertSameOrigin(env, request);
      const body = await readJsonObject(request);
      return json(
        await createMobileWalletChallenge(
          env,
          request,
          pairingId,
          stringField(body, 'walletAddress'),
        ),
      );
    }
    if (action === 'verify' && request.method === 'POST') {
      assertSameOrigin(env, request);
      const body = await readJsonObject(request);
      const walletAddress =
        typeof body.walletAddress === 'string' ? body.walletAddress.trim() : stringField(body, 'publicKey');
      const approved = await approveMobileWalletPairing(env, pairingId, {
        walletAddress,
        nonce: stringField(body, 'nonce'),
        signature: stringField(body, 'signature'),
      });
      if (!approved) return json({ error: 'Mobile wallet approval is invalid or expired.' }, { status: 401 });
      return json({ success: true, status: 'approved' });
    }
    return json({ error: 'Method not allowed.' }, { status: 405 });
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
      authenticatedWalletPayload(session),
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
    return json(await listOwnedPortableAvatars(env, session));
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
    const persona = optionalStringField(body, 'persona');
    const visibilityValue = optionalStringField(body, 'visibility');
    if (visibilityValue && visibilityValue !== 'public' && visibilityValue !== 'private') {
      return json({ error: 'visibility must be public or private.' }, { status: 400 });
    }
    const visibility = visibilityValue as 'public' | 'private' | undefined;
    const listed = optionalBooleanField(body, 'listed');
    if (name.length > 80) return json({ error: 'Avatar name is too large.' }, { status: 400 });
    if ((description?.length ?? 0) > 1_000) return json({ error: 'Avatar description is too large.' }, { status: 400 });
    if ((persona?.length ?? 0) > 50_000) return json({ error: 'Avatar persona is too large.' }, { status: 400 });
    return json(await createPortableHostedAvatar(env, session, {
      name,
      ...(description ? { description } : {}),
      ...(persona ? { persona } : {}),
      ...(visibility ? { visibility } : {}),
      ...(listed === undefined ? {} : { listed }),
    }), {
      status: 201,
    });
  }

  if (url.pathname === '/api/avatars/import' && request.method === 'POST') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const body = await readJsonObject(request, 5 * 1024 * 1024);
    return json(await importPortableHostedAvatar(env, session, body.bundle ?? body), { status: 201 });
  }

  const ownedBundleMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)\/bundle$/u);
  if (ownedBundleMatch && request.method === 'GET') {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = decodeURIComponent(ownedBundleMatch[1] ?? '');
    if (!validResourceId(avatarId)) return json({ error: 'Avatar id is invalid.' }, { status: 400 });
    const revision = await getOwnedPortableRevision(env, session, avatarId);
    if (!revision) return json({ error: 'Portable avatar was not found.' }, { status: 404 });
    return new Response(canonicalPortableAvatarJson(revision.bundle), {
      headers: {
        'Content-Type': 'application/vnd.swarm.avatar+json',
        'Content-Disposition': `attachment; filename="${revision.bundle.identity.slug}-${revision.sha256.slice(0, 12)}.swarm-avatar.json"`,
        'Cache-Control': 'private, no-store',
        ETag: `"${revision.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const ownedPublicationMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)\/publication$/u);
  if (ownedPublicationMatch && request.method === 'PATCH') {
    assertSameOrigin(env, request);
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = decodeURIComponent(ownedPublicationMatch[1] ?? '');
    if (!validResourceId(avatarId)) return json({ error: 'Avatar id is invalid.' }, { status: 400 });
    const body = await readJsonObject(request);
    const visibilityValue = stringField(body, 'visibility');
    if (visibilityValue !== 'public' && visibilityValue !== 'private') {
      return json({ error: 'visibility must be public or private.' }, { status: 400 });
    }
    const listed = optionalBooleanField(body, 'listed');
    const avatar = await updatePortableAvatarPublication(env, session, avatarId, {
      visibility: visibilityValue,
      ...(listed === undefined ? {} : { listed }),
    });
    return avatar ? json(avatar) : json({ error: 'Portable avatar was not found.' }, { status: 404 });
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

  const telegramIntegrationMatch = url.pathname.match(
    /^\/api\/avatars\/([^/]+)\/integrations\/telegram(?:\/(repair))?$/u,
  );
  if (telegramIntegrationMatch) {
    const session = await getHostedSession(env, request);
    if (!session) return json({ error: 'Authentication required.' }, { status: 401 });
    const avatarId = decodeURIComponent(telegramIntegrationMatch[1] ?? '');
    if (!validResourceId(avatarId)) return json({ error: 'Avatar id is invalid.' }, { status: 400 });
    const action = telegramIntegrationMatch[2];
    if (!action && request.method === 'GET') {
      return json(await getHostedTelegramStatus(env, session, avatarId));
    }
    assertSameOrigin(env, request);
    if (!action && request.method === 'POST') {
      if (!hostedChatConfigurationReady(env)) {
        return json({ error: 'Hosted Telegram is not configured.' }, { status: 503 });
      }
      const body = await readJsonObject(request);
      return json(await connectHostedTelegram(env, session, {
        avatarId,
        botToken: stringField(body, 'botToken'),
        publicOrigin: hostedPublicOrigin(env, request),
      }), { status: 201 });
    }
    if (!action && request.method === 'DELETE') {
      return json(await disconnectHostedTelegram(env, session, avatarId));
    }
    if (action === 'repair' && request.method === 'POST') {
      return json(await repairHostedTelegram(env, session, {
        avatarId,
        publicOrigin: hostedPublicOrigin(env, request),
      }));
    }
    return json({ error: 'Method not allowed.' }, { status: 405 });
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

  if (
    env.SWARM_ASSETS
    && (request.method === 'GET' || request.method === 'HEAD')
    && url.pathname !== '/api'
    && !url.pathname.startsWith('/api/')
  ) {
    const publicPageMatch = url.pathname.match(/^\/a\/([^/]+)\/?$/u);
    if (publicPageMatch) {
      const response = await avatarProjectAssetResponse(
        request,
        env,
        decodeURIComponent(publicPageMatch[1] ?? ''),
      );
      if (response) return response;
    }
    return securedAssetResponse(await env.SWARM_ASSETS.fetch(request), env);
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
      if (error instanceof HostedTelegramAuthorizationError) return json({ error: detail }, { status: 403 });
      if (error instanceof HostedTelegramConflictError) return json({ error: detail }, { status: 409 });
      if (error instanceof HostedTelegramNotFoundError) return json({ error: detail }, { status: 404 });
      if (error instanceof PortableAvatarAuthorizationError) return json({ error: detail }, { status: 403 });
      if (error instanceof PortableAvatarConflictError) return json({ error: detail }, { status: 409 });
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
    await cleanupHostedTelegramRuntime(env, controller.scheduledTime);
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
    await Promise.all(batch.messages.map(async (message) => {
      try {
        const type = message.body && typeof message.body === 'object'
          ? (message.body as { type?: unknown }).type
          : undefined;
        const disposition = type === 'swarm.hosted.telegram.update'
          ? await processHostedTelegramQueueMessage(env, message.body)
          : await processHostedChatQueueMessage(env, message.body);
        if (disposition.action === 'retry') message.retry({ delaySeconds: disposition.delaySeconds });
        else message.ack();
      } catch {
        message.retry({ delaySeconds: 10 });
      }
    }));
  },
};
