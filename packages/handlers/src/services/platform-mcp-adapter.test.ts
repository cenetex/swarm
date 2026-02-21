/**
 * Platform MCP Adapter – ADMIN_TABLE validation tests
 *
 * Ensures that the adapter refuses to fall back to a hardcoded production
 * table name when ADMIN_TABLE is not set in the environment.
 *
 * @see https://github.com/cenetex/aws-swarm/issues/233
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAdminTable, _resetAdminTableCache } from './platform-mcp-adapter.js';

describe('getAdminTable', () => {
  let originalAdminTable: string | undefined;

  beforeEach(() => {
    originalAdminTable = process.env.ADMIN_TABLE;
    _resetAdminTableCache();
  });

  afterEach(() => {
    // Restore original value
    if (originalAdminTable !== undefined) {
      process.env.ADMIN_TABLE = originalAdminTable;
    } else {
      delete process.env.ADMIN_TABLE;
    }
    _resetAdminTableCache();
  });

  it('throws when ADMIN_TABLE is not set', () => {
    delete process.env.ADMIN_TABLE;
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('throws when ADMIN_TABLE is empty string', () => {
    process.env.ADMIN_TABLE = '';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('throws when ADMIN_TABLE is whitespace only', () => {
    process.env.ADMIN_TABLE = '   ';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('returns the env value when ADMIN_TABLE is set', () => {
    process.env.ADMIN_TABLE = 'SwarmAdmin-staging';
    expect(getAdminTable()).toBe('SwarmAdmin-staging');
  });

  it('trims surrounding whitespace from ADMIN_TABLE', () => {
    process.env.ADMIN_TABLE = '  SwarmAdmin-staging  ';
    expect(getAdminTable()).toBe('SwarmAdmin-staging');
  });

  it('throws when ADMIN_TABLE contains invalid characters', () => {
    process.env.ADMIN_TABLE = 'Swarm Admin staging';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is invalid',
    );
  });

  it('throws when ADMIN_TABLE is shorter than DynamoDB minimum length', () => {
    process.env.ADMIN_TABLE = 'ab';
    expect(() => getAdminTable()).toThrow(
      'Expected 3-255 characters',
    );
  });

  it('accepts ADMIN_TABLE at DynamoDB maximum length', () => {
    process.env.ADMIN_TABLE = 'a'.repeat(255);
    expect(getAdminTable()).toBe('a'.repeat(255));
  });

  it('throws when ADMIN_TABLE exceeds DynamoDB maximum length', () => {
    process.env.ADMIN_TABLE = 'a'.repeat(256);
    expect(() => getAdminTable()).toThrow(
      'Expected 3-255 characters',
    );
  });

  it('caches the value across calls', () => {
    process.env.ADMIN_TABLE = 'SwarmAdmin-staging';
    const first = getAdminTable();
    // Even if env changes after first read, cached value should persist
    process.env.ADMIN_TABLE = 'SwarmAdmin-other';
    const second = getAdminTable();
    expect(first).toBe(second);
    expect(second).toBe('SwarmAdmin-staging');
  });

  it('does not default to SwarmAdmin-prod', () => {
    delete process.env.ADMIN_TABLE;
    try {
      getAdminTable();
    } catch {
      // expected
    }
    // Ensure no production fallback leaks through
    process.env.ADMIN_TABLE = 'MyTable';
    _resetAdminTableCache();
    expect(getAdminTable()).not.toBe('SwarmAdmin-prod');
  });
});
