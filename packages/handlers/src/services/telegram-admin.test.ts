import { describe, it, expect, mock } from 'bun:test';
import type { Message, Update } from 'grammy/types';
import { createTelegramAdminService } from './telegram-admin.js';
import type { TelegramAdminSession } from '../types/telegram-admin.js';
import * as keyboards from './telegram-keyboards.js';

function makeSession(overrides: Partial<TelegramAdminSession> = {}): TelegramAdminSession {
  return {
    pk: 'TG_ADMIN#42',
    sk: 'SESSION',
    telegramUserId: '42',
    telegramUsername: 'alice',
    telegramDisplayName: 'Alice',
    state: 'idle',
    startedAt: 1,
    updatedAt: 1,
    ttl: 999,
    ...overrides,
  };
}

function makeSessionService(session: TelegramAdminSession, existingBot: { avatarId: string; botUsername: string } | null = null) {
  return {
    getOrCreateSession: mock(async () => session),
    getSession: mock(async () => session),
    updateState: mock(async () => {}),
    resetState: mock(async () => {}),
    setAvatarId: mock(async () => {}),
    getUserBot: mock(async () => existingBot),
    registerUserBot: mock(async () => {}),
  };
}

function makeBotApi() {
  return {
    sendMessage: mock(async () => ({ message_id: 123 } as unknown as Message)),
    editMessageText: mock(async () => ({})),
    answerCallbackQuery: mock(async () => ({})),
  };
}

function makeManagedBotUpdate(): unknown {
  return {
    update_id: 1,
    managed_bot: {
      user: {
        id: 42,
        is_bot: false,
        first_name: 'Alice',
        username: 'alice',
      },
      bot: {
        id: 987654321,
        is_bot: true,
        first_name: 'Alice Helper',
        username: 'alice_helper_bot',
      },
    },
  };
}

function makeManualTokenCallback(): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      from: {
        id: 42,
        is_bot: false,
        first_name: 'Alice',
        username: 'alice',
      },
      message: {
        message_id: 555,
        date: 1,
        chat: { id: 42, type: 'private', first_name: 'Alice' },
      },
      chat_instance: 'chat-instance',
      data: 'manual_token',
    },
  } as unknown as Update;
}

describe('TelegramAdminService managed bot onboarding', () => {
  it('moves a managed bot into onboarding after retrieving its token', async () => {
    const session = makeSession();
    const sessionService = makeSessionService(session);
    const botApi = makeBotApi();
    const getManagedBotToken = mock(async () => ({
      success: true,
      token: '987654321:managed-secret-token',
    }));

    const service = createTelegramAdminService({
      adminTable: 'ADMIN_TABLE',
      botToken: 'manager-token',
      managerBotUsername: 'RatiBot',
      createAvatar: mock(async () => ({ success: true, avatarId: 'alice-helper-bot' })),
      getManagedBotToken,
      sessionService,
      botApi,
    });

    await service.processManagedBotUpdate(makeManagedBotUpdate());

    expect(getManagedBotToken).toHaveBeenCalledWith(987654321);
    expect(sessionService.updateState).toHaveBeenCalledTimes(1);

    const [telegramUserId, state, stateData] = sessionService.updateState.mock.calls[0]!;
    expect(telegramUserId).toBe('42');
    expect(state).toBe('onboarding_name');
    expect(stateData).toMatchObject({
      botToken: '987654321:managed-secret-token',
      botUsername: 'alice_helper_bot',
      botId: 987654321,
      provisioningSource: 'managed_bot',
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = botApi.sendMessage.mock.calls[0]!;
    expect(text).toContain('@alice_helper_bot');
    expect(text).not.toContain('managed-secret-token');
  });

  it('rejects managed bot provisioning when the Telegram user already has a bot', async () => {
    const session = makeSession({ avatarId: 'existing-avatar' });
    const sessionService = makeSessionService(session, {
      avatarId: 'existing-avatar',
      botUsername: 'existing_bot',
    });
    const botApi = makeBotApi();
    const getManagedBotToken = mock(async () => ({
      success: true,
      token: '987654321:managed-secret-token',
    }));

    const service = createTelegramAdminService({
      adminTable: 'ADMIN_TABLE',
      botToken: 'manager-token',
      createAvatar: mock(async () => ({ success: true, avatarId: 'unused' })),
      getManagedBotToken,
      sessionService,
      botApi,
    });

    await service.processManagedBotUpdate(makeManagedBotUpdate());

    expect(getManagedBotToken).not.toHaveBeenCalled();
    expect(sessionService.updateState).not.toHaveBeenCalled();
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = botApi.sendMessage.mock.calls[0]!;
    expect(text).toContain('@existing_bot');
  });

  it('keeps manual BotFather token fallback available from onboarding', async () => {
    const session = makeSession();
    const sessionService = makeSessionService(session);
    const botApi = makeBotApi();

    const service = createTelegramAdminService({
      adminTable: 'ADMIN_TABLE',
      botToken: 'manager-token',
      createAvatar: mock(async () => ({ success: true, avatarId: 'unused' })),
      sessionService,
      botApi,
    });

    await service.processCallbackQuery(makeManualTokenCallback());

    expect(botApi.answerCallbackQuery).toHaveBeenCalledWith('cb-1', { text: undefined });
    expect(sessionService.updateState).toHaveBeenCalledWith('42', 'onboarding_token');
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const [, , text, extra] = botApi.editMessageText.mock.calls[0]!;
    expect(text).toBe(keyboards.MANUAL_TOKEN_INSTRUCTIONS);
    expect(extra).toMatchObject({ reply_markup: keyboards.cancelKeyboard() });
  });
});
