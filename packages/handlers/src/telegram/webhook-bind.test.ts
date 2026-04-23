/**
 * Tests for the Telegram owner-binding webhook handlers (#1471).
 *
 * These pin the two Telegram-side touch points:
 *   - /start bind_<code>  → posts the signed confirmation keyboard
 *   - callback_query      → confirm consumes + writes binding; cancel is a no-op;
 *                           tampered data is rejected via answerCallbackQuery
 */
import { describe, it, expect, mock } from 'bun:test';
import type { Update } from 'grammy/types';
import {
  buildBindCallbackData,
  handleBindStart,
  handleBindCallback,
  BIND_ACTION_CONFIRM,
  BIND_ACTION_CANCEL,
} from './webhook-bind.js';
import type { BindHandlerDeps } from './webhook-bind.js';

const SIGNING_KEY = 'test-signing-key-32-bytes-long-aaaaa';

function makeMockBot() {
  return {
    sendMessage: mock(async () => ({ message_id: 999 })),
    editMessageText: mock(async () => ({})),
    answerCallbackQuery: mock(async () => ({})),
  };
}

function makeMockStore(overrides: Partial<BindHandlerDeps['bindingStore']> = {}): BindHandlerDeps['bindingStore'] {
  return {
    issueBindCode: mock(async () => ({
      pk: 'TELEGRAM_BIND#code-1',
      sk: 'META',
      code: 'code-1',
      avatarId: 'a1',
      issuedAt: Date.now(),
      ttl: Math.floor(Date.now() / 1000) + 900,
    })),
    consumeBindCode: mock(async () => ({
      pk: 'AVATAR#a1',
      sk: 'TELEGRAM_OWNER_BINDING',
      avatarId: 'a1',
      telegramUserId: '42',
      telegramUsername: 'alice',
      boundAt: Date.now(),
    })),
    getOwnerBinding: mock(async () => null),
    deleteOwnerBinding: mock(async () => {}),
    ...overrides,
  } as BindHandlerDeps['bindingStore'];
}

describe('buildBindCallbackData', () => {
  it('produces a signed payload under the 64-byte Telegram cap', () => {
    const data = buildBindCallbackData('confirm', 'code-aBcDeFg1234567890XYZ=', SIGNING_KEY);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(data.startsWith(BIND_ACTION_CONFIRM)).toBe(true);
  });

  it('uses the cancel prefix for cancel', () => {
    const data = buildBindCallbackData('cancel', 'abc123', SIGNING_KEY);
    expect(data.startsWith(BIND_ACTION_CANCEL)).toBe(true);
  });
});

describe('handleBindStart', () => {
  it('posts a signed inline keyboard with Confirm and Cancel buttons', async () => {
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = {
      bindingStore: makeMockStore(),
      signingKey: SIGNING_KEY,
      botApi,
    };

    await handleBindStart({ deps, chatId: 123, code: 'code-xyz', avatarId: 'a1' });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, , extra] = botApi.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(123);
    const markup = (extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup;
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0]).toHaveLength(2);
    expect(markup.inline_keyboard[0][0].callback_data.startsWith(BIND_ACTION_CONFIRM)).toBe(true);
    expect(markup.inline_keyboard[0][1].callback_data.startsWith(BIND_ACTION_CANCEL)).toBe(true);
  });
});

describe('handleBindCallback', () => {
  function makeUpdate(callbackData: string, fromId = 42, fromUsername?: string): Update {
    return {
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: {
          id: fromId,
          is_bot: false,
          first_name: 'Alice',
          username: fromUsername,
          language_code: 'en',
        },
        message: {
          message_id: 555,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123, type: 'private', first_name: 'Alice' },
        },
        chat_instance: 'test',
        data: callbackData,
      },
    } as unknown as Update;
  }

  it('returns not-handled when callback data does not start with bind prefix', async () => {
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = { bindingStore: makeMockStore(), signingKey: SIGNING_KEY, botApi };
    const update = makeUpdate('something:else:here');
    const res = await handleBindCallback({ deps, update, avatarId: 'a1' });
    expect(res.handled).toBe(false);
  });

  it('rejects tampered data via answerCallbackQuery with an alert', async () => {
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = { bindingStore: makeMockStore(), signingKey: SIGNING_KEY, botApi };
    const good = buildBindCallbackData('confirm', 'code-xyz', SIGNING_KEY);
    const tampered = good.slice(0, -3) + 'AAA';
    const update = makeUpdate(tampered);

    const res = await handleBindCallback({ deps, update, avatarId: 'a1' });
    expect(res.handled).toBe(true);
    expect(botApi.answerCallbackQuery).toHaveBeenCalledTimes(1);
    const extra = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(extra.show_alert).toBe(true);
    // Nothing was written.
    expect(deps.bindingStore.consumeBindCode).not.toHaveBeenCalled();
  });

  it('confirm path consumes the code with the tapper ID and edits the message', async () => {
    const consumeBindCode = mock(async () => ({
      pk: 'AVATAR#a1',
      sk: 'TELEGRAM_OWNER_BINDING',
      avatarId: 'a1',
      telegramUserId: '42',
      telegramUsername: 'alice',
      boundAt: 1700000000000,
    }));
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = {
      bindingStore: makeMockStore({ consumeBindCode }),
      signingKey: SIGNING_KEY,
      botApi,
    };

    const data = buildBindCallbackData('confirm', 'code-xyz', SIGNING_KEY);
    const update = makeUpdate(data, 42, 'alice');

    const res = await handleBindCallback({ deps, update, avatarId: 'a1' });
    expect(res.handled).toBe(true);
    expect(consumeBindCode).toHaveBeenCalledTimes(1);
    const call = consumeBindCode.mock.calls[0]![0] as { code: string; telegramUserId: string; telegramUsername: string };
    expect(call.code).toBe('code-xyz');
    expect(call.telegramUserId).toBe('42');
    expect(call.telegramUsername).toBe('alice');

    // Message was edited in place (no new message posted).
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('confirm path on an expired/already-consumed code shows "expired" message', async () => {
    const consumeBindCode = mock(async () => null);
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = {
      bindingStore: makeMockStore({ consumeBindCode }),
      signingKey: SIGNING_KEY,
      botApi,
    };

    const data = buildBindCallbackData('confirm', 'code-old', SIGNING_KEY);
    const update = makeUpdate(data);

    await handleBindCallback({ deps, update, avatarId: 'a1' });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const [,, text] = botApi.editMessageText.mock.calls[0]!;
    expect(String(text)).toMatch(/expired|already used/i);
    const alertCall = botApi.answerCallbackQuery.mock.calls[0]![1] as { show_alert: boolean };
    expect(alertCall.show_alert).toBe(true);
  });

  it('cancel path does not consume and edits to "cancelled"', async () => {
    const consumeBindCode = mock(async () => null);
    const botApi = makeMockBot();
    const deps: BindHandlerDeps = {
      bindingStore: makeMockStore({ consumeBindCode }),
      signingKey: SIGNING_KEY,
      botApi,
    };

    const data = buildBindCallbackData('cancel', 'code-xyz', SIGNING_KEY);
    const update = makeUpdate(data);

    await handleBindCallback({ deps, update, avatarId: 'a1' });

    expect(consumeBindCode).not.toHaveBeenCalled();
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const [,, text] = botApi.editMessageText.mock.calls[0]!;
    expect(String(text)).toMatch(/cancelled/i);
  });
});
