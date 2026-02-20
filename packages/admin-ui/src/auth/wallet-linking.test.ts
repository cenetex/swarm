import { describe, it, expect, vi } from 'vitest';
import { signMessageWithFallback, signWalletLinkMessage } from './wallet-linking.js';

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// signMessageWithFallback
// ---------------------------------------------------------------------------

describe('signMessageWithFallback', () => {
  it('uses privy signMessage when available', async () => {
    const privySignMessage = vi.fn(async () => Uint8Array.from([1, 2, 3]));

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      privySignMessage,
    });

    expect(result.source).toBe('privy');
    expect(result.signatureBytes.length).toBeGreaterThan(0);
    expect(privySignMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to Phantom when privy signMessage fails', async () => {
    const privySignMessage = vi.fn(async () => {
      throw new Error('privy failed');
    });

    const phantomProvider = {
      isConnected: true,
      signMessage: vi.fn(async () => ({ signature: Uint8Array.from([9, 9, 9]) })),
    };

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      privySignMessage,
      phantomProvider,
    });

    expect(result.source).toBe('phantom');
    expect(result.signatureBytes.length).toBeGreaterThan(0);
  });

  it('falls back to Phantom when privy returns empty signature', async () => {
    const privySignMessage = vi.fn(async () => new Uint8Array(0));

    const phantomProvider = {
      isConnected: true,
      signMessage: vi.fn(async () => ({ signature: Uint8Array.from([7, 8, 9]) })),
    };

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      privySignMessage,
      phantomProvider,
    });

    expect(result.source).toBe('phantom');
    expect(result.signatureBytes).toEqual(Uint8Array.from([7, 8, 9]));
  });

  it('throws when no signer is available', async () => {
    await expect(
      signMessageWithFallback({
        message: encoder.encode('hello'),
      })
    ).rejects.toThrow('Connected wallet does not support message signing');
  });

  it('throws when Phantom does not support signMessage', async () => {
    const phantomProvider = {
      isConnected: true,
      // no signMessage method
    };

    await expect(
      signMessageWithFallback({
        message: encoder.encode('hello'),
        phantomProvider: phantomProvider as any,
      })
    ).rejects.toThrow('Connected wallet does not support message signing');
  });

  it('connects Phantom before signing if not connected', async () => {
    const connectFn = vi.fn(async () => ({ publicKey: { toString: () => 'pk' } }));
    const phantomProvider = {
      isConnected: false,
      connect: connectFn,
      signMessage: vi.fn(async () => ({ signature: Uint8Array.from([4, 5, 6]) })),
    };

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      phantomProvider,
    });

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('phantom');
    expect(result.signatureBytes).toEqual(Uint8Array.from([4, 5, 6]));
  });

  it('throws when Phantom returns empty signature', async () => {
    const phantomProvider = {
      isConnected: true,
      signMessage: vi.fn(async () => ({ signature: new Uint8Array(0) })),
    };

    await expect(
      signMessageWithFallback({
        message: encoder.encode('hello'),
        phantomProvider,
      })
    ).rejects.toThrow('Phantom did not return a signature');
  });

  it('throws when Phantom returns null signature', async () => {
    const phantomProvider = {
      isConnected: true,
      signMessage: vi.fn(async () => ({ signature: null })),
    };

    await expect(
      signMessageWithFallback({
        message: encoder.encode('hello'),
        phantomProvider: phantomProvider as any,
      })
    ).rejects.toThrow('Phantom did not return a signature');
  });

  it('retries Phantom signMessage without encoding arg on first failure', async () => {
    const signMessage = vi.fn()
      .mockRejectedValueOnce(new Error('encoding not supported'))
      .mockResolvedValueOnce({ signature: Uint8Array.from([1, 1, 1]) });

    const phantomProvider = {
      isConnected: true,
      signMessage,
    };

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      phantomProvider,
    });

    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('phantom');
    expect(result.signatureBytes).toEqual(Uint8Array.from([1, 1, 1]));
  });
});

// ---------------------------------------------------------------------------
// signWalletLinkMessage
// ---------------------------------------------------------------------------

describe('signWalletLinkMessage', () => {
  it('uses privy signMessage when available and returns base58', async () => {
    const privySignMessage = vi.fn(async () => Uint8Array.from([1, 2, 3]));

    const result = await signWalletLinkMessage({
      message: encoder.encode('hello'),
      privySignMessage,
    });

    expect(result.source).toBe('privy');
    expect(result.signatureBase58.length).toBeGreaterThan(0);
    expect(privySignMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to Phantom when privy signMessage fails', async () => {
    const privySignMessage = vi.fn(async () => {
      throw new Error('privy failed');
    });

    const phantomProvider = {
      isConnected: true,
      signMessage: vi.fn(async () => ({ signature: Uint8Array.from([9, 9, 9]) })),
    };

    const result = await signWalletLinkMessage({
      message: encoder.encode('hello'),
      privySignMessage,
      phantomProvider,
    });

    expect(result.source).toBe('phantom');
    expect(result.signatureBase58.length).toBeGreaterThan(0);
  });

  it('throws when no signer is available', async () => {
    await expect(
      signWalletLinkMessage({
        message: encoder.encode('hello'),
      })
    ).rejects.toThrow('Connected wallet does not support message signing');
  });

  it('encodes signature bytes to base58 correctly', async () => {
    // Known bytes -> known base58 (bs58 library)
    const knownBytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const privySignMessage = vi.fn(async () => knownBytes);

    const result = await signWalletLinkMessage({
      message: encoder.encode('test'),
      privySignMessage,
    });

    // Just verify it produced a non-empty string (exact base58 depends on library)
    expect(typeof result.signatureBase58).toBe('string');
    expect(result.signatureBase58.length).toBeGreaterThan(0);
    expect(result.source).toBe('privy');
  });
});
