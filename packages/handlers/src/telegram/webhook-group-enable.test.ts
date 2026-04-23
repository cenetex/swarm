/**
 * Tests for the Telegram group-enablement flow (#1472).
 *
 * These pin:
 *  - The enablement keyboard shape (pending/enabled/disabled) and that
 *    unbound avatars get a no-buttons notice instead
 *  - Owner-only authz: non-owner tap → alert, no state change
 *  - Tampered callback_data → alert, no state change
 *  - Enable writes the chat into allowedChats; Disable removes it; Leave
 *    removes from allowedChats and calls leaveChat
 *  - Revocation helper removes the entry on kick/left
 */
import { describe, it, expect, mock } from 'bun:test';
import type { Update } from 'grammy/types';
import type { AvatarConfig } from '@swarm/core';
import {
  buildGroupCallbackData,
  buildPendingEnableKeyboard,
  buildEnabledKeyboard,
  buildDisabledKeyboard,
  postGroupEnablementKeyboard,
  handleGroupEnableCallback,
  revokeChatFromAllowedList,
  GROUP_ACTION_ENABLE,
  type GroupEnableDeps,
} from './webhook-group-enable.js';

const SIGNING_KEY = 'test-signing-key-32-bytes-long-aaaaa';

function makeBotApi() {
  return {
    sendMessage: mock(async () => ({ message_id: 10 })),
    editMessageText: mock(async () => ({})),
    answerCallbackQuery: mock(async () => ({})),
    leaveChat: mock(async () => ({})),
    deleteMessage: mock(async () => ({})),
  };
}

function makeStateService() {
  return {
    saveAvatarConfig: mock(async () => {}),
  };
}

function makeStore(overrides: Partial<GroupEnableDeps['bindingStore']> = {}): GroupEnableDeps['bindingStore'] {
  return {
    issueBindCode: mock(async () => ({ pk: 'x', sk: 'x', code: 'x', avatarId: 'a', issuedAt: 0, ttl: 0 })),
    consumeBindCode: mock(async () => null),
    getOwnerBinding: mock(async () => ({
      pk: 'AVATAR#a1',
      sk: 'TELEGRAM_OWNER_BINDING',
      avatarId: 'a1',
      telegramUserId: '100',
      telegramUsername: 'alice',
      boundAt: 1,
    })),
    deleteOwnerBinding: mock(async () => {}),
    ...overrides,
  } as GroupEnableDeps['bindingStore'];
}

function makeAvatarConfig(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
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

function makeCallbackUpdate(data: string, fromId = 100, fromUsername = 'alice'): Update {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: { id: fromId, is_bot: false, first_name: 'User', username: fromUsername, language_code: 'en' },
      message: {
        message_id: 555,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1001234567890, type: 'supergroup', title: 'Test Group', username: 'testgroup' },
      },
      chat_instance: 'test',
      data,
    },
  } as unknown as Update;
}

describe('buildGroupCallbackData / keyboards', () => {
  it('signs payloads that fit under Telegram 64-byte cap', () => {
    const data = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(data.startsWith(GROUP_ACTION_ENABLE)).toBe(true);
  });

  it('pending keyboard has Enable + Leave', () => {
    const kb = buildPendingEnableKeyboard('-100', SIGNING_KEY);
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].text).toContain('Enable');
    expect(kb.inline_keyboard[0][1].text).toContain('Leave');
  });

  it('enabled keyboard has Disable', () => {
    const kb = buildEnabledKeyboard('-100', SIGNING_KEY);
    expect(kb.inline_keyboard[0][0].text).toContain('Disable');
  });

  it('disabled keyboard has Re-enable', () => {
    const kb = buildDisabledKeyboard('-100', SIGNING_KEY);
    expect(kb.inline_keyboard[0][0].text).toContain('Re-enable');
  });
});

