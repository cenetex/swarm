import { describe, it, expect } from 'bun:test';
import { redactString, redactData, redactLogData, truncateContent } from './redact-pii.js';

describe('redactString', () => {
  it('should redact email addresses', () => {
    expect(redactString('contact user@example.com for info')).toBe(
      'contact [REDACTED_EMAIL] for info'
    );
  });

  it('should redact multiple emails', () => {
    const input = 'from a@b.com to c@d.org';
    const result = redactString(input);
    expect(result).not.toContain('a@b.com');
    expect(result).not.toContain('c@d.org');
  });

  it('should redact Ethereum addresses', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(redactString(`wallet: ${addr}`)).toBe('wallet: [REDACTED_WALLET]');
  });

  it('should redact Bearer tokens', () => {
    expect(redactString('Authorization: Bearer abc123def456')).toBe(
      'Authorization: [REDACTED_TOKEN]'
    );
  });

  it('should redact Bot tokens', () => {
    expect(redactString('token: Bot abc123def456')).toBe(
      'token: [REDACTED_TOKEN]'
    );
  });

  it('should redact API key patterns', () => {
    expect(redactString('key: sk_live_abcdefghij1234567890')).toBe(
      'key: [REDACTED_KEY]'
    );
  });

  it('should redact IPv4 addresses', () => {
    expect(redactString('from 192.168.1.100')).toBe('from [REDACTED_IP]');
  });

  it('should preserve localhost and link-local IPs', () => {
    expect(redactString('bind 127.0.0.1')).toBe('bind 127.0.0.1');
    expect(redactString('bind 0.0.0.0')).toBe('bind 0.0.0.0');
  });

  it('should leave non-PII strings unchanged', () => {
    const safe = 'avatar kyro responded in 250ms';
    expect(redactString(safe)).toBe(safe);
  });
});

describe('redactData', () => {
  it('should redact sensitive keys regardless of value', () => {
    const data = {
      email: 'alice@example.com',
      phone: '+1-555-0100',
      first_name: 'Alice',
      last_name: 'Smith',
      password: 'hunter2',
    };
    const result = redactData(data) as Record<string, unknown>;
    expect(result.email).toBe('[REDACTED]');
    expect(result.phone).toBe('[REDACTED]');
    expect(result.first_name).toBe('[REDACTED]');
    expect(result.last_name).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
  });

  it('should redact PII in non-sensitive key values', () => {
    const data = {
      message: 'User user@example.com logged in from 10.0.0.1',
    };
    const result = redactData(data) as Record<string, unknown>;
    expect(result.message).not.toContain('user@example.com');
    expect(result.message).not.toContain('10.0.0.1');
  });

  it('should recurse into nested objects', () => {
    const data = {
      user: {
        email: 'nested@example.com',
        profile: { first_name: 'Bob' },
      },
    };
    const result = redactData(data) as Record<string, unknown>;
    const user = result.user as Record<string, unknown>;
    expect(user.email).toBe('[REDACTED]');
    const profile = user.profile as Record<string, unknown>;
    expect(profile.first_name).toBe('[REDACTED]');
  });

  it('should recurse into arrays', () => {
    const data = {
      emails: ['a@b.com', 'c@d.com'],
    };
    const result = redactData(data) as Record<string, unknown>;
    const emails = result.emails as string[];
    expect(emails[0]).toBe('[REDACTED_EMAIL]');
    expect(emails[1]).toBe('[REDACTED_EMAIL]');
  });

  it('preserves public token mint fields while redacting wallet fields', () => {
    const data = {
      mint: 'So11111111111111111111111111111111111111112',
      wallet: '11111111111111111111111111111111',
      message: 'wallet 11111111111111111111111111111111 triggered mint So11111111111111111111111111111111111111112',
    };
    const result = redactData(data) as Record<string, unknown>;
    expect(result.mint).toBe('So11111111111111111111111111111111111111112');
    expect(result.wallet).toBe('[REDACTED_WALLET]');
    expect(result.message).toBe(
      'wallet [REDACTED_WALLET] triggered mint [REDACTED_WALLET]'
    );
  });

  it('should handle null and undefined', () => {
    expect(redactData(null)).toBeNull();
    expect(redactData(undefined)).toBeUndefined();
  });

  it('should handle primitive numbers and booleans', () => {
    expect(redactData(42)).toBe(42);
    expect(redactData(true)).toBe(true);
  });

  it('should not mutate the input', () => {
    const input = { email: 'test@test.com', safe: 'hello' };
    const original = { ...input };
    redactData(input);
    expect(input.email).toBe(original.email);
    expect(input.safe).toBe(original.safe);
  });
});

describe('redactLogData', () => {
  it('should return undefined for undefined input', () => {
    expect(redactLogData(undefined)).toBeUndefined();
  });

  it('should redact a typical log data bag', () => {
    const data = {
      event: 'dm_allowlist_check',
      senderId: '12345',
      senderUsername: 'alice',
      email: 'alice@example.com',
    };
    const result = redactLogData(data)!;
    expect(result.event).toBe('dm_allowlist_check');
    expect(result.senderId).toBe('12345');
    expect(result.email).toBe('[REDACTED]');
  });
});

describe('truncateContent', () => {
  it('should return short strings unchanged', () => {
    expect(truncateContent('hello', 200)).toBe('hello');
  });

  it('should truncate long strings with ellipsis', () => {
    const long = 'a'.repeat(300);
    const result = truncateContent(long, 200);
    expect(result.length).toBe(203); // 200 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('should use default maxLength of 200', () => {
    const long = 'b'.repeat(250);
    const result = truncateContent(long);
    expect(result.length).toBe(203);
  });

  it('should return exact-length strings unchanged', () => {
    const exact = 'c'.repeat(200);
    expect(truncateContent(exact, 200)).toBe(exact);
  });
});
