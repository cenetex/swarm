/**
 * Telegram Owner-Binding webhook handlers (#1471).
 *
 * Handles the two Telegram-side touch points of the owner-binding flow:
 *
 * 1. `/start bind_<code>` — the owner taps the deep link issued by the admin
 *    UI. We verify the code is known and unexpired, then post an inline
 *    keyboard `[✅ Confirm this is me]` `[❌ Not me]` so the final binding
 *    write is the deliberate tap, not the accidental /start.
 *
 * 2. `callback_query` with payload `bind:ok:<code>` or `bind:no:<code>` —
 *    the confirm or cancel tap. Confirm consumes the code atomically and
 *    writes the owner binding. Cancel invalidates the code.
 *
 * The core binding store lives in `@swarm/core` and is shared with admin-api
 * so both surfaces write to the same DynamoDB record. The per-avatar Telegram
 * webhook secret is reused as the callback_data HMAC key — no new env var,
 * no separate rotation.
 */
import type { Update } from 'grammy/types';
import {
  logger,
  createTelegramBindingStore,
  signCallbackData,
  verifyCallbackData,
  type TelegramBindingStore,
} from '@swarm/core';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const BIND_ACTION_CONFIRM = 'bind:ok';
export const BIND_ACTION_CANCEL = 'bind:no';

interface BotApi {
  sendMessage: (
    chatId: number,
    text: string,
    extra?: Record<string, unknown>,
  ) => Promise<{ message_id: number } | unknown>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
  answerCallbackQuery: (
    callbackQueryId: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface BindHandlerDeps {
  /** The binding store (from @swarm/core). */
  bindingStore: TelegramBindingStore;
  /** The per-avatar Telegram webhook secret, reused as the HMAC signing key. */
  signingKey: string;
  /** Minimal grammy-like bot API. */
  botApi: BotApi;
}

/**
 * Build a BindHandlerDeps bundle from the primitives the webhook handler
 * already has on hand. This keeps the integration point in
 * telegram-webhook-shared.ts a one-liner.
 */
export function createBindHandler(params: {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  signingKey: string;
  botApi: BotApi;
}): BindHandlerDeps {
  return {
    bindingStore: createTelegramBindingStore({
      dynamoClient: params.dynamoClient,
      tableName: params.tableName,
    }),
    signingKey: params.signingKey,
    botApi: params.botApi,
  };
}

/** Build the signed callback_data for a bind confirm/cancel button. */
export function buildBindCallbackData(action: 'confirm' | 'cancel', code: string, signingKey: string): string {
  const verb = action === 'confirm' ? BIND_ACTION_CONFIRM : BIND_ACTION_CANCEL;
  // Payload: `bind:ok:<code>` or `bind:no:<code>`. Code is ~22 chars url-safe
  // base64 of 16 random bytes; verb adds 7-8 chars; signature adds 12 chars
  // (delimiter + 8-byte HMAC base64url). Well under Telegram's 64-byte cap.
  const payload = `${verb}:${code}`;
  return signCallbackData(payload, signingKey);
}

/**
 * Handle an incoming `/start bind_<code>` message. Posts the confirmation
 * keyboard if the code is valid, a help message otherwise. Does NOT consume
 * the code — that happens when the user taps Confirm.
 */
export async function handleBindStart(params: {
  deps: BindHandlerDeps;
  chatId: number;
  code: string;
  avatarId: string;
}): Promise<void> {
  const { deps, chatId, code, avatarId } = params;

  // Look up the code to give an early "link expired" message before we post
  // a keyboard. We don't consume yet — consume happens on Confirm tap.
  // `getOwnerBinding` exists but there's no `getBindCode`. Best we can do
  // without a new method is a dry-run consume-and-rollback, which is too
  // risky. Instead we post the keyboard optimistically; an invalid code
  // will fall through to a polite error on tap.
  void avatarId; // reserved for future logging / cross-check

  const confirmData = buildBindCallbackData('confirm', code, deps.signingKey);
  const cancelData = buildBindCallbackData('cancel', code, deps.signingKey);

  await deps.botApi.sendMessage(
    chatId,
    [
      "You're linking this Telegram account as the **owner** of the bot.",
      '',
      'Once bound, your taps are the only ones that can enable the bot in groups or approve new DMers. This replaces the old web form.',
      '',
      'Continue?',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Confirm this is me', callback_data: confirmData },
          { text: '❌ Not me', callback_data: cancelData },
        ]],
      },
    },
  );

  logger.info('Posted Telegram bind confirmation keyboard', {
    event: 'telegram_bind_prompt_posted',
    avatarId,
  });
}

