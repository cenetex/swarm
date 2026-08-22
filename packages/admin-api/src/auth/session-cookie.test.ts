import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { HttpRequest } from 'aws-lambda';

import { getClearSessionCookies, getSessionFromCookie, getSetSessionCookies } from './session-cookie.js';

describe('session-cookie', () => {
  const prevAuthDomain = process.env.AUTH_DOMAIN;
  const prevEnvironment = process.env.ENVIRONMENT;
  const prevSessionCookieName = process.env.SESSION_COOKIE_NAME;

  beforeEach(() => {
    delete process.env.AUTH_DOMAIN;
    delete process.env.ENVIRONMENT;
    delete process.env.SESSION_COOKIE_NAME;
  });

  afterEach(() => {
    if (prevAuthDomain === undefined) {
      delete process.env.AUTH_DOMAIN;
    } else {
      process.env.AUTH_DOMAIN = prevAuthDomain;
    }

    if (prevEnvironment === undefined) {
      delete process.env.ENVIRONMENT;
    } else {
      process.env.ENVIRONMENT = prevEnvironment;
    }

    if (prevSessionCookieName === undefined) {
      delete process.env.SESSION_COOKIE_NAME;
    } else {
      process.env.SESSION_COOKIE_NAME = prevSessionCookieName;
    }
  });

  it('getSessionFromCookie returns null when no cookies', () => {
    const event = { cookies: [] } as unknown as HttpRequest;
    expect(getSessionFromCookie(event)).toBeNull();
  });

  it('getSessionFromCookie returns the first non-empty swarm_session value', () => {
    const event = {
      cookies: [
        'foo=bar',
        'swarm_session=',
        'swarm_session=token-1',
        'swarm_session=token-2',
      ],
    } as unknown as HttpRequest;

    expect(getSessionFromCookie(event)).toBe('token-1');
  });

  it('getSessionFromCookie falls back to parsing the Cookie header when event.cookies is missing', () => {
    const event = {
      headers: {
        cookie: 'foo=bar; swarm_session=abc; baz=qux',
      },
    } as unknown as HttpRequest;

    expect(getSessionFromCookie(event)).toBe('abc');
  });

  it('getSetSessionCookies sets host-only cookie when AUTH_DOMAIN not set', () => {
    const cookies = getSetSessionCookies('abc');
    expect(cookies).toHaveLength(1);

    const c = cookies[0];
    expect(c).toContain('swarm_session=abc');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=86400');
    expect(c).not.toContain('Domain=');
  });

  it('getSetSessionCookies sets a parent-domain cookie and clears host-only when AUTH_DOMAIN is set', () => {
    process.env.AUTH_DOMAIN = 'swarm.rati.chat';

    const cookies = getSetSessionCookies('abc');
    expect(cookies).toHaveLength(2);

    // Parent-domain cookie
    expect(cookies[0]).toContain('swarm_session=abc');
    expect(cookies[0]).toContain('Domain=.rati.chat');
    expect(cookies[0]).toContain('Max-Age=86400');

    // Host-only cleanup cookie
    expect(cookies[1]).toContain('swarm_session=');
    expect(cookies[1]).not.toContain('Domain=');
    expect(cookies[1]).toContain('Max-Age=0');
  });

  it('getClearSessionCookies clears both host-only and parent-domain when AUTH_DOMAIN is set', () => {
    process.env.AUTH_DOMAIN = 'swarm.rati.chat';

    const cookies = getClearSessionCookies();
    expect(cookies).toHaveLength(2);

    expect(cookies[0]).toContain('swarm_session=');
    expect(cookies[0]).not.toContain('Domain=');
    expect(cookies[0]).toContain('Max-Age=0');

    expect(cookies[1]).toContain('swarm_session=');
    expect(cookies[1]).toContain('Domain=.rati.chat');
    expect(cookies[1]).toContain('Max-Age=0');
  });

  it('uses an environment-scoped cookie name outside prod', () => {
    process.env.ENVIRONMENT = 'staging';

    const cookies = getSetSessionCookies('abc');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('swarm_session_staging=abc');
  });

  it('getSessionFromCookie reads the environment-scoped cookie name', () => {
    process.env.ENVIRONMENT = 'staging';
    const event = {
      cookies: ['swarm_session=prod-token', 'swarm_session_staging=staging-token'],
    } as unknown as HttpRequest;

    expect(getSessionFromCookie(event)).toBe('staging-token');
  });
});
