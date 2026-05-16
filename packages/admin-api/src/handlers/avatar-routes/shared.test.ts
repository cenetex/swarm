/**
 * Tests for avatar-routes/shared.ts — pure utility functions.
 * No module mocks needed since shared.ts has zero service imports.
 */
import { describe, it, expect } from 'vitest';
import { jsonResponse, parseSinceParam, parseSinceQueryParam, requireOwnerOrAdmin } from './shared.js';
import { makeCtx, CORS_HEADERS } from './test-helpers.js';

describe('jsonResponse', () => {
  it('builds a JSON response with status and headers', () => {
    const result = jsonResponse(CORS_HEADERS, 200, { ok: true });
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ ...CORS_HEADERS, 'Content-Type': 'application/json' });
    expect(JSON.parse(result.body as string)).toEqual({ ok: true });
  });

  it('builds error responses', () => {
    const result = jsonResponse(CORS_HEADERS, 400, { error: 'bad' });
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ error: 'bad' });
  });
});

describe('parseSinceParam', () => {
  it('parses minutes', () => {
    const before = Date.now();
    const result = parseSinceParam('30m');
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(before - 30 * 60 * 1000 - 100);
    expect(result!).toBeLessThanOrEqual(before - 30 * 60 * 1000 + 100);
  });

  it('parses hours', () => {
    const before = Date.now();
    const result = parseSinceParam('2h');
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(before - 2 * 60 * 60 * 1000 - 100);
  });

  it('parses days', () => {
    const before = Date.now();
    const result = parseSinceParam('1d');
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 100);
  });

  it('returns undefined for invalid formats', () => {
    expect(parseSinceParam('abc')).toBeUndefined();
    expect(parseSinceParam('')).toBeUndefined();
    expect(parseSinceParam('0m')).toBeUndefined();
  });
});

describe('parseSinceQueryParam', () => {
  it('returns undefined for missing value', () => {
    expect(parseSinceQueryParam(undefined)).toBeUndefined();
  });

  it('parses relative time strings', () => {
    const result = parseSinceQueryParam('1h');
    expect(result).toBeDefined();
    expect(typeof result).toBe('number');
  });

  it('parses numeric timestamps', () => {
    expect(parseSinceQueryParam('1700000000000')).toBe(1700000000000);
  });

  it('returns undefined for garbage', () => {
    expect(parseSinceQueryParam('not-a-number-or-time')).toBeUndefined();
  });
});

describe('requireOwnerOrAdmin', () => {
  it('returns null (allows) for admin', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: true });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => null);
    expect(result).toBeNull();
  });

  it('returns 403 when no wallet', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: false, walletAddress: null });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => null);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
  });

  it('returns 404 when avatar not found', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: false, walletAddress: 'wallet-1' });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => null);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns 404 when wallet does not match', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: false, walletAddress: 'wallet-other' });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => ({
      creatorWallet: 'wallet-1',
    }));
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns null (allows) for creator wallet', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: false, walletAddress: 'wallet-1' });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => ({
      creatorWallet: 'wallet-1',
    }));
    expect(result).toBeNull();
  });

  it('returns 404 when wallet is not creator', async () => {
    const ctx = makeCtx({ effectiveIsAdmin: false, walletAddress: 'wallet-2' });
    const result = await requireOwnerOrAdmin(ctx, 'avatar-1', async () => ({
      creatorWallet: 'wallet-1',
    }));
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('uses centralized ownership authorizer when provided', async () => {
    let legacyGetAvatarCalled = false;
    let authorizerArgs: unknown[] | null = null;
    const ctx = makeCtx({
      effectiveIsAdmin: false,
      walletAddress: 'current-nft-owner',
      assertAvatarOwnership: async (...args) => {
        authorizerArgs = args;
      },
    });

    const result = await requireOwnerOrAdmin(ctx, 'nft-avatar', async () => {
      legacyGetAvatarCalled = true;
      return { creatorWallet: 'stale-creator' };
    });

    expect(result).toBeNull();
    expect(legacyGetAvatarCalled).toBe(false);
    expect(authorizerArgs).toEqual(['nft-avatar', 'current-nft-owner', { isAdmin: false }]);
  });

  it('maps centralized ownership revocation to 404', async () => {
    const ctx = makeCtx({
      effectiveIsAdmin: false,
      walletAddress: 'stale-creator',
      assertAvatarOwnership: async () => {
        const error = new Error('revoked') as Error & { code: string };
        error.code = 'nft_revoked';
        throw error;
      },
    });

    const result = await requireOwnerOrAdmin(ctx, 'nft-avatar', async () => ({
      creatorWallet: 'stale-creator',
    }));

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('maps centralized ownership outages to 503', async () => {
    const ctx = makeCtx({
      effectiveIsAdmin: false,
      walletAddress: 'owner',
      assertAvatarOwnership: async () => {
        const error = new Error('helius down') as Error & { code: string };
        error.code = 'verification_unavailable';
        throw error;
      },
    });

    const result = await requireOwnerOrAdmin(ctx, 'nft-avatar', async () => ({
      creatorWallet: 'owner',
    }));

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(503);
    expect(JSON.parse(result!.body as string)).toEqual({
      error: 'Ownership verification temporarily unavailable',
      code: 'verification_unavailable',
    });
  });
});
