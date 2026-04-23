/**
 * Telegram DM Approval webhook handlers (#1473).
 *
 * Replaces the "paste allowed @usernames into the web form" model with an
 * owner-mediated gate: when a stranger DMs the bot, the bot DMs the
 * **owner** with `[✅ Allow] [🚫 Deny] [🔕 Block]` inline buttons. The
 * requester sees a holding message until the owner taps. Owner taps flip
 * the avatar's `allowedDmUsers` list. Deny is framed generically to the
 * requester so the owner's decision isn't exposed.
 *
 * Auth guardrails:
 *  - Callback_data is HMAC-signed with the per-avatar webhook secret.
 *  - Only the bound owner (from #1471) may act on pending approvals.
 *  - Tampered or non-owner taps → answerCallbackQuery alert, no change.
 *
 * State:
 *  - Pending records live 24h (`TELEGRAM_DM_PENDING#{requesterId}`).
 *  - Blocks are persistent (`TELEGRAM_BLOCKED#{requesterId}`) and prevent
 *    future notifications to the owner.
 */
import type { Update } from 'grammy/types';
import {
  logger,
  escapeHtml,
  signCallbackData,
  verifyCallbackData,
  createTelegramBindingStore,
  createTelegramDmApprovalStore,
  type AvatarConfig,
  type TelegramBindingStore,
  type TelegramDmApprovalStore,
} from '@swarm/core';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const DM_ACTION_ALLOW = 'd:al';
export const DM_ACTION_DENY = 'd:dn';
export const DM_ACTION_BLOCK = 'd:bk';
export const DM_ACTION_REVOKE = 'd:rv';
export const DM_ACTION_UNDO = 'd:un';
export const DM_ACTION_UNBLOCK = 'd:ub';

const ALL_DM_ACTIONS = [
  DM_ACTION_ALLOW,
  DM_ACTION_DENY,
  DM_ACTION_BLOCK,
  DM_ACTION_REVOKE,
  DM_ACTION_UNDO,
  DM_ACTION_UNBLOCK,
] as const;

interface BotApi {
  sendMessage: (
    chatId: number,
    text: string,
    extra?: Record<string, unknown>,
  ) => Promise<{ message_id: number }>;
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

interface StateService {
  saveAvatarConfig: (config: AvatarConfig) => Promise<void>;
}

export interface DmApprovalDeps {
  bindingStore: TelegramBindingStore;
  approvalStore: TelegramDmApprovalStore;
  signingKey: string;
  botApi: BotApi;
  stateService: StateService;
}

export function createDmApprovalHandler(params: {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  signingKey: string;
  botApi: BotApi;
  stateService: StateService;
}): DmApprovalDeps {
  return {
    bindingStore: createTelegramBindingStore({
      dynamoClient: params.dynamoClient,
      tableName: params.tableName,
    }),
    approvalStore: createTelegramDmApprovalStore({
      dynamoClient: params.dynamoClient,
      tableName: params.tableName,
    }),
    signingKey: params.signingKey,
    botApi: params.botApi,
    stateService: params.stateService,
  };
}

export function buildDmCallbackData(
  action: 'allow' | 'deny' | 'block' | 'revoke' | 'undo' | 'unblock',
  requesterId: string | number,
  signingKey: string,
): string {
  const verb =
    action === 'allow' ? DM_ACTION_ALLOW :
    action === 'deny' ? DM_ACTION_DENY :
    action === 'block' ? DM_ACTION_BLOCK :
    action === 'revoke' ? DM_ACTION_REVOKE :
    action === 'undo' ? DM_ACTION_UNDO :
    DM_ACTION_UNBLOCK;
  return signCallbackData(`${verb}:${requesterId}`, signingKey);
}

function pendingKeyboard(requesterId: string, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Allow', callback_data: buildDmCallbackData('allow', requesterId, signingKey) },
      { text: '🚫 Deny', callback_data: buildDmCallbackData('deny', requesterId, signingKey) },
      { text: '🔕 Block', callback_data: buildDmCallbackData('block', requesterId, signingKey) },
    ]],
  };
}

