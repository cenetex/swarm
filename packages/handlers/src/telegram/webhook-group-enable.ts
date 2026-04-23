/**
 * Telegram Group Enablement via Inline Keyboard (#1472).
 *
 * Second step of the Telegram-native redesign (#1470). When the bot is added
 * to a group, we post a single message with two buttons:
 *   [✅ Enable here]  [🚪 Leave]
 * Only the bound owner's taps count — a non-owner tap gets a Telegram
 * alert toast and changes nothing. Tap Enable → chat is added to
 * `allowedChats`, message is edited to `✅ Enabled · [🚫 Disable]`. Tap
 * Disable → chat is removed, message flips to `🚫 Disabled · [✅ Re-enable]`.
 * Tap Leave → bot calls `leaveChat` on the group.
 *
 * Until Enable is tapped, the chat is not in `allowedChats` and the existing
 * webhook gate in `webhook-chat-access.ts` silently drops all messages.
 */
import type { Update } from 'grammy/types';
import {
  logger,
  signCallbackData,
  verifyCallbackData,
  createTelegramBindingStore,
  type TelegramBindingStore,
} from '@swarm/core';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AvatarConfig } from '@swarm/core';

// Short action verbs keep the callback_data small (Telegram cap = 64 bytes).
export const GROUP_ACTION_ENABLE = 'g:en';
export const GROUP_ACTION_DISABLE = 'g:dis';
export const GROUP_ACTION_LEAVE = 'g:lv';

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
  leaveChat: (chatId: number) => Promise<unknown>;
  deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
}

interface StateService {
  saveAvatarConfig: (config: AvatarConfig) => Promise<void>;
}

export interface GroupEnableDeps {
  bindingStore: TelegramBindingStore;
  signingKey: string;
  botApi: BotApi;
  stateService: StateService;
}

export function createGroupEnableHandler(params: {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  signingKey: string;
  botApi: BotApi;
  stateService: StateService;
}): GroupEnableDeps {
  return {
    bindingStore: createTelegramBindingStore({
      dynamoClient: params.dynamoClient,
      tableName: params.tableName,
    }),
    signingKey: params.signingKey,
    botApi: params.botApi,
    stateService: params.stateService,
  };
}

/**
 * Build signed callback_data for a group action. `chatId` is negative for
 * supergroups (~13–14 digits); total signed length stays well under 64 bytes.
 */
export function buildGroupCallbackData(
  action: 'enable' | 'disable' | 'leave',
  chatId: string | number,
  signingKey: string,
): string {
  const verb =
    action === 'enable' ? GROUP_ACTION_ENABLE :
    action === 'disable' ? GROUP_ACTION_DISABLE :
    GROUP_ACTION_LEAVE;
  return signCallbackData(`${verb}:${chatId}`, signingKey);
}

/** Inline keyboard shown when the bot is first added — owner hasn't decided yet. */
export function buildPendingEnableKeyboard(chatId: string | number, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Enable here', callback_data: buildGroupCallbackData('enable', chatId, signingKey) },
      { text: '🚪 Leave', callback_data: buildGroupCallbackData('leave', chatId, signingKey) },
    ]],
  };
}

/** Inline keyboard shown after the owner has enabled the chat. */
export function buildEnabledKeyboard(chatId: string | number, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '🚫 Disable', callback_data: buildGroupCallbackData('disable', chatId, signingKey) },
    ]],
  };
}

/** Inline keyboard shown after the owner has disabled the chat. */
export function buildDisabledKeyboard(chatId: string | number, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Re-enable', callback_data: buildGroupCallbackData('enable', chatId, signingKey) },
    ]],
  };
}

/**
 * Post the pending-enablement keyboard when the bot is added to a group.
 * Caller is responsible for deciding when to invoke — typically on
 * `my_chat_member` where `new_chat_member.status` is `member` or `administrator`.
 *
 * If no owner binding exists for the avatar, posts a "setup incomplete"
 * message with no buttons so the group is aware the bot is not yet usable
 * and cannot leak the avatarId.
 */
