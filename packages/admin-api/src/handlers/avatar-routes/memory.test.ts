/**
 * Tests for avatar-routes/memory.ts
 *
 * Routes:
 *   DELETE /avatars/{id}/memories          - Delete all memories
 *   DELETE /avatars/{id}/memories/{memId}  - Delete a specific memory
 *   GET    /avatars/{id}/memories/export   - Export all memories as JSON
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let isMemoryEnabledResult = true;
let getMemoriesResults: Record<string, unknown[]> = { immediate: [], recent: [], core: [] };
let getMemoryResult: unknown = null;
let deleteMemoryCalled = false;
let deleteMemoriesCalled = false;
let deleteMemoriesSks: string[] = [];

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/billing/entitlements.js', () => ({
  isMemoryEnabled: async () => isMemoryEnabledResult,
}));

vi.mock('../../services/memory.js', () => ({
  getMemories: async (_avatarId: string, options: { tier?: string }) => {
    const tier = options?.tier || 'immediate';
    return getMemoriesResults[tier] || [];
  },
  getMemory: async () => getMemoryResult,
  deleteMemory: async () => {
    deleteMemoryCalled = true;
  },
  deleteMemories: async (_avatarId: string, sks: string[]) => {
    deleteMemoriesCalled = true;
    deleteMemoriesSks = sks;
  },
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

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleMemoryRoutes } from './memory.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  isMemoryEnabledResult = true;
  getMemoriesResults = { immediate: [], recent: [], core: [] };
  getMemoryResult = null;
  deleteMemoryCalled = false;
  deleteMemoriesCalled = false;
  deleteMemoriesSks = [];
});

// =========================================================================
// GET /avatars/{id}/memories/export
// =========================================================================
describe('GET /avatars/{id}/memories/export', () => {
  it('exports all memories for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getMemoriesResults = {
      immediate: [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#123#mem-1',
          id: 'mem-1',
          avatarId: 'avatar-1',
          tier: 'immediate',
          type: 'fact',
          content: 'Test memory',
          strength: 1.0,
          embedding: [0.1, 0.2],
          embeddingModel: 'test-model',
          embeddingVersion: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      recent: [],
      core: [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'core#456#mem-2',
          id: 'mem-2',
          avatarId: 'avatar-1',
          tier: 'core',
          type: 'identity',
          content: 'I am curious',
          strength: 1.5,
          createdAt: 2000,
          updatedAt: 2000,
        },
      ],
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/memories/export',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);

    const body = parseBody(result!) as {
      avatarId: string;
      exportedAt: string;
      counts: { immediate: number; recent: number; core: number; total: number };
      memories: { immediate: unknown[]; recent: unknown[]; core: unknown[] };
    };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.counts.total).toBe(2);
    expect(body.counts.immediate).toBe(1);
    expect(body.counts.core).toBe(1);
    expect(body.memories.immediate).toHaveLength(1);
    expect(body.memories.core).toHaveLength(1);

    // Verify pk, sk, and embedding fields are stripped
    const exportedMemory = body.memories.immediate[0] as Record<string, unknown>;
    expect(exportedMemory).not.toHaveProperty('pk');
    expect(exportedMemory).not.toHaveProperty('sk');
    expect(exportedMemory).not.toHaveProperty('embedding');
    expect(exportedMemory).not.toHaveProperty('embeddingModel');
    expect(exportedMemory).not.toHaveProperty('embeddingVersion');
    expect(exportedMemory.content).toBe('Test memory');
  });

  it('returns 404 when avatar not found (non-admin)', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/memories/export',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });

  it('returns 403 when memory is not enabled', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    isMemoryEnabledResult = false;

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/memories/export',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(403);
    const body = parseBody(result!) as { error: string };
    expect(body.error).toContain('Memory is not enabled');
  });

  it('allows owner to export', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    getMemoriesResults = { immediate: [], recent: [], core: [] };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/memories/export',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('denies non-owner access to export', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-owner', inhabitantWallet: 'wallet-inhabitant' };
    getMemoriesResults = { immediate: [], recent: [], core: [] };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/memories/export',
      walletAddress: 'wallet-inhabitant',
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// DELETE /avatars/{id}/memories/{memoryId}
// =========================================================================
describe('DELETE /avatars/{id}/memories/{memoryId}', () => {
  it('deletes a specific memory for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getMemoryResult = {
      pk: 'MEMORY#avatar-1',
      sk: 'immediate#123#mem-1',
      id: 'mem-1',
      avatarId: 'avatar-1',
      tier: 'immediate',
      type: 'fact',
      content: 'Test memory',
      strength: 1.0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories/mem-1',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(deleteMemoryCalled).toBe(true);

    const body = parseBody(result!) as { success: boolean; memoryId: string };
    expect(body.success).toBe(true);
    expect(body.memoryId).toBe('mem-1');
  });

  it('returns 404 when memory not found', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getMemoryResult = null;

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories/nonexistent',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(404);
    const body = parseBody(result!) as { error: string };
    expect(body.error).toBe('Memory not found');
  });

  it('returns 403 when memory is not enabled', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    isMemoryEnabledResult = false;

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories/mem-1',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('does not match export path as a memoryId', async () => {
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories/export',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    // Should fall through (return null) since "export" is not a valid memoryId target for DELETE
    expect(result).toBeNull();
  });

  it('non-owner gets 404', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories/mem-1',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// DELETE /avatars/{id}/memories
// =========================================================================
describe('DELETE /avatars/{id}/memories', () => {
  it('deletes all memories for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getMemoriesResults = {
      immediate: [
        { sk: 'immediate#1#a' },
        { sk: 'immediate#2#b' },
      ],
      recent: [
        { sk: 'recent#3#c' },
      ],
      core: [
        { sk: 'core#4#d' },
      ],
    };

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(deleteMemoriesCalled).toBe(true);
    expect(deleteMemoriesSks).toHaveLength(4);

    const body = parseBody(result!) as { success: boolean; deletedCount: number };
    expect(body.success).toBe(true);
    expect(body.deletedCount).toBe(4);
  });

  it('returns success with zero count when no memories exist', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getMemoriesResults = { immediate: [], recent: [], core: [] };

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(deleteMemoriesCalled).toBe(false); // Should not call batch delete for 0 items

    const body = parseBody(result!) as { deletedCount: number };
    expect(body.deletedCount).toBe(0);
  });

  it('returns 403 when memory is not enabled', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    isMemoryEnabledResult = false;

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories',
      effectiveIsAdmin: true,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('owner can delete all memories', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    getMemoriesResults = {
      immediate: [{ sk: 'immediate#1#a' }],
      recent: [],
      core: [],
    };

    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/memories',
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleMemoryRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// Unmatched routes
// =========================================================================
describe('unmatched routes', () => {
  it('returns null for unrelated paths', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/unknown' });
    const result = await handleMemoryRoutes(ctx);
    expect(result).toBeNull();
  });

  it('returns null for GET on memories list (not implemented)', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/memories' });
    const result = await handleMemoryRoutes(ctx);
    expect(result).toBeNull();
  });
});