function allowedKeyboard(requesterId: string, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '🚫 Revoke', callback_data: buildDmCallbackData('revoke', requesterId, signingKey) },
    ]],
  };
}

function deniedKeyboard(requesterId: string, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '↩️ Undo (allow)', callback_data: buildDmCallbackData('undo', requesterId, signingKey) },
    ]],
  };
}

function blockedKeyboard(requesterId: string, signingKey: string) {
  return {
    inline_keyboard: [[
      { text: '↩️ Unblock', callback_data: buildDmCallbackData('unblock', requesterId, signingKey) },
    ]],
  };
}

/**
 * Holding message shown to the requester. Intentionally generic so the
 * owner's eventual decision (or silence) doesn't leak.
 */
const HOLDING_MESSAGE = "Thanks — waiting for the bot owner to let you in. You'll hear from me once they do.";

/**
 * Requester-facing approval confirmation.
 */
const APPROVED_MESSAGE = 'Approved — say hi!';

/**
 * Requester-facing denial copy. Frames as "not open yet" so the owner's
 * active denial isn't exposed (preserves plausibility).
 */
const DENIED_MESSAGE = "The bot owner hasn't opened this up yet.";

export interface StrangerDmInput {
  avatarId: string;
  avatarConfig: AvatarConfig;
  /** Requester's Telegram numeric user ID as string. */
  requesterId: string;
  requesterUsername?: string;
  requesterDisplayName?: string;
  /** The DM chat ID (same as requester ID in a DM). */
  requesterChatId: number;
  /** Truncated preview of the first message. */
  firstMessage: string;
}

/**
 * Handle a DM from a user not currently on the allowlist. Returns one of:
 *  - { status: 'dropped_blocked' } — requester is on the blocklist; drop silently.
 *  - { status: 'dropped_pending' } — already pending; dedupe (don't re-notify).
 *  - { status: 'unbound_owner' } — no owner bound yet; caller should fall back
 *    to the existing redirect.
 *  - { status: 'notified' } — holding + owner DM sent, pending record written.
 *  - { status: 'owner_unreachable', reason } — owner DM failed (e.g. blocked).
 */