export async function postGroupEnablementKeyboard(params: {
  deps: GroupEnableDeps;
  chatId: number;
  chatTitle?: string;
  botUsername?: string;
  avatarId: string;
}): Promise<void> {
  const { deps, chatId, chatTitle, botUsername, avatarId } = params;

  const binding = await deps.bindingStore.getOwnerBinding(avatarId);
  if (!binding) {
    await deps.botApi.sendMessage(
      chatId,
      "This bot's owner hasn't finished setting it up yet. Once they link their Telegram account, they can enable me here.",
    ).catch(() => {});
    logger.info('Group enablement posted unbound-owner notice', {
      event: 'telegram_group_enable_no_binding',
      avatarId,
      chatId: String(chatId),
    });
    return;
  }

  const ownerMention = binding.telegramUsername ? `@${binding.telegramUsername}` : 'the bot owner';
  const title = chatTitle ? ` in **${chatTitle.replace(/\*/g, '')}**` : '';
  const self = botUsername ? `@${botUsername}` : 'this bot';

  await deps.botApi.sendMessage(
    chatId,
    [
      `Hi — I'm ${self}. Only ${ownerMention} can enable me${title}.`,
      '',
      "Until enabled, I'll stay silent here.",
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: buildPendingEnableKeyboard(chatId, deps.signingKey),
    },
  );

  logger.info('Posted Telegram group enablement keyboard', {
    event: 'telegram_group_enable_prompt_posted',
    avatarId,
    chatId: String(chatId),
  });
}

/**
 * Remove a chat from the avatar's `allowedChats`. Used when the bot is
 * kicked or leaves a group — the web dashboard stays the safety net, but
 * we also proactively drop the entry so responses stop immediately.
 */
export async function revokeChatFromAllowedList(params: {
  avatarConfig: AvatarConfig;
  chatId: string;
  stateService: StateService;
}): Promise<boolean> {
  const { avatarConfig, chatId, stateService } = params;
  const telegramCfg = avatarConfig.platforms.telegram;
  if (!telegramCfg) return false;

  const existing = telegramCfg.allowedChats ?? [];
  const filtered = existing.filter(c => String(c.chatId) !== String(chatId));
  if (filtered.length === existing.length) return false;

  await stateService.saveAvatarConfig({
    ...avatarConfig,
    platforms: {
      ...avatarConfig.platforms,
      telegram: { ...telegramCfg, allowedChats: filtered },
    },
  });
  return true;
}

/**
 * Handle a callback_query for a group enable/disable/leave tap. Returns
 * `{ handled: true }` if the data matched one of our prefixes (even on
 * auth-fail or signature-fail). Caller should short-circuit and not pass
 * to the next handler.
 */
