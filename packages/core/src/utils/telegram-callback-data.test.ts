import { describe, it, expect } from 'bun:test';
import { signCallbackData, verifyCallbackData } from './telegram-callback-data.js';

const KEY = 'test-signing-key-32-bytes-long-aaaaa';

describe('telegram-callback-data', () => {
  it('round-trips a signed payload', () => {
    const payload = 'a:k9x7:bind:ok';
    const signed = signCallbackData(payload, KEY);
    const result = verifyCallbackData(signed, KEY);
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
  });

  it('rejects tampered payload', () => {
    const signed = signCallbackData('a:k9x7:bind:ok', KEY);
    const tampered = signed.replace(':ok', ':no');
    const result = verifyCallbackData(tampered, KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects tampered signature', () => {
    const signed = signCallbackData('a:k9x7:bind:ok', KEY);
    const tampered = signed.slice(0, -3) + 'AAA';
    const result = verifyCallbackData(tampered, KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects payload with no signature delimiter', () => {
    const result = verifyCallbackData('no-delimiter-here', KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects empty signature', () => {
    const result = verifyCallbackData('payload.', KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects wrong-length signature', () => {
    const result = verifyCallbackData('payload.short', KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects a different key', () => {
    const signed = signCallbackData('a:k9x7:bind:ok', KEY);
    const result = verifyCallbackData(signed, 'different-key');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects empty key on sign', () => {
    expect(() => signCallbackData('x', '')).toThrow();
  });

  it('rejects empty key on verify', () => {
    const result = verifyCallbackData('x.y', '');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_key');
  });

  it('rejects payload containing "." (dot is the delimiter)', () => {
    expect(() => signCallbackData('a.b', KEY)).toThrow();
  });

  it('fits comfortably within the 64-byte Telegram limit for realistic payloads', () => {
    const longPayload = 'a:deadbeef:g:dis:-1001234567890';
    const signed = signCallbackData(longPayload, KEY);
    expect(Buffer.byteLength(signed, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('throws when signed output would exceed 64 bytes', () => {
    const way_too_long = 'x'.repeat(60);
    expect(() => signCallbackData(way_too_long, KEY)).toThrow(/64-byte/);
  });

  it('verifies deterministically (same payload + key -> same signature)', () => {
    const a = signCallbackData('same', KEY);
    const b = signCallbackData('same', KEY);
    expect(a).toBe(b);
  });
});