describe('postGroupEnablementKeyboard', () => {
  it('posts a keyboard when the owner is bound', async () => {
    const botApi = makeBotApi();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService: makeStateService(),
    };
    await postGroupEnablementKeyboard({
      deps,
      chatId: -1001234567890,
      chatTitle: 'Test Group',
      botUsername: 'testbot',
      avatarId: 'a1',
    });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const extra = botApi.sendMessage.mock.calls[0]![2] as { reply_markup: { inline_keyboard: unknown[][] } };
    expect(extra.reply_markup.inline_keyboard[0]).toHaveLength(2);
  });

  it('posts a no-buttons notice when the owner is not bound', async () => {
    const botApi = makeBotApi();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore({ getOwnerBinding: mock(async () => null) }),
      signingKey: SIGNING_KEY,
      botApi,
      stateService: makeStateService(),
    };
    await postGroupEnablementKeyboard({
      deps,
      chatId: -1001234567890,
      botUsername: 'testbot',
      avatarId: 'a1',
    });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const [, text, extra] = botApi.sendMessage.mock.calls[0]!;
    expect(String(text)).toMatch(/set.*up|owner/i);
    expect(extra).toBeUndefined();
  });
});

describe('handleGroupEnableCallback', () => {
  it('returns not-handled for unrelated callback data', async () => {
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi: makeBotApi(),
      stateService: makeStateService(),
    };
    const update = makeCallbackUpdate('something-else');
    const res = await handleGroupEnableCallback({
      deps, update, avatarId: 'a1', avatarConfig: makeAvatarConfig(),
    });
    expect(res.handled).toBe(false);
  });

  it('rejects tampered callback_data with an alert and no state change', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const good = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    const tampered = good.slice(0, -3) + 'AAA';
    const res = await handleGroupEnableCallback({
      deps,
      update: makeCallbackUpdate(tampered),
      avatarId: 'a1',
      avatarConfig: makeAvatarConfig(),
    });
    expect(res.handled).toBe(true);
    expect(stateService.saveAvatarConfig).not.toHaveBeenCalled();
    const alertExtra = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(alertExtra.show_alert).toBe(true);
  });

  it('rejects a non-owner tap with an alert and no state change', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const data = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    const update = makeCallbackUpdate(data, 999, 'intruder');
    const res = await handleGroupEnableCallback({
      deps, update, avatarId: 'a1', avatarConfig: makeAvatarConfig(),
    });
    expect(res.handled).toBe(true);
    expect(stateService.saveAvatarConfig).not.toHaveBeenCalled();
    const alertExtra = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(alertExtra.show_alert).toBe(true);
    expect(String(alertExtra)).not.toContain('a1'); // no avatarId leak
  });

  it('enable adds the chat to allowedChats and edits the keyboard to Disable', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const data = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    const res = await handleGroupEnableCallback({
      deps,
      update: makeCallbackUpdate(data),
      avatarId: 'a1',
      avatarConfig: makeAvatarConfig(),
    });
    expect(res.handled).toBe(true);
    expect(stateService.saveAvatarConfig).toHaveBeenCalledTimes(1);
    const saved = stateService.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedChats).toEqual([
      expect.objectContaining({ chatId: '-1001234567890' }),
    ]);
    const [,, text, extra] = botApi.editMessageText.mock.calls[0]!;
    expect(String(text)).toMatch(/enabled/i);
    const markup = (extra as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }).reply_markup;
    expect(markup.inline_keyboard[0][0].text).toContain('Disable');
  });

  it('enable is a no-op write when the chat is already in allowedChats', async () => {
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi: makeBotApi(),
      stateService,
    };
    const config = makeAvatarConfig({
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChats: [{ chatId: '-1001234567890' }],
        },
      },
    } as unknown as Partial<AvatarConfig>);
    const data = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    await handleGroupEnableCallback({
      deps, update: makeCallbackUpdate(data), avatarId: 'a1', avatarConfig: config,
    });
    expect(stateService.saveAvatarConfig).not.toHaveBeenCalled();
  });

  it('disable removes the chat from allowedChats and edits to Re-enable', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const config = makeAvatarConfig({
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChats: [{ chatId: '-1001234567890' }],
        },
      },
    } as unknown as Partial<AvatarConfig>);
    const data = buildGroupCallbackData('disable', '-1001234567890', SIGNING_KEY);
    await handleGroupEnableCallback({
      deps, update: makeCallbackUpdate(data), avatarId: 'a1', avatarConfig: config,
    });
    const saved = stateService.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedChats).toEqual([]);
    const markup = (botApi.editMessageText.mock.calls[0]![3] as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }).reply_markup;
    expect(markup.inline_keyboard[0][0].text).toContain('Re-enable');
  });

  it('leave removes from allowedChats and calls leaveChat', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const config = makeAvatarConfig({
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChats: [{ chatId: '-1001234567890' }],
        },
      },
    } as unknown as Partial<AvatarConfig>);
    const data = buildGroupCallbackData('leave', '-1001234567890', SIGNING_KEY);
    await handleGroupEnableCallback({
      deps, update: makeCallbackUpdate(data), avatarId: 'a1', avatarConfig: config,
    });
    expect(stateService.saveAvatarConfig).toHaveBeenCalledTimes(1);
    expect(botApi.leaveChat).toHaveBeenCalledWith(-1001234567890);
    expect(botApi.deleteMessage).toHaveBeenCalled();
  });

  it('leave tolerates leaveChat errors (bot already removed)', async () => {
    const botApi = makeBotApi();
    botApi.leaveChat = mock(async () => { throw new Error('bot was kicked'); });
    const deps: GroupEnableDeps = {
      bindingStore: makeStore(),
      signingKey: SIGNING_KEY,
      botApi,
      stateService: makeStateService(),
    };
    const data = buildGroupCallbackData('leave', '-1001234567890', SIGNING_KEY);
    const res = await handleGroupEnableCallback({
      deps, update: makeCallbackUpdate(data), avatarId: 'a1', avatarConfig: makeAvatarConfig(),
    });
    expect(res.handled).toBe(true);
  });

  it('rejects taps when no owner is bound yet', async () => {
    const botApi = makeBotApi();
    const stateService = makeStateService();
    const deps: GroupEnableDeps = {
      bindingStore: makeStore({ getOwnerBinding: mock(async () => null) }),
      signingKey: SIGNING_KEY,
      botApi,
      stateService,
    };
    const data = buildGroupCallbackData('enable', '-1001234567890', SIGNING_KEY);
    await handleGroupEnableCallback({
      deps, update: makeCallbackUpdate(data), avatarId: 'a1', avatarConfig: makeAvatarConfig(),
    });
    expect(stateService.saveAvatarConfig).not.toHaveBeenCalled();
    const alertExtra = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(alertExtra.show_alert).toBe(true);
  });
});

describe('revokeChatFromAllowedList', () => {
  it('removes the chat and saves the updated config', async () => {
    const stateService = makeStateService();
    const config = makeAvatarConfig({
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChats: [
            { chatId: '-1001234567890', title: 'A' },
            { chatId: '-1009999999999', title: 'B' },
          ],
        },
      },
    } as unknown as Partial<AvatarConfig>);
    const revoked = await revokeChatFromAllowedList({
      avatarConfig: config,
      chatId: '-1001234567890',
      stateService,
    });
    expect(revoked).toBe(true);
    const saved = stateService.saveAvatarConfig.mock.calls[0]![0] as AvatarConfig;
    expect(saved.platforms.telegram!.allowedChats).toEqual([{ chatId: '-1009999999999', title: 'B' }]);
  });

  it('returns false when the chat is not in the list', async () => {
    const stateService = makeStateService();
    const config = makeAvatarConfig();
    const revoked = await revokeChatFromAllowedList({
      avatarConfig: config,
      chatId: '-1001234567890',
      stateService,
    });
    expect(revoked).toBe(false);
    expect(stateService.saveAvatarConfig).not.toHaveBeenCalled();
  });
});