export async function handleStrangerDm(params: {
  deps: DmApprovalDeps;
  input: StrangerDmInput;
}): Promise<{
  status: 'dropped_blocked' | 'dropped_pending' | 'unbound_owner' | 'notified' | 'owner_unreachable';
  reason?: string;
}> {
  const { deps, input } = params;
  const { avatarId, requesterId, requesterUsername, requesterDisplayName, requesterChatId, firstMessage } = input;

  if (await deps.approvalStore.isBlocked(avatarId, requesterId)) {
    logger.debug('Dropping DM from blocked Telegram user', {
      event: 'telegram_dm_blocked_drop',
      avatarId,
    });
    return { status: 'dropped_blocked' };
  }

  if (await deps.approvalStore.getPendingDm(avatarId, requesterId)) {
    logger.debug('Telegram DM already pending approval; deduping', {
      event: 'telegram_dm_pending_dedupe',
      avatarId,
    });
    return { status: 'dropped_pending' };
  }

  const binding = await deps.bindingStore.getOwnerBinding(avatarId);
  if (!binding) {
    return { status: 'unbound_owner' };
  }

  // Holding message to the requester.
  let holding;
  try {
    holding = await deps.botApi.sendMessage(requesterChatId, HOLDING_MESSAGE);
  } catch (err) {
    logger.warn('Failed to send holding message to Telegram DM requester', {
      event: 'telegram_dm_holding_send_failed',
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'owner_unreachable', reason: 'holding_send_failed' };
  }

  // Owner notification.
  const identity = requesterUsername ? `@${escapeHtml(requesterUsername)}` : escapeHtml(requesterDisplayName || `user ${requesterId}`);
  const preview = escapeHtml(firstMessage).slice(0, 200);
  const ownerText = [
    `<b>New DM request</b>`,
    `${identity} wants to DM your bot.`,
    '',
    `<i>First message:</i> ${preview || '<i>(empty / media)</i>'}`,
  ].join('\n');

  let ownerDm;
  try {
    ownerDm = await deps.botApi.sendMessage(
      Number(binding.telegramUserId),
      ownerText,
      {
        parse_mode: 'HTML',
        reply_markup: pendingKeyboard(requesterId, deps.signingKey),
      },
    );
  } catch (err) {
    // Most likely: owner blocked the bot or never DM'd it. Rolling back the
    // holding message so the requester doesn't see a dangling "waiting" state.
    logger.warn('Failed to DM Telegram owner for DM approval', {
      event: 'telegram_dm_owner_notify_failed',
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await deps.botApi.editMessageText(
        requesterChatId,
        (holding as { message_id: number }).message_id,
        "This bot isn't set up yet — check back later.",
      );
    } catch { /* best-effort */ }
    return { status: 'owner_unreachable', reason: 'owner_notify_failed' };
  }

  await deps.approvalStore.createPendingDm({
    avatarId,
    requesterId,
    requesterUsername,
    requesterDisplayName,
    holdingMessageId: (holding as { message_id: number }).message_id,
    ownerMessageId: (ownerDm as { message_id: number }).message_id,
    firstMessage,
  });

  logger.info('Queued Telegram DM for owner approval', {
    event: 'telegram_dm_approval_queued',
    avatarId,
  });

  return { status: 'notified' };
}

/**
 * Handle an owner tap on an approval button. Returns `{ handled: true }`
 * if the callback_data matched one of our prefixes.
 */
export async function handleDmApprovalCallback(params: {
  deps: DmApprovalDeps;
  update: Update;
  avatarId: string;
  avatarConfig: AvatarConfig;
}): Promise<{ handled: boolean }> {
  const { deps, update, avatarId, avatarConfig } = params;
  const cb = update.callback_query;
  if (!cb || !cb.data) return { handled: false };

  const matched = ALL_DM_ACTIONS.some(p => cb.data!.startsWith(`${p}:`));
  if (!matched) return { handled: false };

  const verify = verifyCallbackData(cb.data, deps.signingKey);
  if (!verify.ok || !verify.payload) {
    logger.warn('Rejecting tampered Telegram DM approval callback', {
      event: 'telegram_dm_callback_rejected',
      reason: verify.reason,
      avatarId,
    });
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: 'This button is no longer valid.',
      show_alert: true,
    });
    return { handled: true };
  }

  const binding = await deps.bindingStore.getOwnerBinding(avatarId);
  if (!binding) {
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: "This bot has no owner linked yet.",
      show_alert: true,
    });
    return { handled: true };
  }
  if (String(cb.from.id) !== binding.telegramUserId) {
    await deps.botApi.answerCallbackQuery(cb.id, {
      text: 'Only the bot owner can approve DM requests.',
      show_alert: true,
    });
    return { handled: true };
  }

  const parts = verify.payload.split(':');
  if (parts.length < 3) {
    await deps.botApi.answerCallbackQuery(cb.id, { text: 'Malformed action.' });
    return { handled: true };
  }
  const verb = `${parts[0]}:${parts[1]}`;
  const requesterId = parts.slice(2).join(':');
  const ownerChatId = cb.message?.chat.id;
  const ownerMessageId = cb.message?.message_id;

  if (verb === DM_ACTION_ALLOW || verb === DM_ACTION_UNDO) {
    return handleAllow({ deps, avatarId, avatarConfig, requesterId, ownerChatId, ownerMessageId, callbackId: cb.id });
  }
  if (verb === DM_ACTION_DENY) {
    return handleDeny({ deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId: cb.id });
  }
  if (verb === DM_ACTION_BLOCK) {
    return handleBlock({ deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId: cb.id });
  }
  if (verb === DM_ACTION_REVOKE) {
    return handleRevoke({ deps, avatarId, avatarConfig, requesterId, ownerChatId, ownerMessageId, callbackId: cb.id });
  }
  if (verb === DM_ACTION_UNBLOCK) {
    return handleUnblock({ deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId: cb.id });
  }

  return { handled: true };
}

