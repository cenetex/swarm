import type { HttpRequest } from "@swarm/core";

function getHeader(event: HttpRequest, name: string): string | undefined {
  const direct = event.headers?.[name];
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export interface CorsOptions {
  allowCredentials?: boolean;
  allowMethods?: string;
  allowHeaders?: string;
}

export function getCorsHeaders(
  event: HttpRequest,
  options: CorsOptions = {}
): Record<string, string> {
  const origin = getHeader(event, 'origin') || '';
  const allowedOrigins = parseAllowedOrigins();

  // If no origins configured, don't emit CORS headers.
  // This keeps same-origin /api proxy simple while allowing opt-in for local dev.
  if (allowedOrigins.length === 0) {
    return {};
  }

  const allowOrigin = resolveAllowedOrigin(origin, allowedOrigins) ?? allowedOrigins[0];

  const allowCredentials = options.allowCredentials ?? true;
  const allowMethods = options.allowMethods ?? 'GET, POST, PUT, DELETE, OPTIONS';
  const allowHeaders =
    options.allowHeaders ??
    'Content-Type, Authorization, Prefer, Idempotency-Key, x-internal-test-key';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': allowCredentials ? 'true' : 'false',
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
    // Important when reflecting specific origins.
    'Vary': 'Origin',
    // Security headers
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  };
}

function resolveAllowedOrigin(origin: string, allowedOrigins: string[]): string | null {
  if (!origin) return null;
  if (allowedOrigins.includes(origin)) return origin;

  for (const allowed of allowedOrigins) {
    if (!allowed.includes('*')) continue;
    const pattern = wildcardToRegExp(allowed);
    if (pattern.test(origin)) return origin;
  }

  return null;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = `^${escaped.replace(/\*/g, '.*')}$`;
  return new RegExp(regex);
}
