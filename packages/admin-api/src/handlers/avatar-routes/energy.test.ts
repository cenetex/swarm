/**
 * Tests for avatar-routes/energy.ts
 *
 * Routes:
 *   GET  /avatars/{id}/energy
 *   POST /avatars/{id}/energy/burn
 *   POST /avatars/{id}/energy/set
 *   POST /avatars/{id}/energy/add
 *   GET  /avatars/{id}/energy/history
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let energyStatus = { current: 80, max: 100, refillPerHour: 10, nextRefillIn: 0 };
let bankBalance = { credits: 50 };
let burnResult: unknown = { success: true, creditsAdded: 10, mint: 'MINT', signature: 'sig' };
let setEnergyResult = { success: true, newValue: 50 };
let addEnergyResult = { success: true, newValue: 90 };
let energyHistory: unknown[] = [];

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/billing/energy.js', () => ({
  getEnergyStatus: async () => energyStatus,
  getEnergyBankBalance: async () => bankBalance,
  getEnergyHistory: async () => energyHistory,
  setEnergy: async () => setEnergyResult,
  addEnergy: async () => addEnergyResult,
  ENERGY_COSTS: { message: 1, image: 5 },
}));

vi.mock('../../services/billing/energy-burn.js', () => ({
  burnDepositedTokensForEnergy: async () => burnResult,
}));

vi.mock('./runtime-sync.js', () => ({
  syncRuntimeContractForAvatar: async () => {},
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  createSqsOffloadServiceFromEnv: () => null,
  createCircuitBreaker: () => ({ canExecute: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed' }),
  LLMError: class LLMError extends Error { constructor(message: string) { super(message); this.name = 'LLMError'; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_NOT_INITIALIZED: 'PLATFORM_NOT_INITIALIZED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_ERROR: 'PLATFORM_WEBHOOK_ERROR',
    PLATFORM_MEDIA_UPLOAD_ERROR: 'PLATFORM_MEDIA_UPLOAD_ERROR',
    PLATFORM_UNSUPPORTED_MEDIA: 'PLATFORM_UNSUPPORTED_MEDIA',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_VALIDATION_ERROR: 'CONFIG_VALIDATION_ERROR',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    STATE_READ_ERROR: 'STATE_READ_ERROR',
    STATE_WRITE_ERROR: 'STATE_WRITE_ERROR',
    MEDIA_GENERATION_ERROR: 'MEDIA_GENERATION_ERROR',
    MEDIA_FETCH_ERROR: 'MEDIA_FETCH_ERROR',
    MEDIA_LIMIT_REACHED: 'MEDIA_LIMIT_REACHED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
    AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
    QUEUE_SEND_ERROR: 'QUEUE_SEND_ERROR',
    QUEUE_PARSE_ERROR: 'QUEUE_PARSE_ERROR',
    NETWORK_FETCH_ERROR: 'NETWORK_FETCH_ERROR',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  },
}));

import { handleEnergyRoutes } from './energy.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  energyStatus = { current: 80, max: 100, refillPerHour: 10, nextRefillIn: 0 };
  bankBalance = { credits: 50 };
  burnResult = { success: true, creditsAdded: 10, mint: 'MINT', signature: 'sig' };
  setEnergyResult = { success: true, newValue: 50 };
  addEnergyResult = { success: true, newValue: 90 };
  energyHistory = [];
});

describe('GET /avatars/{id}/energy', () => {
  it('returns energy status for admin', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/energy', effectiveIsAdmin: true });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as Record<string, unknown>;
    expect(body.avatarId).toBe('avatar-1');
    expect(body.current).toBe(80);
    expect(body.bankCredits).toBe(50);
  });
});

describe('POST /avatars/{id}/energy/burn', () => {
  it('burns tokens for energy', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/burn',
      body: JSON.stringify({ mint: 'MINT' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('returns 400 on burn failure', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    burnResult = { success: false, error: 'No tokens' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/burn',
      body: JSON.stringify({}),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });
});

describe('POST /avatars/{id}/energy/set', () => {
  it('admin sets energy', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: 50 }),
      effectiveIsAdmin: true,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: 50 }),
      effectiveIsAdmin: false,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('rejects negative value', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: -10 }),
      effectiveIsAdmin: true,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });
});

describe('POST /avatars/{id}/energy/add', () => {
  it('admin adds energy', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/energy/add',
      body: JSON.stringify({ amount: 10 }),
      effectiveIsAdmin: true,
    });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });
});

describe('GET /avatars/{id}/energy/history', () => {
  it('returns history for admin', async () => {
    energyHistory = [
      { operation: 'burn', cost: 5, energyBefore: 100, energyAfter: 95, refillRate: 10, timestamp: Date.now() },
    ];
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/energy/history', effectiveIsAdmin: true });
    const result = await handleEnergyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { events: unknown[]; count: number };
    expect(body.events).toHaveLength(1);
    expect(body.count).toBe(1);
  });
});

describe('unmatched routes', () => {
  it('returns null', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/unknown' });
    expect(await handleEnergyRoutes(ctx)).toBeNull();
  });
});
