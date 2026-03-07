/**
 * Telegram Webhook Shared Tests
 *
 * Tests covering:
 * - Chat access allowlists (DM, group, home channel)
 * - Home channel bootstrap from group engagement
 * - DM redirect messages
 * - /activate helpers (mergeAllowedChats)
 * - Webhook security: secret token verification
 * - Superadmin helpers
 * - DM allowlist edge cases
 * - Redirect message construction
 *
 * @see packages/handlers/src/telegram/telegram-webhook-shared.ts
 * @see packages/handlers/src/telegram/webhook-security.ts
 * @see packages/handlers/src/telegram/webhook-chat-access.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.ADMIN_TABLE ||= 'ADMIN_TABLE';
process.env.STATE_TABLE ||= 'STATE_TABLE';
process.env.MESSAGE_QUEUE_URL ||= 'https://example.com/queue';

const modPromise = import('./telegram-webhook-shared.js');
const securityModPromise = import('./webhook-security.js');
const chatAccessModPromise = import('./webhook-chat-access.js');
const homeChannelModPromise = import('./webhook-home-channel.js');

// =============================================================================
// Existing tests: Chat access allowlists
// =============================================================================

describe('telegram-webhook-shared allowlists', () => {
  it('blocks DMs when allowedDmUserIds is missing/empty', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUserIds: [] }
    );

    expect(allowed).toBe(false);
  });

  it('allows DMs only for allowlisted user IDs (string-coerced)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = await isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUserIds: ['123'] }
    );

    expect(allowed).toBe(true);
  });

  it('allows DMs only for allowlisted users using allowedDmUsers', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = await isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUsers: [{ userId: '123', username: 'alice' }] as unknown as Array<{ userId: string }> }
    );

    expect(allowed).toBe(true);
  });

  it('treats allowedDmUsers as authoritative when present (even if empty)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      {
        allowedDmUsers: [],
        allowedDmUserIds: ['123'],
      }
    );

    expect(allowed).toBe(false);
  });

  it('allows group chats when allowedChatIds is not configured', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      undefined
    );

    expect(allowed).toBe(true);
  });

  it('allows group chats when allowedChatIds is an empty array (no enforcement)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'group' },
      },
      { allowedChatIds: [] }
    );

    expect(allowed).toBe(true);
  });

  it('blocks non-private chats not present in allowedChatIds (when configured)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1002',
        sender: { id: 'u1' },
        metadata: { chatType: 'group' },
      },
      { allowedChatIds: ['-1001'] }
    );

    expect(allowed).toBe(false);
  });

  it('treats allowedChatIds as home channels when homeChannelChecker is enabled', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChatIds: ['-1001'], homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(true);
  });

  it('treats allowedChats as home channels when homeChannelChecker is enabled', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChats: [{ chatId: '-1001', title: 'Test' }] as unknown as Array<{ chatId: string }>, homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(true);
  });

  it('blocks group chats when homeChannelChecker is enabled and chat is neither a home channel nor in allowedChatIds', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1002',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChatIds: ['-1001'], homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(false);
  });
});

// =============================================================================
// Existing tests: Home channel bootstrap
// =============================================================================

describe('telegram-webhook-shared home channel bootstrap', () => {
  it('bootstraps home channel from first group mention when none exists', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const calls: Array<{ name: string; args: unknown[] }> = [];
    const deps = {
      registerHomeChannelFromWebhook: async (...args: unknown[]) => {
        calls.push({ name: 'register', args });
      },
      updateAvatarHomeChannel: async (...args: unknown[]) => {
        calls.push({ name: 'update', args });
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
    };

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '-1001',
          metadata: {
            chatType: 'supergroup',
            chatTitle: 'My Group',
            isMention: true,
          },
        },
      },
      deps
    );

    expect(bootstrapped).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['register', 'update']);

    expect(calls[0]?.args).toEqual(['a1', '-1001', 'DevilRATiBot', undefined, 'My Group']);
    expect(calls[1]?.args).toEqual(['a1', '-1001', undefined, 'My Group']);
  });

  it('does not bootstrap for private chats', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '123',
          metadata: {
            chatType: 'private',
            isMention: true,
          },
        },
      },
      {
        registerHomeChannelFromWebhook: async () => {
          throw new Error('should not be called');
        },
        updateAvatarHomeChannel: async () => {
          throw new Error('should not be called');
        },
        logger: {
          info: () => {},
          warn: () => {},
        },
      }
    );

    expect(bootstrapped).toBe(false);
  });

  it('does not bootstrap when already has homeChannelId', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
              homeChannelId: '-9999',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '-1001',
          metadata: {
            chatType: 'group',
            isMention: true,
          },
        },
      },
      {
        registerHomeChannelFromWebhook: async () => {
          throw new Error('should not be called');
        },
        updateAvatarHomeChannel: async () => {
          throw new Error('should not be called');
        },
        logger: {
          info: () => {},
          warn: () => {},
        },
      }
    );

    expect(bootstrapped).toBe(false);
  });
});

// =============================================================================
// Existing tests: DM redirect
// =============================================================================

describe('telegram-webhook-shared DM redirect', () => {
  it('includes ratichat link and New Bot button', async () => {
    const { buildDmRedirectMessage } = (await modPromise);
    const dm = buildDmRedirectMessage({ homeChannelUrl: 'https://t.me/ratichat' });

    expect(dm.text).toContain('https://t.me/ratichat');
    expect(dm.replyMarkup.inline_keyboard).toEqual([
      [{ text: 'Open RATi Chat', url: 'https://t.me/ratichat' }],
      [{ text: 'New Bot', url: 'https://t.me/ratichat?start=new_bot' }],
    ]);
  });
});

// =============================================================================
// Existing tests: /activate helpers
// =============================================================================

describe('telegram-webhook-shared /activate helpers', () => {
  it('mergeAllowedChats de-dupes IDs and preserves metadata', async () => {
    const { mergeAllowedChats } = (await modPromise);

    const merged = mergeAllowedChats({
      existingAllowedChatIds: ['-1001', '-1002'],
      existingAllowedChats: [{ chatId: '-1002', title: 'My Group' }],
      add: { chatId: '-1001', username: 'mychannel' },
    });

    expect(merged.allowedChatIds.sort()).toEqual(['-1001', '-1002']);
    expect(merged.allowedChats).toContainEqual({ chatId: '-1002', title: 'My Group' });
    expect(merged.allowedChats).toContainEqual({ chatId: '-1001', username: 'mychannel' });
  });

  it('mergeAllowedChats prefers new metadata when adding an existing chatId', async () => {
    const { mergeAllowedChats } = (await modPromise);

    const merged = mergeAllowedChats({
      existingAllowedChats: [{ chatId: '-1001', title: 'Old Title', username: 'old' }],
      existingAllowedChatIds: ['-1001'],
      add: { chatId: '-1001', title: 'New Title' },
    });

    expect(merged.allowedChatIds).toEqual(['-1001']);
    expect(merged.allowedChats).toEqual([{ chatId: '-1001', username: 'old', title: 'New Title' }]);
  });
});

// =============================================================================
// NEW: Webhook security - verifySecretToken
// =============================================================================

describe('webhook-security verifySecretToken', () => {
  it('returns true when provided token matches expected', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('my-secret-token', 'my-secret-token')).toBe(true);
  });

  it('returns false when provided token does not match expected', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('wrong-token', 'my-secret-token')).toBe(false);
  });

  it('returns false when provided token is undefined', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken(undefined, 'my-secret-token')).toBe(false);
  });

  it('returns false when provided token is empty string and expected is not', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('', 'my-secret-token')).toBe(false);
  });

  it('returns true when both are empty strings', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('', '')).toBe(true);
  });

  it('returns false when lengths differ (timing-safe comparison prerequisite)', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('short', 'a-much-longer-secret')).toBe(false);
  });

  it('handles unicode tokens correctly', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('token-\u00e9\u00e8', 'token-\u00e9\u00e8')).toBe(true);
    expect(verifySecretToken('token-\u00e9\u00e8', 'token-ee')).toBe(false);
  });

  it('is case-sensitive', async () => {
    const { verifySecretToken } = await securityModPromise;
    expect(verifySecretToken('MySecret', 'mysecret')).toBe(false);
    expect(verifySecretToken('MYSECRET', 'mysecret')).toBe(false);
  });
});

// =============================================================================
// NEW: webhook-security invalidateAvatarConfigCache
// =============================================================================

describe('webhook-security invalidateAvatarConfigCache', () => {
  it('removes the avatar entry from the config cache', async () => {
    const { invalidateAvatarConfigCache, avatarConfigCache } = await securityModPromise;

    // Manually populate cache
    avatarConfigCache.set('test-avatar', {
      value: { name: 'Test' } as unknown as import('@swarm/core').AvatarConfig,
      expiresAt: Date.now() + 60_000,
    });

    expect(avatarConfigCache.has('test-avatar')).toBe(true);
    invalidateAvatarConfigCache('test-avatar');
    expect(avatarConfigCache.has('test-avatar')).toBe(false);
  });

  it('is a no-op when avatarId is not in cache', async () => {
    const { invalidateAvatarConfigCache, avatarConfigCache } = await securityModPromise;
    const sizeBefore = avatarConfigCache.size;
    invalidateAvatarConfigCache('nonexistent-avatar');
    expect(avatarConfigCache.size).toBe(sizeBefore);
  });
});

// =============================================================================
// NEW: Superadmin helpers
// =============================================================================

describe('webhook-chat-access superadmin helpers', () => {
  let originalSuperadminEnv: string | undefined;

  beforeEach(() => {
    originalSuperadminEnv = process.env.TELEGRAM_SUPERADMIN_USERNAMES;
  });

  afterEach(() => {
    if (originalSuperadminEnv !== undefined) {
      process.env.TELEGRAM_SUPERADMIN_USERNAMES = originalSuperadminEnv;
    } else {
      delete process.env.TELEGRAM_SUPERADMIN_USERNAMES;
    }
  });

  it('returns default superadmin when env is not set', async () => {
    delete process.env.TELEGRAM_SUPERADMIN_USERNAMES;
    const { getSuperadminTelegramUsernames } = await chatAccessModPromise;
    const result = getSuperadminTelegramUsernames();
    expect(result).toContain('ratimics');
  });

  it('parses comma-separated usernames from env', async () => {
    process.env.TELEGRAM_SUPERADMIN_USERNAMES = 'alice,bob,charlie';
    const { getSuperadminTelegramUsernames } = await chatAccessModPromise;
    const result = getSuperadminTelegramUsernames();
    expect(result).toEqual(['alice', 'bob', 'charlie']);
  });

  it('strips @ prefix and lowercases usernames', async () => {
    process.env.TELEGRAM_SUPERADMIN_USERNAMES = '@Alice, @BOB ';
    const { getSuperadminTelegramUsernames } = await chatAccessModPromise;
    const result = getSuperadminTelegramUsernames();
    expect(result).toEqual(['alice', 'bob']);
  });

  it('returns default when env is empty', async () => {
    process.env.TELEGRAM_SUPERADMIN_USERNAMES = '';
    const { getSuperadminTelegramUsernames } = await chatAccessModPromise;
    const result = getSuperadminTelegramUsernames();
    expect(result).toContain('ratimics');
  });

  it('isTelegramSuperadmin returns false for undefined username', async () => {
    const { isTelegramSuperadmin } = await chatAccessModPromise;
    expect(isTelegramSuperadmin(undefined)).toBe(false);
  });

  it('isTelegramSuperadmin returns false for empty string', async () => {
    const { isTelegramSuperadmin } = await chatAccessModPromise;
    expect(isTelegramSuperadmin('')).toBe(false);
  });

  it('isTelegramSuperadmin is case-insensitive', async () => {
    delete process.env.TELEGRAM_SUPERADMIN_USERNAMES;
    const { isTelegramSuperadmin } = await chatAccessModPromise;
    expect(isTelegramSuperadmin('Ratimics')).toBe(true);
    expect(isTelegramSuperadmin('RATIMICS')).toBe(true);
    expect(isTelegramSuperadmin('ratimics')).toBe(true);
  });

  it('isTelegramSuperadmin strips @ prefix', async () => {
    delete process.env.TELEGRAM_SUPERADMIN_USERNAMES;
    const { isTelegramSuperadmin } = await chatAccessModPromise;
    expect(isTelegramSuperadmin('@ratimics')).toBe(true);
  });

  it('isTelegramSuperadmin returns false for non-admin user', async () => {
    delete process.env.TELEGRAM_SUPERADMIN_USERNAMES;
    const { isTelegramSuperadmin } = await chatAccessModPromise;
    expect(isTelegramSuperadmin('random_user')).toBe(false);
  });
});

// =============================================================================
// NEW: getAllowedDmUserIdsForAdmin edge cases
// =============================================================================

describe('webhook-chat-access getAllowedDmUserIdsForAdmin', () => {
  it('returns empty array when telegramCfg is undefined', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    expect(getAllowedDmUserIdsForAdmin(undefined)).toEqual([]);
  });

  it('returns empty array when telegramCfg is an empty object', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    expect(getAllowedDmUserIdsForAdmin({})).toEqual([]);
  });

  it('returns allowedDmUserIds when present and no allowedDmUsers', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    expect(getAllowedDmUserIdsForAdmin({ allowedDmUserIds: ['111', '222'] })).toEqual(['111', '222']);
  });

  it('prefers allowedDmUsers when both formats are present', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    const result = getAllowedDmUserIdsForAdmin({
      allowedDmUsers: [{ userId: '333' }],
      allowedDmUserIds: ['111', '222'],
    });
    expect(result).toEqual(['333']);
  });

  it('coerces numeric userId to string', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    const result = getAllowedDmUserIdsForAdmin({
      allowedDmUsers: [{ userId: 42 }],
    });
    expect(result).toEqual(['42']);
  });

  it('returns empty array for allowedDmUsers with empty array (authoritative)', async () => {
    const { getAllowedDmUserIdsForAdmin } = await chatAccessModPromise;
    const result = getAllowedDmUserIdsForAdmin({
      allowedDmUsers: [],
      allowedDmUserIds: ['111'],
    });
    expect(result).toEqual([]);
  });
});

// =============================================================================
// NEW: buildRedirectMessage edge cases
// =============================================================================

describe('webhook-chat-access buildRedirectMessage', () => {
  it('uses default home channel URL when no config provided', async () => {
    const { buildRedirectMessage } = await chatAccessModPromise;
    const msg = buildRedirectMessage();
    expect(msg).toContain('https://t.me/ratichat');
    expect(msg).toContain('$RATiOS');
  });

  it('uses homeChannelUrl from config', async () => {
    const { buildRedirectMessage } = await chatAccessModPromise;
    const msg = buildRedirectMessage({ homeChannelUrl: 'https://t.me/mychannel' });
    expect(msg).toContain('https://t.me/mychannel');
  });

  it('constructs URL from homeChannelUsername when homeChannelUrl is absent', async () => {
    const { buildRedirectMessage } = await chatAccessModPromise;
    const msg = buildRedirectMessage({ homeChannelUsername: 'mygroup' });
    expect(msg).toContain('https://t.me/mygroup');
  });

  it('uses custom coin symbol and address', async () => {
    const { buildRedirectMessage } = await chatAccessModPromise;
    const msg = buildRedirectMessage({ coinSymbol: '$TEST', coinAddress: 'abc123' });
    expect(msg).toContain('$TEST');
    expect(msg).toContain('abc123');
  });
});

// =============================================================================
// NEW: buildDmRedirectMessage edge cases
// =============================================================================

describe('webhook-chat-access buildDmRedirectMessage', () => {
  it('uses default URL when no config provided', async () => {
    const { buildDmRedirectMessage } = await chatAccessModPromise;
    const dm = buildDmRedirectMessage();
    expect(dm.text).toContain('https://t.me/ratichat');
    expect(dm.replyMarkup.inline_keyboard).toHaveLength(2);
  });

  it('constructs URL from homeChannelUsername', async () => {
    const { buildDmRedirectMessage } = await chatAccessModPromise;
    const dm = buildDmRedirectMessage({ homeChannelUsername: 'customgroup' });
    expect(dm.text).toContain('https://t.me/customgroup');
    expect(dm.replyMarkup.inline_keyboard[0][0].url).toBe('https://t.me/customgroup');
    expect(dm.replyMarkup.inline_keyboard[1][0].url).toBe('https://t.me/customgroup?start=new_bot');
  });

  it('prefers homeChannelUrl over homeChannelUsername', async () => {
    const { buildDmRedirectMessage } = await chatAccessModPromise;
    const dm = buildDmRedirectMessage({
      homeChannelUrl: 'https://t.me/preferred',
      homeChannelUsername: 'fallback',
    });
    expect(dm.text).toContain('https://t.me/preferred');
    expect(dm.replyMarkup.inline_keyboard[0][0].url).toBe('https://t.me/preferred');
  });
});

// =============================================================================
// NEW: isTelegramChatAllowed - allowAllDms flag
// =============================================================================

describe('isTelegramChatAllowed - allowAllDms', () => {
  it('allows DMs when allowAllDms is true (regardless of allowlist)', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm-chat',
        sender: { id: '99999' },
        metadata: { chatType: 'private' },
      },
      { allowAllDms: true, allowedDmUserIds: [] }
    );
    expect(allowed).toBe(true);
  });

  it('blocks DMs when allowAllDms is false and user not in allowlist', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;
    const allowed = await Promise.resolve(isTelegramChatAllowed(
      {
        conversationId: 'dm-chat',
        sender: { id: '99999' },
        metadata: { chatType: 'private' },
      },
      { allowAllDms: false, allowedDmUserIds: ['123'] }
    ));
    expect(allowed).toBe(false);
  });
});

// =============================================================================
// NEW: isTelegramChatAllowed - homeChannelChecker delegation
// =============================================================================

describe('isTelegramChatAllowed - homeChannelChecker', () => {
  it('delegates to homeChannelChecker.isHomeChannel when checker provided and chat not in allowedChatIds', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;
    let checkerCalled = false;
    let passedChatId = '';
    let passedHomeChannelId = '';

    const allowed = await isTelegramChatAllowed(
      {
        conversationId: '-2001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { homeChannelId: '-9999' },
      {
        isHomeChannel: async (chatId: string, avatarHomeChannelId?: string) => {
          checkerCalled = true;
          passedChatId = chatId;
          passedHomeChannelId = avatarHomeChannelId || '';
          return true;
        },
      }
    );

    expect(checkerCalled).toBe(true);
    expect(passedChatId).toBe('-2001');
    expect(passedHomeChannelId).toBe('-9999');
    expect(allowed).toBe(true);
  });

  it('returns false when homeChannelChecker says no and chat not in allowedChatIds', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;

    const allowed = await isTelegramChatAllowed(
      {
        conversationId: '-2001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    expect(allowed).toBe(false);
  });
});

// =============================================================================
// NEW: mergeAllowedChats additional edge cases
// =============================================================================

describe('mergeAllowedChats edge cases', () => {
  it('handles empty existing arrays', async () => {
    const { mergeAllowedChats } = await chatAccessModPromise;
    const merged = mergeAllowedChats({
      existingAllowedChatIds: [],
      existingAllowedChats: [],
      add: { chatId: '-1001', title: 'New Channel' },
    });

    expect(merged.allowedChatIds).toEqual(['-1001']);
    expect(merged.allowedChats).toEqual([{ chatId: '-1001', title: 'New Channel' }]);
  });

  it('handles undefined existing arrays', async () => {
    const { mergeAllowedChats } = await chatAccessModPromise;
    const merged = mergeAllowedChats({
      add: { chatId: '-1001' },
    });

    expect(merged.allowedChatIds).toEqual(['-1001']);
    expect(merged.allowedChats).toHaveLength(1);
    expect(merged.allowedChats[0].chatId).toBe('-1001');
  });

  it('preserves username from existing when new add has no username', async () => {
    const { mergeAllowedChats } = await chatAccessModPromise;
    const merged = mergeAllowedChats({
      existingAllowedChats: [{ chatId: '-1001', username: 'existing_name' }],
      existingAllowedChatIds: ['-1001'],
      add: { chatId: '-1001', title: 'Updated Title' },
    });

    expect(merged.allowedChats[0].username).toBe('existing_name');
    expect(merged.allowedChats[0].title).toBe('Updated Title');
  });
});

// =============================================================================
// NEW: Per-avatar home channel membership (issue #744)
// =============================================================================

describe('createHomeChannelChecker per-avatar scoping', () => {
  it('only allows channels where the specific avatar has explicit membership', async () => {
    // Test per-avatar scoping via isTelegramChatAllowed with per-avatar HomeChannelCheckers.
    // Each avatar gets its own checker that only returns true for channels where
    // that avatar has explicit membership (simulated here with different checker behavior).
    const { isTelegramChatAllowed } = await chatAccessModPromise;

    // Avatar A's checker says channel -1001 is a home channel
    const checkerA: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async (chatId: string, avatarHomeChannelId?: string) => {
        // Simulate: avatar A is registered in channel -1001
        if (avatarHomeChannelId && chatId === avatarHomeChannelId) return true;
        return chatId === '-1001';
      },
    };

    // Avatar B's checker — NOT registered in channel -1001
    const checkerB: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async (chatId: string, avatarHomeChannelId?: string) => {
        if (avatarHomeChannelId && chatId === avatarHomeChannelId) return true;
        return false; // B has no shared channel memberships
      },
    };

    // Avatar C's checker — NOT registered in channel -1001
    const checkerC: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async (chatId: string, avatarHomeChannelId?: string) => {
        if (avatarHomeChannelId && chatId === avatarHomeChannelId) return true;
        return false; // C has no shared channel memberships
      },
    };

    const envelope = {
      conversationId: '-1001',
      sender: { id: 'u1' },
      metadata: { chatType: 'supergroup' as const },
    };

    // Avatar A IS eligible (explicit membership)
    const allowedA = await isTelegramChatAllowed(envelope, {}, checkerA);
    expect(allowedA).toBe(true);

    // Avatar B is NOT eligible (no membership)
    const allowedB = await isTelegramChatAllowed(envelope, {}, checkerB);
    expect(allowedB).toBe(false);

    // Avatar C is NOT eligible (no membership)
    const allowedC = await isTelegramChatAllowed(envelope, {}, checkerC);
    expect(allowedC).toBe(false);
  });

  it('activating avatar A does not make avatar B eligible', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;

    // After activating avatar A in -1001, only A's checker returns true
    const checkerA: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async (chatId: string) => chatId === '-1001',
    };

    const checkerB: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async () => false,
    };

    const envelope = {
      conversationId: '-1001',
      sender: { id: 'u1' },
      metadata: { chatType: 'supergroup' as const },
    };

    expect(await isTelegramChatAllowed(envelope, {}, checkerA)).toBe(true);
    expect(await isTelegramChatAllowed(envelope, {}, checkerB)).toBe(false);
  });

  it('deactivating removes eligibility', async () => {
    const { isTelegramChatAllowed } = await chatAccessModPromise;

    // Before deactivation: avatar A has membership
    const checkerBefore: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async (chatId: string) => chatId === '-1001',
    };

    // After deactivation: avatar A no longer has membership
    const checkerAfter: import('./webhook-chat-access.js').HomeChannelChecker = {
      isHomeChannel: async () => false,
    };

    const envelope = {
      conversationId: '-1001',
      sender: { id: 'u1' },
      metadata: { chatType: 'supergroup' as const },
    };

    expect(await isTelegramChatAllowed(envelope, {}, checkerBefore)).toBe(true);
    expect(await isTelegramChatAllowed(envelope, {}, checkerAfter)).toBe(false);
  });
});

describe('createHomeChannelChecker avatarId parameter', () => {
  it('createHomeChannelChecker requires an avatarId argument', async () => {
    const { createHomeChannelChecker } = await homeChannelModPromise;

    // Verify the function signature requires avatarId
    expect(createHomeChannelChecker.length).toBe(1);

    // Calling without avatarId should not throw at creation time
    // (TypeScript enforces this at compile time)
    const checker = createHomeChannelChecker('test-avatar');
    expect(checker).toHaveProperty('isHomeChannel');
    expect(typeof checker.isHomeChannel).toBe('function');
  });

  it('checker returns true for avatar own homeChannelId fast path', async () => {
    const { createHomeChannelChecker } = await homeChannelModPromise;

    const checker = createHomeChannelChecker('avatar-x');
    // The fast path: chatId matches avatarHomeChannelId
    const result = await checker.isHomeChannel('-5000', '-5000');
    expect(result).toBe(true);
  });
});