async function handleAllow(params: {
  deps: DmApprovalDeps;
  avatarId: string;
  avatarConfig: AvatarConfig;
  requesterId: string;
  ownerChatId?: number;
  ownerMessageId?: number;
  callbackId: string;
}): Promise<{ handled: true }> {
  const { deps, avatarId, avatarConfig, requesterId, ownerChatId, ownerMessageId, callbackId } = params;

  const pending = await deps.approvalStore.getPendingDm(avatarId, requesterId);

  const telegramCfg = avatarConfig.platforms.telegram;
  const existing = telegramCfg?.allowedDmUsers ?? [];
  if (!existing.some(u => String(u.userId) === requesterId)) {
    await deps.stateService.saveAvatarConfig({
      ...avatarConfig,
      platforms: {
        ...avatarConfig.platforms,
        telegram: {
          ...telegramCfg!,
          allowedDmUsers: [
            ...existing,
            {
              userId: requesterId,
              username: pending?.requesterUsername,
              displayName: pending?.requesterDisplayName,
            },
          ],
        },
      },
    });
  }

  // Edit owner's message and requester's holding message in parallel.
  const label = pending?.requesterUsername ? `@${pending.requesterUsername}` : `user ${requesterId}`;
  const edits: Array<Promise<unknown>> = [];
  if (ownerChatId && ownerMessageId) {
    edits.push(
      deps.botApi.editMessageText(
        ownerChatId,
        ownerMessageId,
        `✅ Allowed ${label}.`,
        { reply_markup: allowedKeyboard(requesterId, deps.signingKey) },
      ).catch(() => {}),
    );
  }
  if (pending) {
    edits.push(
      deps.botApi.editMessageText(
        Number(pending.requesterId),
        pending.holdingMessageId,
        APPROVED_MESSAGE,
      ).catch(() => {}),
    );
  }
  await Promise.all(edits);
  await deps.approvalStore.deletePendingDm(avatarId, requesterId);
  await deps.botApi.answerCallbackQuery(callbackId, { text: 'Allowed.' });
  logger.info('Telegram DM approved', { event: 'telegram_dm_allowed', avatarId });
  return { handled: true };
}

async function handleDeny(params: {
  deps: DmApprovalDeps;
  avatarId: string;
  requesterId: string;
  ownerChatId?: number;
  ownerMessageId?: number;
  callbackId: string;
}): Promise<{ handled: true }> {
  const { deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId } = params;
  const pending = await deps.approvalStore.getPendingDm(avatarId, requesterId);
  const label = pending?.requesterUsername ? `@${pending.requesterUsername}` : `user ${requesterId}`;

  const edits: Array<Promise<unknown>> = [];
  if (ownerChatId && ownerMessageId) {
    edits.push(
      deps.botApi.editMessageText(
        ownerChatId,
        ownerMessageId,
        `🚫 Denied ${label}.`,
        { reply_markup: deniedKeyboard(requesterId, deps.signingKey) },
      ).catch(() => {}),
    );
  }
  if (pending) {
    edits.push(
      deps.botApi.editMessageText(
        Number(pending.requesterId),
        pending.holdingMessageId,
        DENIED_MESSAGE,
      ).catch(() => {}),
    );
  }
  await Promise.all(edits);
  await deps.approvalStore.deletePendingDm(avatarId, requesterId);
  await deps.botApi.answerCallbackQuery(callbackId, { text: 'Denied.' });
  logger.info('Telegram DM denied', { event: 'telegram_dm_denied', avatarId });
  return { handled: true };
}

