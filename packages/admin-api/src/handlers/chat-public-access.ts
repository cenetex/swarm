import type { HttpRequest } from "@swarm/core";

const RESERVED_PUBLIC_SUBDOMAINS = new Set([
  'swarm',
  'staging-swarm',
  'www',
  'admin',
  'api',
  'cdn',
  'gallery',
  'docs',
]);

function getPublicBaseDomain(): string {
  const explicit = (process.env.PUBLIC_CHAT_BASE_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '');
  if (explicit) return explicit;

  const authDomain = (process.env.AUTH_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '');
  if (authDomain) {
    const parts = authDomain.split('.').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    }
  }

  return 'rati.chat';
}

const PUBLIC_BASE_DOMAIN = getPublicBaseDomain();

function normalizeHostname(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return null;
    }
  }

  return trimmed
    .toLowerCase()
    .replace(/\.$/, '')
    .split(':')[0] || null;
}

function extractPublicAvatarIdFromHost(hostname: string): string | null {
  const suffix = `.${PUBLIC_BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;

  const subdomain = hostname.slice(0, -suffix.length);
  if (!subdomain) return null;
  if (RESERVED_PUBLIC_SUBDOMAINS.has(subdomain)) return null;
  if (subdomain.startsWith('admin-') || subdomain.startsWith('api-')) return null;
  return subdomain;
}

export function resolvePublicAvatarIdFromRequest(event: HttpRequest): string | null {
  const origin = normalizeHostname(event.headers.origin || event.headers.Origin);
  if (origin) {
    const avatarId = extractPublicAvatarIdFromHost(origin);
    if (avatarId) return avatarId;
  }

  const referer = normalizeHostname(event.headers.referer || event.headers.Referer);
  if (referer) {
    const avatarId = extractPublicAvatarIdFromHost(referer);
    if (avatarId) return avatarId;
  }

  const forwardedHost = normalizeHostname(event.headers['x-forwarded-host'] || event.headers['X-Forwarded-Host']);
  if (forwardedHost) {
    const avatarId = extractPublicAvatarIdFromHost(forwardedHost);
    if (avatarId) return avatarId;
  }

  const host = normalizeHostname(event.headers.host || event.headers.Host);
  if (host) {
    const avatarId = extractPublicAvatarIdFromHost(host);
    if (avatarId) return avatarId;
  }

  return null;
}
