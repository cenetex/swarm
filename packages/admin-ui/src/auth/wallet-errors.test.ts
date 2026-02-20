import { describe, it, expect } from 'vitest';
import {
  isNetworkFetchError,
  humanizeApiUnreachable,
  isPhantomExtensionContextInvalidatedError,
  isUserRejectedSignatureError,
  humanizeWalletSignatureError,
} from './wallet-errors.js';

// ---------------------------------------------------------------------------
// isNetworkFetchError
// ---------------------------------------------------------------------------

describe('isNetworkFetchError', () => {
  it('returns true for "Failed to fetch"', () => {
    expect(isNetworkFetchError(new Error('Failed to fetch'))).toBe(true);
  });

  it('returns true for "NetworkError" case-insensitive', () => {
    expect(isNetworkFetchError(new Error('NetworkError when attempting to fetch resource'))).toBe(true);
  });

  it('returns true for "Load failed"', () => {
    expect(isNetworkFetchError(new Error('Load failed'))).toBe(true);
  });

  it('returns false for a random error', () => {
    expect(isNetworkFetchError(new Error('some other error'))).toBe(false);
  });

  it('handles non-Error objects', () => {
    expect(isNetworkFetchError('Failed to fetch')).toBe(true);
    expect(isNetworkFetchError({ message: 'nope' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// humanizeApiUnreachable
// ---------------------------------------------------------------------------

describe('humanizeApiUnreachable', () => {
  it('returns a human-readable message for network errors', () => {
    const result = humanizeApiUnreachable(new Error('Failed to fetch'));
    expect(result).not.toBeNull();
    expect(result).toContain("Couldn't reach the API");
  });

  it('returns null for non-network errors', () => {
    expect(humanizeApiUnreachable(new Error('some other error'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPhantomExtensionContextInvalidatedError
// ---------------------------------------------------------------------------

describe('isPhantomExtensionContextInvalidatedError', () => {
  it('detects "Extension context invalidated"', () => {
    expect(isPhantomExtensionContextInvalidatedError(new Error('Extension context invalidated'))).toBe(true);
  });

  it('detects "Failed to send message to service worker"', () => {
    expect(
      isPhantomExtensionContextInvalidatedError(new Error('Failed to send message to service worker'))
    ).toBe(true);
  });

  it('detects Phantom service worker patterns', () => {
    expect(
      isPhantomExtensionContextInvalidatedError(new Error('[Phantom] Could not reach service worker'))
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isPhantomExtensionContextInvalidatedError(new Error('something else'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUserRejectedSignatureError
// ---------------------------------------------------------------------------

describe('isUserRejectedSignatureError', () => {
  it('detects "User rejected the request"', () => {
    expect(isUserRejectedSignatureError(new Error('User rejected the request'))).toBe(true);
  });

  it('detects "rejected" (case-insensitive)', () => {
    expect(isUserRejectedSignatureError(new Error('Transaction was Rejected by user'))).toBe(true);
  });

  it('detects "declined"', () => {
    expect(isUserRejectedSignatureError(new Error('Request declined'))).toBe(true);
  });

  it('detects "cancelled" (British spelling)', () => {
    expect(isUserRejectedSignatureError(new Error('User cancelled'))).toBe(true);
  });

  it('detects "canceled" (American spelling)', () => {
    expect(isUserRejectedSignatureError(new Error('Request canceled'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUserRejectedSignatureError(new Error('something else'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// humanizeWalletSignatureError
// ---------------------------------------------------------------------------

describe('humanizeWalletSignatureError', () => {
  it('returns extension context invalidation message', () => {
    const result = humanizeWalletSignatureError(new Error('Extension context invalidated'));
    expect(result).toContain('Phantom looks like it restarted');
    expect(result).toContain('Extension context invalidated');
  });

  it('returns user-rejected message', () => {
    const result = humanizeWalletSignatureError(new Error('User rejected the request'));
    expect(result).toContain('Signature was cancelled in Phantom');
  });

  it('returns Phantom unexpected error message for Wallet-named errors', () => {
    const error = new Error('Unexpected error');
    (error as any).name = 'WalletSignTransactionError';
    const result = humanizeWalletSignatureError(error);
    expect(result).toContain('Phantom returned an unexpected error');
  });

  it('returns raw message for other errors', () => {
    const result = humanizeWalletSignatureError(new Error('Something weird happened'));
    expect(result).toBe('Something weird happened');
  });

  it('returns fallback for empty message', () => {
    const result = humanizeWalletSignatureError(new Error(''));
    expect(result).toBe('Wallet signature failed');
  });

  it('does not silently swallow errors (always returns a string)', () => {
    const cases = [
      new Error('Failed to fetch'),
      new Error(''),
      null,
      undefined,
      42,
      { message: 'custom' },
    ];

    for (const error of cases) {
      const result = humanizeWalletSignatureError(error);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