async function handleBlock(params: {
  deps: DmApprovalDeps;
  avatarId: string;
  requesterId: string;
  ownerChatId?: number;
  ownerMessageId?: number;
  callbackId: string;
}): Promise<{ handled: true }> {
  const { deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId } = params;
  const pending = await deps.approvalStore.getPendingDm(avatarId, requesterId);
  const label = pending?.requesterUsername ? `@${pending.requesterUsername}` : `user ${requesterId}`;

  await deps.approvalStore.addBlocked({
    avatarId,
    requesterId,
    requesterUsername: pending?.requesterUsername,
  });

  const edits: Array<Promise<unknown>> = [];
  if (ownerChatId && ownerMessageId) {
    edits.push(
      deps.botApi.editMessageText(
        ownerChatId,
        ownerMessageId,
        `🔕 Blocked ${label}. Further DMs from them will be silently dropped.`,
        { reply_markup: blockedKeyboard(requesterId, deps.signingKey) },
      ).catch(() => {}),
    );
  }
  if (pending) {
    edits.push(
      deps.botApi.editMessageText(
        Number(pending.requesterId),
        pending.holdingMessageId,
        DENIED_MESSAGE,
      ).catch(() => {}),
    );
  }
  await Promise.all(edits);
  await deps.approvalStore.deletePendingDm(avatarId, requesterId);
  await deps.botApi.answerCallbackQuery(callbackId, { text: 'Blocked.' });
  logger.info('Telegram DM sender blocked', { event: 'telegram_dm_blocked', avatarId });
  return { handled: true };
}

async function handleRevoke(params: {
  deps: DmApprovalDeps;
  avatarId: string;
  avatarConfig: AvatarConfig;
  requesterId: string;
  ownerChatId?: number;
  ownerMessageId?: number;
  callbackId: string;
}): Promise<{ handled: true }> {
  const { deps, avatarId, avatarConfig, requesterId, ownerChatId, ownerMessageId, callbackId } = params;
  const telegramCfg = avatarConfig.platforms.telegram;
  const existing = telegramCfg?.allowedDmUsers ?? [];
  const filtered = existing.filter(u => String(u.userId) !== requesterId);
  if (filtered.length !== existing.length) {
    await deps.stateService.saveAvatarConfig({
      ...avatarConfig,
      platforms: {
        ...avatarConfig.platforms,
        telegram: { ...telegramCfg!, allowedDmUsers: filtered },
      },
    });
  }

  if (ownerChatId && ownerMessageId) {
    const removed = existing.find(u => String(u.userId) === requesterId);
    const label = removed?.username ? `@${removed.username}` : `user ${requesterId}`;
    await deps.botApi.editMessageText(
      ownerChatId,
      ownerMessageId,
      `🚫 Revoked ${label}. They'll see the "not open yet" message if they DM again.`,
    ).catch(() => {});
  }
  await deps.botApi.answerCallbackQuery(callbackId, { text: 'Revoked.' });
  logger.info('Telegram DM access revoked', { event: 'telegram_dm_revoked', avatarId });
  return { handled: true };
}

async function handleUnblock(params: {
  deps: DmApprovalDeps;
  avatarId: string;
  requesterId: string;
  ownerChatId?: number;
  ownerMessageId?: number;
  callbackId: string;
}): Promise<{ handled: true }> {
  const { deps, avatarId, requesterId, ownerChatId, ownerMessageId, callbackId } = params;
  await deps.approvalStore.removeBlocked(avatarId, requesterId);
  if (ownerChatId && ownerMessageId) {
    await deps.botApi.editMessageText(
      ownerChatId,
      ownerMessageId,
      `↩️ Unblocked. If they DM the bot again I'll ask you about it.`,
    ).catch(() => {});
  }
  await deps.botApi.answerCallbackQuery(callbackId, { text: 'Unblocked.' });
  logger.info('Telegram DM sender unblocked', { event: 'telegram_dm_unblocked', avatarId });
  return { handled: true };
}
