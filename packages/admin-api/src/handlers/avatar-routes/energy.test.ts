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
  // Transitive exports needed when handlers import services that depend on @swarm/core
  createSqsOffloadServiceFromEnv: () => null,
  createGallerySaver: () => ({ save: () => Promise.resolve() }),
  LLMError: class LLMError extends Error { code: string; constructor(msg: string, opts?: any) { super(msg); this.code = opts?.code ?? ''; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_ADAPTER_NOT_FOUND: 'PLATFORM_ADAPTER_NOT_FOUND',
    PLATFORM_CONFIG_INVALID: 'PLATFORM_CONFIG_INVALID',
    PLATFORM_AUTH_FAILED: 'PLATFORM_AUTH_FAILED',
    PLATFORM_CONNECTION_FAILED: 'PLATFORM_CONNECTION_FAILED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_INVALID: 'PLATFORM_WEBHOOK_INVALID',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_INVALID_SCHEMA: 'LLM_INVALID_SCHEMA',
    CONFIG_MISSING_REQUIRED_FIELD: 'CONFIG_MISSING_REQUIRED_FIELD',
    CONFIG_INVALID_ENUM_VALUE: 'CONFIG_INVALID_ENUM_VALUE',
    CONFIG_NESTED_OBJECT_INVALID: 'CONFIG_NESTED_OBJECT_INVALID',
    STATE_SERIALIZATION_FAILED: 'STATE_SERIALIZATION_FAILED',
    STATE_DESERIALIZATION_FAILED: 'STATE_DESERIALIZATION_FAILED',
    MEDIA_PROVIDER_ERROR: 'MEDIA_PROVIDER_ERROR',
    MEDIA_UPLOAD_FAILED: 'MEDIA_UPLOAD_FAILED',
    MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_EXPIRED_TOKEN: 'AUTH_EXPIRED_TOKEN',
    AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_INSUFFICIENT_PERMISSIONS',
    QUEUE_SEND_FAILED: 'QUEUE_SEND_FAILED',
    QUEUE_RECEIVE_FAILED: 'QUEUE_RECEIVE_FAILED',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
    NETWORK_CONNECTION_ERROR: 'NETWORK_CONNECTION_ERROR',
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
