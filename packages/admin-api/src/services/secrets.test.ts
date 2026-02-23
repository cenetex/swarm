/**
 * Tests for secrets service — deleteAllAvatarSecrets cleanup flow.
 *
 * Uses the DI deps interface to inject mock implementations of
 * listSecrets and deleteSecret, verifying that avatar deletion
 * schedules secrets for deletion with a 7-day recovery window.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deleteAllAvatarSecrets } from './secrets.js';
import type { SecretCleanupDeps, DeleteSecretOptions } from './secrets.js';
import type { SecretMetadata, SecretType, UserSession } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const testSession: UserSession = {
  email: 'admin@test.com',
  userId: 'user-1',
  isAdmin: true,
  accessToken: 'tok',
};

function makeSecret(secretType: SecretType, name: string): SecretMetadata {
  return {
    pk: 'AVATAR#avatar-1',
    sk: `SECRET#${secretType}#${name}`,
    secretType,
    name,
    secretArn: `arn:aws:secretsmanager:us-east-1:123:secret:swarm/avatar-1/${secretType}/${name}`,
    createdAt: 1000,
    createdBy: 'admin@test.com',
    updatedAt: 2000,
    updatedBy: 'admin@test.com',
    isGlobal: false,
  };
}

// ── Test state ───────────────────────────────────────────────────────────────

let deleteCalls: Array<{
  avatarId: string | null;
  secretType: SecretType;
  name: string;
  session: UserSession;
  options: boolean | DeleteSecretOptions;
}>;

let mockSecrets: SecretMetadata[];
let deleteError: Error | null;

function makeDeps(overrides?: Partial<SecretCleanupDeps>): SecretCleanupDeps {
  return {
    listSecrets: async (_avatarId: string) => mockSecrets,
    deleteSecret: async (avatarId, secretType, name, session, options) => {
      deleteCalls.push({ avatarId, secretType, name, session, options });
      if (deleteError) throw deleteError;
    },
    ...overrides,
  };
}

beforeEach(() => {
  deleteCalls = [];
  mockSecrets = [];
  deleteError = null;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deleteAllAvatarSecrets', () => {
  it('deletes all secrets for an avatar with 7-day recovery window', async () => {
    mockSecrets = [
      makeSecret('telegram_bot_token', 'bot-token'),
      makeSecret('openrouter_api_key', 'api-key'),
    ];
    const deps = makeDeps();

    const result = await deleteAllAvatarSecrets('avatar-1', testSession, deps);

    expect(result).toEqual({ deleted: 2, errors: 0 });
    expect(deleteCalls).toHaveLength(2);

    // Verify each call uses recoveryWindowDays: 7 (not forceDelete)
    for (const call of deleteCalls) {
      expect(call.avatarId).toBe('avatar-1');
      expect(call.session).toBe(testSession);
      expect(call.options).toEqual({ recoveryWindowDays: 7 });
    }

    // Verify correct secret types were passed
    expect(deleteCalls[0].secretType).toBe('telegram_bot_token');
    expect(deleteCalls[0].name).toBe('bot-token');
    expect(deleteCalls[1].secretType).toBe('openrouter_api_key');
    expect(deleteCalls[1].name).toBe('api-key');
  });

  it('returns zero counts when avatar has no secrets', async () => {
    mockSecrets = [];
    const deps = makeDeps();

    const result = await deleteAllAvatarSecrets('avatar-empty', testSession, deps);

    expect(result).toEqual({ deleted: 0, errors: 0 });
    expect(deleteCalls).toHaveLength(0);
  });

  it('counts errors without throwing when individual secret deletion fails', async () => {
    mockSecrets = [
      makeSecret('telegram_bot_token', 'bot-token'),
      makeSecret('discord_bot_token', 'bot-token'),
      makeSecret('openrouter_api_key', 'api-key'),
    ];

    // Fail on the second call only
    let callCount = 0;
    const deps = makeDeps({
      deleteSecret: async (avatarId, secretType, name, session, options) => {
        deleteCalls.push({ avatarId, secretType, name, session, options });
        callCount++;
        if (callCount === 2) {
          throw new Error('AccessDeniedException: not authorized');
        }
      },
    });

    const result = await deleteAllAvatarSecrets('avatar-1', testSession, deps);

    expect(result).toEqual({ deleted: 2, errors: 1 });
    // All three secrets were attempted
    expect(deleteCalls).toHaveLength(3);
  });

  it('handles all deletions failing gracefully', async () => {
    mockSecrets = [
      makeSecret('telegram_bot_token', 'bot-token'),
      makeSecret('discord_bot_token', 'bot-token'),
    ];
    deleteError = new Error('Service unavailable');
    const deps = makeDeps();

    const result = await deleteAllAvatarSecrets('avatar-1', testSession, deps);

    expect(result).toEqual({ deleted: 0, errors: 2 });
    expect(deleteCalls).toHaveLength(2);
  });

  it('uses recoveryWindowDays: 7, not forceDelete', async () => {
    mockSecrets = [makeSecret('custom', 'my-secret')];
    const deps = makeDeps();

    await deleteAllAvatarSecrets('avatar-1', testSession, deps);

    // The key assertion: we should NOT see forceDelete: true
    const opts = deleteCalls[0].options;
    expect(typeof opts).toBe('object');
    expect((opts as DeleteSecretOptions).recoveryWindowDays).toBe(7);
    expect((opts as DeleteSecretOptions).forceDelete).toBeUndefined();
  });
});
