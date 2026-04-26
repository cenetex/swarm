/**
 * Tests for classifyError — the canonical error classifier (aws-swarm#1550).
 */
import { describe, it, expect } from 'bun:test';
import { classifyError } from './classify.js';
import { PlatformError } from './errors.js';
import { SwarmErrorCode } from './codes.js';

describe('classifyError — PlatformError short-circuit', () => {
  it('honours an inner PlatformError with retryable=false', () => {
    const err = new PlatformError('Reply target message was deleted before send', {
      platform: 'telegram',
      statusCode: 400,
      retryable: false,
      code: SwarmErrorCode.PLATFORM_API_ERROR,
    });
    const c = classifyError(err);
    expect(c.retryable).toBe(false);
    expect(c.statusCode).toBe(400);
    expect(c.reason).toBe('reply_target_deleted');
    expect(c.platform).toBe('telegram');
  });

  it('honours an inner PlatformError with retryable=true', () => {
    const err = new PlatformError('Rate limited', {
      platform: 'discord',
      statusCode: 429,
      retryable: true,
    });
    const c = classifyError(err);
    expect(c.retryable).toBe(true);
    expect(c.statusCode).toBe(429);
  });

  it('maps PlatformError reply-deleted message to reply_target_deleted reason', () => {
    const err = new PlatformError('Reply target message was deleted before media send', {
      platform: 'telegram',
      statusCode: 400,
      retryable: false,
    });
    expect(classifyError(err).reason).toBe('reply_target_deleted');
  });
});

describe('classifyError — HTTP status-based classification', () => {
  it('400 → validation, non-retryable', () => {
    const c = classifyError({ status: 400, message: 'Bad Request' });
    expect(c.retryable).toBe(false);
    expect(c.reason).toBe('validation');
    expect(c.statusCode).toBe(400);
  });

  it('401 → auth, non-retryable', () => {
    const c = classifyError({ status: 401 });
    expect(c.retryable).toBe(false);
    expect(c.reason).toBe('auth');
  });

  it('403 → forbidden, non-retryable', () => {
    const c = classifyError({ status: 403 });
    expect(c.retryable).toBe(false);
    expect(c.reason).toBe('forbidden');
  });

  it('404 → not_found, non-retryable', () => {
    const c = classifyError({ status: 404 });
    expect(c.retryable).toBe(false);
    expect(c.reason).toBe('not_found');
  });

  it('429 → rate_limit, retryable', () => {
    const c = classifyError({ status: 429, retryAfter: 5000 });
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('rate_limit');
    expect(c.retryAfter).toBe(5000);
  });

  it('500/502/503 → server, retryable', () => {
    for (const s of [500, 502, 503, 504]) {
      const c = classifyError({ status: s });
      expect(c.retryable).toBe(true);
      expect(c.reason).toBe('server');
    }
  });

  it('reads statusCode when status is absent (covers PlatformError-shaped but not instanceof)', () => {
    const c = classifyError({ statusCode: 400, message: 'bad' });
    expect(c.retryable).toBe(false);
    expect(c.statusCode).toBe(400);
  });

  it('reads error_code when status and statusCode are absent (Telegram grammY shape)', () => {
    const c = classifyError({ error_code: 429, message: 'Too Many Requests' });
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('rate_limit');
  });
});

describe('classifyError — explicit retryable hint honoured', () => {
  it('trusts an explicit retryable:false even without status', () => {
    const c = classifyError({ retryable: false, message: 'custom unretryable' });
    expect(c.retryable).toBe(false);
  });
  it('trusts an explicit retryable:true without status', () => {
    const c = classifyError({ retryable: true, message: 'custom retryable' });
    expect(c.retryable).toBe(true);
  });
});

describe('classifyError — network / timeout markers', () => {
  it('timeout message → retryable with reason:timeout', () => {
    const c = classifyError(new Error('Request timed out'));
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('timeout');
  });
  it('AbortError name → timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const c = classifyError(err);
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('timeout');
  });
  it('ECONNRESET → network', () => {
    const c = classifyError(new Error('read ECONNRESET'));
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('network');
  });
  it('fetch failed → network', () => {
    const c = classifyError(new TypeError('fetch failed'));
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('network');
  });
});

describe('classifyError — unknown fallback', () => {
  it('unrecognized error defaults to retryable:true, reason:unknown', () => {
    const c = classifyError(new Error('something weird happened'));
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('unknown');
  });
  it('null / undefined → retryable:true, reason:unknown', () => {
    expect(classifyError(null).retryable).toBe(true);
    expect(classifyError(undefined).retryable).toBe(true);
    expect(classifyError(null).reason).toBe('unknown');
  });
  it('plain string → retryable:true, reason:unknown', () => {
    const c = classifyError('whoops');
    expect(c.retryable).toBe(true);
    expect(c.reason).toBe('unknown');
  });
});

describe('classifyError — platform context', () => {
  it('propagates ctx.platform when not on the error', () => {
    const c = classifyError(new Error('boom'), { platform: 'discord' });
    expect(c.platform).toBe('discord');
  });
  it('PlatformError.platform wins over ctx.platform', () => {
    const err = new PlatformError('x', { platform: 'telegram', statusCode: 500, retryable: true });
    const c = classifyError(err, { platform: 'discord' });
    expect(c.platform).toBe('telegram');
  });
});
