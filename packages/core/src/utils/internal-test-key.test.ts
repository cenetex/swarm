import { describe, expect, it } from 'bun:test';
import {
  getHeaderValue,
  hasValidInternalTestKey,
  isProductionEnvironment,
} from './internal-test-key.js';

describe('internal test key utils', () => {
  it('detects production environments', () => {
    expect(isProductionEnvironment('prod')).toBe(true);
    expect(isProductionEnvironment('production')).toBe(true);
    expect(isProductionEnvironment(undefined, 'production')).toBe(true);
    expect(isProductionEnvironment('staging')).toBe(false);
  });

  it('reads headers case-insensitively', () => {
    const headers = { 'X-Internal-Test-Key': 'abc' };
    expect(getHeaderValue(headers, 'x-internal-test-key')).toBe('abc');
  });

  it('validates internal test key only for non-production', () => {
    expect(hasValidInternalTestKey({
      headers: { 'x-internal-test-key': 'abc' },
      internalTestKey: 'abc',
      environment: 'staging',
    })).toBe(true);

    expect(hasValidInternalTestKey({
      headers: { 'x-internal-test-key': 'abc' },
      internalTestKey: 'abc',
      environment: 'production',
    })).toBe(false);
  });
});