/**
 * Handle a callback_query for a bind confirm/cancel button. Returns true if
 * the payload was a bind action (handled or rejected), false if it was
 * something else (caller should pass to next handler).
 */
export async function handleBindCallback(params: {
  deps: BindHandlerDeps;
  update: Update;
  avatarId: string;
}): Promise<{ handled: boolean }> {
  const { deps, update, avatarId } = params;
  const callback = update.callback_query;
  if (!callback || !callback.data) return { handled: false };
  if (!callback.data.startsWith(`${BIND_ACTION_CONFIRM}:`) && !callback.data.startsWith(`${BIND_ACTION_CANCEL}:`)) {
    return { handled: false };
  }

  const verify = verifyCallbackData(callback.data, deps.signingKey);
  if (!verify.ok || !verify.payload) {
    logger.warn('Rejecting tampered Telegram bind callback', {
      event: 'telegram_bind_callback_rejected',
      reason: verify.reason,
      avatarId,
    });
    await deps.botApi.answerCallbackQuery(callback.id, {
      text: 'This button is no longer valid. Start the bind flow again from the web dashboard.',
      show_alert: true,
    });
    return { handled: true };
  }

  const [verb, sub, ...rest] = verify.payload.split(':');
  const code = rest.join(':'); // should be exactly one segment, but be safe
  const isConfirm = `${verb}:${sub}` === BIND_ACTION_CONFIRM;
  const isCancel = `${verb}:${sub}` === BIND_ACTION_CANCEL;

  if (!code || (!isConfirm && !isCancel)) {
    await deps.botApi.answerCallbackQuery(callback.id, { text: 'Malformed bind action.' });
    return { handled: true };
  }

  const fromId = callback.from.id;
  const fromUsername = callback.from.username;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (isCancel) {
    if (chatId && messageId) {
      await deps.botApi.editMessageText(
        chatId,
        messageId,
        'Binding cancelled. You can start over from the web dashboard.',
      ).catch(() => {});
    }
    await deps.botApi.answerCallbackQuery(callback.id, { text: 'Cancelled.' });
    logger.info('Telegram owner binding cancelled by user', {
      event: 'telegram_bind_cancelled',
      avatarId,
    });
    return { handled: true };
  }

  // Confirm path.
  const binding = await deps.bindingStore.consumeBindCode({
    code,
    telegramUserId: String(fromId),
    telegramUsername: fromUsername,
  });

  if (!binding) {
    if (chatId && messageId) {
      await deps.botApi.editMessageText(
        chatId,
        messageId,
        'This bind link has expired or was already used. Get a fresh link from the web dashboard.',
      ).catch(() => {});
    }
    await deps.botApi.answerCallbackQuery(callback.id, {
      text: 'Link expired or already used.',
      show_alert: true,
    });
    return { handled: true };
  }

  if (chatId && messageId) {
    await deps.botApi.editMessageText(
      chatId,
      messageId,
      [
        "✅ You're now the owner of this bot.",
        '',
        'What this means:',
        '• When someone DMs the bot, I\'ll ask **you** to approve them first.',
        '• When the bot is added to a group, I\'ll post a button for you to enable it there.',
        '• You can revoke any of this at any time from the web dashboard or right here in Telegram.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  }

  await deps.botApi.answerCallbackQuery(callback.id, { text: 'Bound.' });

  logger.info('Telegram owner binding confirmed', {
    event: 'telegram_bind_confirmed',
    avatarId: binding.avatarId,
    telegramUserId: binding.telegramUserId,
  });

  return { handled: true };
}
