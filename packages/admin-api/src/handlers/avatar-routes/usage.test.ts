/**
 * Tests for avatar-routes/usage.ts
 *
 * Routes:
 *   GET /avatars/{id}/usage          — today's usage vs limits
 *   GET /avatars/{id}/usage/history  — historical daily usage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let getUsageResult: unknown = null;
let getEntitlementResult: unknown = null;
let toolCreditsResult: unknown = {};
let energyStatusResult: unknown = null;
let energyBankResult: unknown = { credits: 0 };
let usageHistoryResult: unknown = [];

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/billing/entitlements.js', () => ({
  getUsage: async () => getUsageResult,
  getEntitlement: async () => getEntitlementResult,
}));

vi.mock('../../services/billing/credits.js', () => ({
  getToolStatusStructured: async () => toolCreditsResult,
}));

vi.mock('../../services/billing/energy.js', () => ({
  getEnergyStatus: async () => energyStatusResult,
  getEnergyBankBalance: async () => energyBankResult,
}));

vi.mock('../../services/usage-history.js', () => ({
  getUsageHistory: async () => usageHistoryResult,
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleUsageRoutes } from './usage.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  getUsageResult = null;
  getEntitlementResult = null;
  toolCreditsResult = {};
  energyStatusResult = null;
  energyBankResult = { credits: 0 };
  usageHistoryResult = [];
});

// =========================================================================
// GET /avatars/{id}/usage
// =========================================================================
describe('GET /avatars/{id}/usage', () => {
  it('returns usage data for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getUsageResult = {
      avatarId: 'avatar-1',
      date: '2026-02-20',
      messagesProcessed: 5,
      mediaCreditsUsed: 2,
      voiceMinutesUsed: 0,
    };
    getEntitlementResult = null;

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage',
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as {
      avatarId: string;
      date: string;
      plan: string;
      meters: { messages: { used: number } };
    };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.date).toBe('2026-02-20');
    expect(body.plan).toBe('free');
    expect(body.meters.messages.used).toBe(5);
    expect(body.meters.media.used).toBe(2);
  });

  it('returns default date when no usage record exists', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getUsageResult = null;
    getEntitlementResult = null;

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage',
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { date: string; meters: { messages: { used: number } } };
    // Should have today's date
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // All meters should be zero
    expect(body.meters.messages.used).toBe(0);
    expect(body.meters.media.used).toBe(0);
    expect(body.meters.voice.used).toBe(0);
  });

  it('returns 404 for non-owner non-admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });

  it('includes energy data when available', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getUsageResult = null;
    getEntitlementResult = null;
    energyStatusResult = { current: 8.5, max: 10, refillPerHour: 1 };
    energyBankResult = { credits: 3 };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage',
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { energy: { current: number; max: number; bankCredits: number } | null };
    expect(body.energy).not.toBeNull();
    expect(body.energy!.current).toBe(8.5);
    expect(body.energy!.bankCredits).toBe(3);
  });
});

// =========================================================================
// GET /avatars/{id}/usage/history
// =========================================================================
describe('GET /avatars/{id}/usage/history', () => {
  it('returns history for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    usageHistoryResult = [
      { date: '2026-02-19', messagesProcessed: 10, mediaCreditsUsed: 1, voiceMinutesUsed: 0 },
      { date: '2026-02-20', messagesProcessed: 5, mediaCreditsUsed: 0, voiceMinutesUsed: 0 },
    ];

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage/history',
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatarId: string; days: number; history: unknown[] };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.days).toBe(7);
    expect(body.history).toHaveLength(2);
  });

  it('respects days query parameter', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    usageHistoryResult = [];

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage/history',
      queryStringParameters: { days: '14' },
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { days: number };
    expect(body.days).toBe(14);
  });

  it('clamps days to max 30', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    usageHistoryResult = [];

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage/history',
      queryStringParameters: { days: '100' },
      effectiveIsAdmin: true,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { days: number };
    expect(body.days).toBe(30);
  });

  it('returns 404 for non-owner non-admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/usage/history',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleUsageRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// Unmatched routes
// =========================================================================
describe('unmatched routes', () => {
  it('returns null for non-usage paths', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/something-else' });
    const result = await handleUsageRoutes(ctx);
    expect(result).toBeNull();
  });

  it('returns null for POST to usage endpoint', async () => {
    const ctx = makeCtx({ method: 'POST', path: '/avatars/avatar-1/usage' });
    const result = await handleUsageRoutes(ctx);
    expect(result).toBeNull();
  });
});
