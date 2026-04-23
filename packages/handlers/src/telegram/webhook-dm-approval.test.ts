/**
 * Tests for the Telegram DM-approval webhook handlers (#1473).
 *
 * These pin:
 *  - Stranger DM: blocked → dropped silently; pending → dedupe; unbound
 *    owner → defers to caller fallback; happy path → holding + owner DM
 *    + pending record written.
 *  - Owner-notify failure: holding message is edited to "not set up".
 *  - Callback tamper / non-owner → alert, no state change.
 *  - Allow / Deny / Block / Revoke / Undo / Unblock each produce the
 *    correct writes + message edits + pending/blocklist transitions.
 *  - First-message preview is HTML-escaped in owner DM (no injection).
 */
import { describe, it, expect, mock } from 'bun:test';
import type { Update } from 'grammy/types';
import type { AvatarConfig } from '@swarm/core';
import {
  buildDmCallbackData,
  handleStrangerDm,
  handleDmApprovalCallback,
  DM_ACTION_ALLOW,
  type DmApprovalDeps,
} from './webhook-dm-approval.js';

const SIGNING_KEY = 'test-signing-key-32-bytes-long-aaaaa';

function makeBotApi() {
  return {
    sendMessage: mock(async (_chatId: number, _text: string, _extra?: Record<string, unknown>) => ({ message_id: 1000 })),
    editMessageText: mock(async () => ({})),
    answerCallbackQuery: mock(async () => ({})),
  };
}

function makeStateService() {
  return {
    saveAvatarConfig: mock(async () => {}),
  };
}

function makeBindingStore(telegramUserId = '100'): DmApprovalDeps['bindingStore'] {
  return {
    issueBindCode: mock(async () => ({ pk: '', sk: '', code: '', avatarId: '', issuedAt: 0, ttl: 0 })),
    consumeBindCode: mock(async () => null),
    getOwnerBinding: mock(async () =>
      telegramUserId
        ? {
            pk: 'AVATAR#a1',
            sk: 'TELEGRAM_OWNER_BINDING',
            avatarId: 'a1',
            telegramUserId,
            telegramUsername: 'alice',
            boundAt: 0,
          }
        : null,
    ),
    deleteOwnerBinding: mock(async () => {}),
  } as DmApprovalDeps['bindingStore'];
}

function makeApprovalStore(overrides: Partial<DmApprovalDeps['approvalStore']> = {}): DmApprovalDeps['approvalStore'] {
  return {
    createPendingDm: mock(async () => ({
      pk: 'x', sk: 'x', avatarId: 'a1', requesterId: '42',
      holdingMessageId: 10, ownerMessageId: 20, firstMessage: 'hi',
      issuedAt: 0, ttl: 0,
    })),
    getPendingDm: mock(async () => null),
    deletePendingDm: mock(async () => {}),
    listPending: mock(async () => []),
    addBlocked: mock(async () => {}),
    isBlocked: mock(async () => false),
    removeBlocked: mock(async () => {}),
    ...overrides,
  } as DmApprovalDeps['approvalStore'];
}

function makeConfig(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    avatarId: 'a1',
    name: 'Test',
    description: '',
    platforms: {
      telegram: {
        enabled: true,
        botUsername: 'testbot',
        allowedDmUsers: [],
        allowedChats: [],
      },
    },
    ...overrides,
  } as unknown as AvatarConfig;
}

function makeCallbackUpdate(data: string, fromId = 100): Update {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: { id: fromId, is_bot: false, first_name: 'Owner', username: 'alice', language_code: 'en' },
      message: {
        message_id: 20,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: 'private', first_name: 'Owner' },
      },
      chat_instance: 'test',
      data,
    },
  } as unknown as Update;
}

function baseDeps(params: {
  botApi?: ReturnType<typeof makeBotApi>;
  approval?: Partial<DmApprovalDeps['approvalStore']>;
  state?: ReturnType<typeof makeStateService>;
  ownerId?: string;
} = {}): DmApprovalDeps {
  return {
    bindingStore: makeBindingStore(params.ownerId ?? '100'),
    approvalStore: makeApprovalStore(params.approval),
    signingKey: SIGNING_KEY,
    botApi: params.botApi ?? makeBotApi(),
    stateService: params.state ?? makeStateService(),
  };
}

describe('buildDmCallbackData', () => {
  it('signed payload fits in the 64-byte cap for realistic Telegram IDs', () => {
    const data = buildDmCallbackData('allow', '12345678901', SIGNING_KEY);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(data.startsWith(DM_ACTION_ALLOW)).toBe(true);
  });
});

