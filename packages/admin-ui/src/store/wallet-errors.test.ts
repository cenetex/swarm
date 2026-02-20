import { describe, it, expect } from 'vitest';
import { humanizeWalletAdapterError } from './wallet-errors.js';

describe('humanizeWalletAdapterError', () => {
  it('returns user-friendly message for WalletConnectionError with unexpected error', () => {
    const error = new Error('Unexpected error');
    (error as any).name = 'WalletConnectionError';
    const result = humanizeWalletAdapterError(error);
    expect(result).toContain('Wallet connection failed');
    expect(result).toContain('Unexpected error');
  });

  it('returns cancelled message for user-rejected errors', () => {
    const result = humanizeWalletAdapterError(new Error('User rejected the request'));
    expect(result).toBe('Wallet request was cancelled.');
  });

  it('returns cancelled message for "rejected" (case-insensitive)', () => {
    const result = humanizeWalletAdapterError(new Error('Transaction Rejected'));
    expect(result).toBe('Wallet request was cancelled.');
  });

  it('returns fallback for empty message', () => {
    const result = humanizeWalletAdapterError(new Error(''));
    expect(result).toBe('Wallet operation failed.');
  });

  it('returns fallback for [object Object] message', () => {
    const result = humanizeWalletAdapterError({ message: '[object Object]' });
    expect(result).toBe('Wallet operation failed.');
  });

  it('returns raw message for unrecognized errors', () => {
    const result = humanizeWalletAdapterError(new Error('Something went wrong'));
    expect(result).toBe('Something went wrong');
  });

  it('handles non-Error objects gracefully', () => {
    expect(typeof humanizeWalletAdapterError(42)).toBe('string');
    expect(typeof humanizeWalletAdapterError(null)).toBe('string');
    expect(typeof humanizeWalletAdapterError(undefined)).toBe('string');
    expect(typeof humanizeWalletAdapterError('string error')).toBe('string');
  });

  it('does not silently fail - always returns a non-empty string', () => {
    const cases = [
      new Error('test'),
      new Error(''),
      null,
      undefined,
      42,
      'string error',
      { message: '[object Object]' },
    ];

    for (const error of cases) {
      const result = humanizeWalletAdapterError(error);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
