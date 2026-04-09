/**
 * Tests for avatar-routes/crud.ts
 *
 * Routes:
 *   POST   /avatars
 *   GET    /avatars
 *   GET    /avatars/{id}
 *   PUT    /avatars/{id}
 *   DELETE /avatars/{id}
 *   PUT    /avatars/{id}/reassign
 *   GET    /avatars/{id}/integrations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let listAvatarsResult: unknown[] = [];
let listAvatarsByWalletResult: unknown[] = [];
let createAvatarResult: unknown = {};
let createAvatarWithWalletResult: unknown = { success: true, avatar: {} };
let updateAvatarResult: unknown = {};
const deleteAvatarCalls: unknown[][] = [];
let reassignAvatarResult: unknown = {};
let integrationStatusesResult: unknown = [];
let galleryProfileResult: unknown = null;
let recordAuditEventCalls: unknown[] = [];
let onboardingRoutingDecision: unknown = {
  onboardingVersion: 'v1',
  reason: 'disabled',
  cohortBucket: 0,
  assignmentKeyHash: 'testhash',
  assignmentKeySource: 'anonymous',
  matchedAvatarAllowlist: false,
  flags: {
    enabled: false,
    rolloutPercent: 0,
    avatarAllowlist: [],
    forceLegacy: false,
    source: 'env',
    readAt: 0,
  },
};

vi.mock('../../services/avatars.js', () => ({
  createAvatar: async (..._args: unknown[]) => createAvatarResult,
  createAvatarWithWallet: async (..._args: unknown[]) => createAvatarWithWalletResult,
  createAvatarWithWalletLegacy: async (..._args: unknown[]) => createAvatarWithWalletResult,
  createAvatarWithWalletV2: async (..._args: unknown[]) => createAvatarWithWalletResult,
  listAvatars: async () => listAvatarsResult,
  listAvatarsByWallet: async () => listAvatarsByWalletResult,
  getAvatar: async () => getAvatarResult,
  updateAvatar: async (..._args: unknown[]) => updateAvatarResult,
  deleteAvatar: async (..._args: unknown[]) => { deleteAvatarCalls.push(_args); },
  reassignAvatar: async (..._args: unknown[]) => reassignAvatarResult,
}));

vi.mock('../../services/gallery.js', () => ({
  getLatestProfileImageFromGallery: async () => galleryProfileResult,
}));

vi.mock('../../services/integrations.js', () => ({
  getAllIntegrationStatuses: async () => integrationStatusesResult,
}));

vi.mock('../../services/onboarding-rollout.js', () => ({
  resolveOnboardingRoutingDecision: async () => onboardingRoutingDecision,
}));

vi.mock('../../services/audit-log.js', () => ({
  recordAuditEvent: async (params: unknown) => {
    recordAuditEventCalls.push(params);
    return { id: 'audit-mock', ...params as Record<string, unknown>, timestamp: Date.now() };
  },
}));

vi.mock('@swarm/core', () => ({
  ...RealSwarmCore,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import handler AFTER mocks ─────────────────────────────────────────────
import { handleCrudRoutes } from './crud.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

// Bypass mocks below to access real @swarm/core for spreading into the factory.
import * as RealSwarmCore from '../../../../core/src/index.js';

beforeEach(() => {
  getAvatarResult = null;
  listAvatarsResult = [];
  listAvatarsByWalletResult = [];
  createAvatarResult = {};
  createAvatarWithWalletResult = { success: true, avatar: { avatarId: 'new-1', name: 'New' } };
  updateAvatarResult = {};
  deleteAvatarCalls.length = 0;
  reassignAvatarResult = {};
  integrationStatusesResult = [];
  galleryProfileResult = null;
  recordAuditEventCalls = [];
  onboardingRoutingDecision = {
    onboardingVersion: 'v1',
    reason: 'disabled',
    cohortBucket: 0,
    assignmentKeyHash: 'testhash',
    assignmentKeySource: 'anonymous',
    matchedAvatarAllowlist: false,
    flags: {
      enabled: false,
      rolloutPercent: 0,
      avatarAllowlist: [],
      forceLegacy: false,
      source: 'env',
      readAt: 0,
    },
  };
});

// =========================================================================
// POST /avatars
// =========================================================================
describe('POST /avatars', () => {
  it('creates with wallet', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'My Avatar' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(201);
  });

  it('rejects wallet creation when no slots', async () => {
    createAvatarWithWalletResult = { success: false, error: 'no_gate_slot', gateStatus: {} };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'My Avatar' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
  });

  it('returns 400 when name missing', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({}),
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(400);
  });

  it('admin creates via email session', async () => {
    createAvatarResult = { avatarId: 'new-1', name: 'Admin Avatar' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Admin Avatar' }),
      walletAddress: null,
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(201);
  });

  it('non-admin without wallet gets 403', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Test' }),
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// GET /avatars
// =========================================================================
describe('GET /avatars', () => {
  it('admin lists all avatars', async () => {
    listAvatarsResult = [{ ...MOCK_AVATAR }];
    const ctx = makeCtx({ method: 'GET', path: '/avatars', effectiveIsAdmin: true });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = JSON.parse(result!.body as string);
    expect(body).toHaveLength(1);
  });

  it('wallet user lists own avatars', async () => {
    listAvatarsByWalletResult = [{ ...MOCK_AVATAR }];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
  });

  it('admin wallet lists all avatars', async () => {
    listAvatarsResult = [{ ...MOCK_AVATAR }];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars',
      walletAddress: 'admin-wallet',
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin without wallet gets 403', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars',
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// GET /avatars/{id}
// =========================================================================
describe('GET /avatars/{id}', () => {
  it('returns avatar for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1', effectiveIsAdmin: true });
    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
  });

  it('returns 404 when not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({ method: 'GET', path: '/avatars/missing', effectiveIsAdmin: true });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });

  it('owner wallet can read own avatar', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-owner wallet gets 404', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });

  it('hydrates profile image from gallery when missing', async () => {
    getAvatarResult = { ...MOCK_AVATAR, profileImage: undefined };
    galleryProfileResult = { url: 'https://cdn/img.jpg', s3Key: 's3/img.jpg', createdAt: 1000 };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1', effectiveIsAdmin: true });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = JSON.parse(result!.body as string);
    expect(body.profileImage.url).toBe('https://cdn/img.jpg');
  });
});

// =========================================================================
// PUT /avatars/{id}
// =========================================================================
describe('PUT /avatars/{id}', () => {
  it('admin updates avatar', async () => {
    updateAvatarResult = { ...MOCK_AVATAR, name: 'Updated' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Updated' }),
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin without wallet gets 403', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Updated' }),
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// DELETE /avatars/{id}
// =========================================================================
describe('DELETE /avatars/{id}', () => {
  it('admin deletes avatar', async () => {
    const ctx = makeCtx({ method: 'DELETE', path: '/avatars/avatar-1', effectiveIsAdmin: true });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(204);
    expect(deleteAvatarCalls).toHaveLength(1);
  });

  it('creator wallet deletes own avatar', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(204);
  });
});

// =========================================================================
// PUT /avatars/{id}/reassign
// =========================================================================
describe('PUT /avatars/{id}/reassign', () => {
  it('admin can reassign', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    reassignAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-new' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({ creatorWallet: 'wallet-new' }),
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({}),
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// GET /avatars/{id}/integrations
// =========================================================================
describe('GET /avatars/{id}/integrations', () => {
  it('admin gets integration statuses', async () => {
    integrationStatusesResult = [{ name: 'telegram', connected: true }];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/integrations',
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { integrations: unknown[] };
    expect(body.integrations).toHaveLength(1);
  });
});

// =========================================================================
// Audit logging on avatar create (wallet)
// =========================================================================
describe('audit logging on avatar create (wallet)', () => {
  it('records avatar_created audit event on wallet creation', async () => {
    createAvatarWithWalletResult = { success: true, avatar: { avatarId: 'new-1', name: 'My Avatar' } };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'My Avatar' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(201);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('new-1');
    expect(call.eventType).toBe('avatar_created');
    expect(call.actorId).toBe('wallet-1');
    expect(call.actorType).toBe('owner');
    const details = call.details as Record<string, unknown>;
    expect(details.name).toBe('My Avatar');
    expect(details.creationMethod).toBe('wallet');
  });

  it('does not record audit event when wallet creation fails', async () => {
    createAvatarWithWalletResult = { success: false, error: 'no_gate_slot', gateStatus: {} };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'My Avatar' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(403);
    expect(recordAuditEventCalls.length).toBe(0);
  });
});

// =========================================================================
// Audit logging on avatar create (admin email)
// =========================================================================
describe('audit logging on avatar create (admin email)', () => {
  it('records avatar_created audit event on admin creation', async () => {
    createAvatarResult = { avatarId: 'admin-new-1', name: 'Admin Avatar' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Admin Avatar' }),
      walletAddress: null,
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(201);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('admin-new-1');
    expect(call.eventType).toBe('avatar_created');
    expect(call.actorType).toBe('admin');
    const details = call.details as Record<string, unknown>;
    expect(details.creationMethod).toBe('email');
  });
});

// =========================================================================
// Audit logging on avatar update
// =========================================================================
describe('audit logging on avatar update', () => {
  it('records avatar_updated audit event', async () => {
    updateAvatarResult = { ...MOCK_AVATAR, name: 'Updated' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Updated', description: 'New desc' }),
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('avatar_updated');
    expect(call.actorType).toBe('admin');
    const details = call.details as Record<string, unknown>;
    expect(details.updatedFields).toEqual(['name', 'description']);
  });
});

// =========================================================================
// Audit logging on avatar delete
// =========================================================================
describe('audit logging on avatar delete', () => {
  it('records avatar_deleted audit event', async () => {
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1',
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(204);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('avatar_deleted');
    expect(call.actorType).toBe('admin');
  });
});

// =========================================================================
// Audit logging on avatar reassign
// =========================================================================
describe('audit logging on avatar reassign', () => {
  it('records avatar_reassigned audit event', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-old' };
    reassignAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-new' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({ creatorWallet: 'wallet-new' }),
      effectiveIsAdmin: true,
    });
    const result = await handleCrudRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('avatar_reassigned');
    expect(call.actorType).toBe('admin');
    const details = call.details as Record<string, unknown>;
    expect(details.previousOwner).toBe('wallet-old');
    expect(details.newOwner).toBe('wallet-new');
  });
});

// =========================================================================
// Unmatched routes
// =========================================================================
describe('unmatched routes', () => {
  it('returns null for unknown paths', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/something-else' });
    const result = await handleCrudRoutes(ctx);
    expect(result).toBeNull();
  });
});
