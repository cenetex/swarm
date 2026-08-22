import type { HttpRequest } from "@swarm/core";

const DEFAULT_COOKIE_NAME = 'swarm_session';

function getCookieName(): string {
  const explicit = process.env.SESSION_COOKIE_NAME;
  if (explicit) return explicit;

  const environment = (process.env.ENVIRONMENT || '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();

  if (!environment) {
    // ENVIRONMENT drives cookie names. If absent, default to the production
    // cookie name; NODE_ENV=production remains a safety fallback.
    if (!nodeEnv || nodeEnv === 'production' || nodeEnv === 'prod') {
      return DEFAULT_COOKIE_NAME;
    }
    return DEFAULT_COOKIE_NAME;
  }

  if (environment === 'prod' || environment === 'production') {
    return DEFAULT_COOKIE_NAME;
  }

  const safe = environment.replace(/[^a-z0-9]/g, '_');
  return `${DEFAULT_COOKIE_NAME}_${safe}`;
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
  path: '/',
  maxAgeSeconds: 24 * 60 * 60,
};

function getCookieDomain(): string | undefined {
  const authDomain = process.env.AUTH_DOMAIN;
  if (!authDomain) return undefined;

  const parts = authDomain.split('.').filter(Boolean);
  if (parts.length >= 2) {
    return '.' + parts.slice(-2).join('.');
  }

  return undefined;
}

function buildCookie(params: {
  cookieName: string;
  value: string;
  maxAgeSeconds: number;
  domain?: string;
}): string {
  const parts = [
    `${params.cookieName}=${params.value}`,
    'HttpOnly',
    'Secure',
    `SameSite=${COOKIE_OPTIONS.sameSite}`,
    `Path=${COOKIE_OPTIONS.path}`,
    `Max-Age=${params.maxAgeSeconds}`,
  ];

  if (params.domain) {
    parts.push(`Domain=${params.domain}`);
  }

  return parts.join('; ');
}

/**
 * Read the swarm session token from the Cookie header.
 *
 * Note: If duplicates exist (host-only + Domain cookies), the order is not
 * guaranteed. We attempt to choose the first non-empty value; the codebase
 * should avoid duplicates by clearing the alternate scope when setting.
 */
export function getSessionFromCookie(event: HttpRequest): string | null {
  const cookieName = getCookieName();
  const cookies = event.cookies || [];
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === cookieName && value) return value;
  }

  // Some proxies/environments may not populate event.cookies; fall back to Cookie header.
  const cookieHeader = event.headers?.cookie || event.headers?.Cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split('=');
    if (name !== cookieName) continue;
    const value = rest.join('=');
    if (value) return value;
  }

  return null;
}

/**
 * Set the session cookie.
 *
 * If AUTH_DOMAIN implies a parent-domain cookie, we also clear any existing
 * host-only cookie to avoid duplicate swarm_session values being sent.
 */
export function getSetSessionCookies(sessionToken: string): string[] {
  const cookieName = getCookieName();
  const domain = getCookieDomain();

  if (!domain) {
    return [
      buildCookie({
        cookieName,
        value: sessionToken,
        maxAgeSeconds: COOKIE_OPTIONS.maxAgeSeconds,
      }),
    ];
  }

  return [
    // Preferred: parent-domain cookie shared across subdomains.
    buildCookie({
      cookieName,
      value: sessionToken,
      maxAgeSeconds: COOKIE_OPTIONS.maxAgeSeconds,
      domain,
    }),
    // Cleanup: clear host-only cookie to prevent duplicates.
    buildCookie({ cookieName, value: '', maxAgeSeconds: 0 }),
  ];
}

/**
 * Clear the session cookie.
 *
 * Clears both host-only and parent-domain variants (if applicable).
 */
export function getClearSessionCookies(): string[] {
  const cookieName = getCookieName();
  const domain = getCookieDomain();

  if (!domain) {
    return [buildCookie({ cookieName, value: '', maxAgeSeconds: 0 })];
  }

  return [
    buildCookie({ cookieName, value: '', maxAgeSeconds: 0 }),
    buildCookie({ cookieName, value: '', maxAgeSeconds: 0, domain }),
  ];
}