describe('handleStrangerDm', () => {
  it('drops silently when the requester is blocked', async () => {
    const approval = makeApprovalStore({ isBlocked: mock(async () => true) });
    const botApi = makeBotApi();
    const deps = baseDeps({ botApi, approval });
    const res = await handleStrangerDm({
      deps,
      input: {
        avatarId: 'a1', avatarConfig: makeConfig(),
        requesterId: '42', requesterChatId: 42, firstMessage: 'hi',
      },
    });
    expect(res.status).toBe('dropped_blocked');
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('dedupes silently when a pending approval already exists', async () => {
    const approval = makeApprovalStore({
      getPendingDm: mock(async () => ({
        pk: 'x', sk: 'x', avatarId: 'a1', requesterId: '42',
        holdingMessageId: 10, ownerMessageId: 20, firstMessage: 'hi',
        issuedAt: 0, ttl: Date.now() + 60_000,
      })),
    });
    const botApi = makeBotApi();
    const deps = baseDeps({ botApi, approval });
    const res = await handleStrangerDm({
      deps,
      input: {
        avatarId: 'a1', avatarConfig: makeConfig(),
        requesterId: '42', requesterChatId: 42, firstMessage: 'hi again',
      },
    });
    expect(res.status).toBe('dropped_pending');
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(approval.createPendingDm).not.toHaveBeenCalled();
  });

  it('returns unbound_owner when no binding exists, without writing state', async () => {
    const botApi = makeBotApi();
    const deps: DmApprovalDeps = {
      ...baseDeps({ botApi }),
      bindingStore: makeBindingStore(''),
    };
    const res = await handleStrangerDm({
      deps,
      input: {
        avatarId: 'a1', avatarConfig: makeConfig(),
        requesterId: '42', requesterChatId: 42, firstMessage: 'hi',
      },
    });
    expect(res.status).toBe('unbound_owner');
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('happy path: holding message + owner DM + pending record', async () => {
    const approval = makeApprovalStore();
    const botApi = makeBotApi();
    botApi.sendMessage = mock(async (chatId: number) => ({ message_id: chatId === 42 ? 111 : 222 }));
    const deps = baseDeps({ botApi, approval });

    const res = await handleStrangerDm({
      deps,
      input: {
        avatarId: 'a1', avatarConfig: makeConfig(),
        requesterId: '42', requesterUsername: 'stranger',
        requesterChatId: 42, firstMessage: 'hey <script>alert(1)</script>',
      },
    });

    expect(res.status).toBe('notified');
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    // First call: holding message to requester.
    expect(botApi.sendMessage.mock.calls[0]![0]).toBe(42);
    // Second call: owner notification. Text must escape HTML from firstMessage.
    const ownerText = String(botApi.sendMessage.mock.calls[1]![1]);
    expect(ownerText).toContain('&lt;script&gt;');
    expect(ownerText).not.toContain('<script>');

    // Pending record was written.
    expect(approval.createPendingDm).toHaveBeenCalledTimes(1);
    const persist = approval.createPendingDm.mock.calls[0]![0];
    expect(persist.requesterId).toBe('42');
    expect(persist.holdingMessageId).toBe(111);
    expect(persist.ownerMessageId).toBe(222);
  });

  it('rolls back the holding message when owner DM fails', async () => {
    const botApi = makeBotApi();
    let callCount = 0;
    botApi.sendMessage = mock(async () => {
      callCount++;
      if (callCount === 1) return { message_id: 111 };
      throw new Error('bot was blocked by the user');
    });

    const approval = makeApprovalStore();
    const deps = baseDeps({ botApi, approval });

    const res = await handleStrangerDm({
      deps,
      input: {
        avatarId: 'a1', avatarConfig: makeConfig(),
        requesterId: '42', requesterChatId: 42, firstMessage: 'hi',
      },
    });

    expect(res.status).toBe('owner_unreachable');
    expect(botApi.editMessageText).toHaveBeenCalledWith(
      42, 111, expect.stringMatching(/check back later/i),
    );
    expect(approval.createPendingDm).not.toHaveBeenCalled();
  });
});

describe('handleDmApprovalCallback', () => {
  it('returns not-handled for unrelated callback data', async () => {
    const deps = baseDeps();
    const res = await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate('other:thing:here'),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(res.handled).toBe(false);
  });

  it('rejects tampered data with alert, no state change', async () => {
    const state = makeStateService();
    const botApi = makeBotApi();
    const deps = baseDeps({ botApi, state });
    const good = buildDmCallbackData('allow', '42', SIGNING_KEY);
    const tampered = good.slice(0, -3) + 'AAA';
    const res = await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(tampered),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(res.handled).toBe(true);
    expect(state.saveAvatarConfig).not.toHaveBeenCalled();
    const extra = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(extra.show_alert).toBe(true);
  });

  it('rejects non-owner taps with alert, no state change', async () => {
    const state = makeStateService();
    const botApi = makeBotApi();
    const deps = baseDeps({ botApi, state });
    const data = buildDmCallbackData('allow', '42', SIGNING_KEY);
    const res = await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data, 999),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(res.handled).toBe(true);
    expect(state.saveAvatarConfig).not.toHaveBeenCalled();
  });

  it('Allow path writes requester into allowedDmUsers and edits both messages', async () => {
    const state = makeStateService();
    const botApi = makeBotApi();
    const approval = makeApprovalStore({
      getPendingDm: mock(async () => ({
        pk: 'x', sk: 'x', avatarId: 'a1', requesterId: '42',
        requesterUsername: 'stranger',
        holdingMessageId: 111, ownerMessageId: 20,
        firstMessage: 'hi', issuedAt: 0, ttl: Date.now() + 60000,
      })),
    });
    const deps = baseDeps({ botApi, state, approval });
    const data = buildDmCallbackData('allow', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    const saved = state.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedDmUsers).toEqual([
      expect.objectContaining({ userId: '42', username: 'stranger' }),
    ]);
    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);
    // One edit to the owner message (chatId 100), one to the requester's holding message (chatId 42).
    const chatIds = botApi.editMessageText.mock.calls.map(c => c[0]).sort((a, b) => Number(a) - Number(b));
    expect(chatIds).toEqual([42, 100]);
    expect(approval.deletePendingDm).toHaveBeenCalled();
  });

  it('Allow is idempotent when requester is already in the allowlist', async () => {
    const state = makeStateService();
    const config = makeConfig({
      platforms: {
        telegram: {
          enabled: true, botUsername: 'testbot',
          allowedDmUsers: [{ userId: '42', username: 'stranger' }],
        },
      },
    } as Partial<AvatarConfig>);
    const deps = baseDeps({ state });
    const data = buildDmCallbackData('allow', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: config,
    });
    expect(state.saveAvatarConfig).not.toHaveBeenCalled();
  });

  it('Deny edits messages but does NOT add to allowedDmUsers', async () => {
    const state = makeStateService();
    const botApi = makeBotApi();
    const approval = makeApprovalStore({
      getPendingDm: mock(async () => ({
        pk: 'x', sk: 'x', avatarId: 'a1', requesterId: '42',
        requesterUsername: 'stranger',
        holdingMessageId: 111, ownerMessageId: 20,
        firstMessage: 'hi', issuedAt: 0, ttl: Date.now() + 60000,
      })),
    });
    const deps = baseDeps({ botApi, state, approval });
    const data = buildDmCallbackData('deny', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(state.saveAvatarConfig).not.toHaveBeenCalled();
    expect(approval.deletePendingDm).toHaveBeenCalled();
    // Requester sees generic "not open" message (no denial leak).
    const requesterEdit = botApi.editMessageText.mock.calls.find(c => c[0] === 42);
    expect(String(requesterEdit?.[2])).toMatch(/open/i);
  });

  it('Block writes to blocklist and edits owner message', async () => {
    const botApi = makeBotApi();
    const approval = makeApprovalStore({
      getPendingDm: mock(async () => ({
        pk: 'x', sk: 'x', avatarId: 'a1', requesterId: '42',
        requesterUsername: 'spammer',
        holdingMessageId: 111, ownerMessageId: 20,
        firstMessage: 'hi', issuedAt: 0, ttl: Date.now() + 60000,
      })),
    });
    const deps = baseDeps({ botApi, approval });
    const data = buildDmCallbackData('block', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(approval.addBlocked).toHaveBeenCalledWith({
      avatarId: 'a1',
      requesterId: '42',
      requesterUsername: 'spammer',
    });
    expect(approval.deletePendingDm).toHaveBeenCalled();
  });

  it('Revoke removes an already-approved user from allowedDmUsers', async () => {
    const state = makeStateService();
    const config = makeConfig({
      platforms: {
        telegram: {
          enabled: true, botUsername: 'testbot',
          allowedDmUsers: [
            { userId: '42', username: 'stranger' },
            { userId: '77', username: 'other' },
          ],
        },
      },
    } as Partial<AvatarConfig>);
    const deps = baseDeps({ state });
    const data = buildDmCallbackData('revoke', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: config,
    });
    const saved = state.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedDmUsers).toEqual([
      expect.objectContaining({ userId: '77' }),
    ]);
  });

  it('Undo on a Denied row behaves like Allow', async () => {
    const state = makeStateService();
    const deps = baseDeps({ state });
    const data = buildDmCallbackData('undo', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    const saved = state.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedDmUsers).toEqual([
      expect.objectContaining({ userId: '42' }),
    ]);
  });

  it('Unblock removes from blocklist', async () => {
    const approval = makeApprovalStore();
    const deps = baseDeps({ approval });
    const data = buildDmCallbackData('unblock', '42', SIGNING_KEY);
    await handleDmApprovalCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeConfig(),
    });
    expect(approval.removeBlocked).toHaveBeenCalledWith('a1', '42');
  });
});