export async function handleGroupEnableCallback(params: {
  deps: GroupEnableDeps;
  update: Update;
  avatarId: string;
  avatarConfig: AvatarConfig;
}): Promise<{ handled: boolean }> {
  const { deps, update, avatarId, avatarConfig } = params;
  const cb = update.callback_query;
  if (!cb || !cb.data) return { handled: false };

  const prefixes = [GROUP_ACTION_ENABLE, GROUP_ACTION_DISABLE, GROUP_ACTION_LEAVE];
  if (!prefixes.some(p => cb.data!.startsWith(`${p}:`))) {
    return { handled: false };
  }

  const verify = verifyCallbackData(cb.data, deps.signingKey);
  if (!verify.ok || !verify.payload) {
    logger.warn('Rejecting tampered Telegram group callback', {
      event: 'telegram_group_callback_rejected',
      reason: verify.reason,
      avatarId,
    });
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: 'This button is no longer valid.',
      show_alert: true,
    });
    return { handled: true };
  }

  // Owner check.
  const binding = await deps.bindingStore.getOwnerBinding(avatarId);
  if (!binding) {
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: "This bot has no owner linked yet — setup isn't complete.",
      show_alert: true,
    });
    return { handled: true };
  }
  if (String(cb.from.id) !== binding.telegramUserId) {
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: 'Only the bot owner can do this.',
      show_alert: true,
    });
    return { handled: true };
  }

  // Payload: `<verb>:<sub>:<chatId>` (e.g. `g:en:-1001234567890`).
  const parts = verify.payload.split(':');
  if (parts.length < 3) {
    await deps.botApi.answerCallbackQuery(cb.id, { text: 'Malformed action.' });
    return { handled: true };
  }
  const verb = `${parts[0]}:${parts[1]}`;
  const targetChatId = parts.slice(2).join(':'); // rejoin defensively
  const messageChatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  const telegramCfg = avatarConfig.platforms.telegram;
  const currentChats = telegramCfg?.allowedChats ?? [];

  if (verb === GROUP_ACTION_ENABLE) {
    const already = currentChats.some(c => String(c.chatId) === targetChatId);
    if (!already) {
      const chatTitle = cb.message?.chat && 'title' in cb.message.chat ? (cb.message.chat as { title?: string }).title : undefined;
      const chatUsername = cb.message?.chat && 'username' in cb.message.chat ? (cb.message.chat as { username?: string }).username : undefined;
      await deps.stateService.saveAvatarConfig({
        ...avatarConfig,
        platforms: {
          ...avatarConfig.platforms,
          telegram: {
            ...telegramCfg!,
            allowedChats: [...currentChats, { chatId: targetChatId, title: chatTitle, username: chatUsername }],
          },
        },
      });
    }
    if (messageChatId && messageId) {
      await deps.botApi.editMessageText(
        messageChatId,
        messageId,
        `✅ Enabled. I'll respond here now. Owner can disable from this message.`,
        { reply_markup: buildEnabledKeyboard(targetChatId, deps.signingKey) },
      ).catch(() => {});
    }
    await deps.botApi.answerCallbackQuery(cb.id, { text: 'Enabled.' });
    logger.info('Telegram group enabled', {
      event: 'telegram_group_enabled',
      avatarId,
      chatId: targetChatId,
      actor: binding.telegramUserId,
    });
    return { handled: true };
  }

  if (verb === GROUP_ACTION_DISABLE) {
    const filtered = currentChats.filter(c => String(c.chatId) !== targetChatId);
    if (filtered.length !== currentChats.length) {
      await deps.stateService.saveAvatarConfig({
        ...avatarConfig,
        platforms: {
          ...avatarConfig.platforms,
          telegram: { ...telegramCfg!, allowedChats: filtered },
        },
      });
    }
    if (messageChatId && messageId) {
      await deps.botApi.editMessageText(
        messageChatId,
        messageId,
        `🚫 Disabled. I'll stay silent here. Owner can re-enable from this message.`,
        { reply_markup: buildDisabledKeyboard(targetChatId, deps.signingKey) },
      ).catch(() => {});
    }
    await deps.botApi.answerCallbackQuery(cb.id, { text: 'Disabled.' });
    logger.info('Telegram group disabled', {
      event: 'telegram_group_disabled',
      avatarId,
      chatId: targetChatId,
      actor: binding.telegramUserId,
    });
    return { handled: true };
  }

  if (verb === GROUP_ACTION_LEAVE) {
    // Remove from allowedChats first (so if leaveChat succeeds we don't
    // also continue routing messages from it) and then instruct the bot
    // to exit. Message deletion is best-effort — the bot may lose send
    // privileges the moment it leaves.
    const filtered = currentChats.filter(c => String(c.chatId) !== targetChatId);
    if (filtered.length !== currentChats.length) {
      await deps.stateService.saveAvatarConfig({
        ...avatarConfig,
        platforms: {
          ...avatarConfig.platforms,
          telegram: { ...telegramCfg!, allowedChats: filtered },
        },
      });
    }
    await deps.botApi.answerCallbackQuery(cb.id, { text: 'Leaving…' });
    if (messageChatId && messageId) {
      await deps.botApi.deleteMessage(messageChatId, messageId).catch(() => {});
    }
    try {
      await deps.botApi.leaveChat(Number(targetChatId));
    } catch (err) {
      logger.warn('Telegram leaveChat failed', {
        event: 'telegram_leave_chat_failed',
        avatarId,
        chatId: targetChatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('Telegram bot left group via inline keyboard', {
      event: 'telegram_group_left',
      avatarId,
      chatId: targetChatId,
      actor: binding.telegramUserId,
    });
    return { handled: true };
  }

  return { handled: true };
}
