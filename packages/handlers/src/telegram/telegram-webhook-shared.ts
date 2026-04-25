/**
 * Shared Telegram Webhook Handler (multi-tenant)
 *
 * This is the preferred ingress path when using the shared @swarm/handlers runtime:
 * - Loads avatar config from STATE_TABLE
 * - Verifies Telegram webhook secret token (if configured)
 * - Redirects DMs (private chats) to RATi Chat onboarding
 * - Evaluates whether to respond
 * - Enqueues the message to the shared FIFO message queue
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { sendSqsMessage } from '../services/sqs-send.js';
import { processSharedRoomMessage, isSharedRoom, buildRoomKey } from '../services/room-ingress.js';
import { randomUUID } from 'crypto';
import type { Update } from 'grammy/types';
import {
  createMessageEvaluator,
  logger,
  CORRELATION_ID_ATTR,
  extractCorrelationIdFromApiEvent,
  hasValidInternalTestKey,
} from '@swarm/core';
import { getMessageFromUpdate } from '../utils/telegram-type-guards.js';
import {
  assertAvatarStillOwnedByClaimer,
  HandlerOwnershipError,
} from '../services/assert-avatar-ownership.js';

// --- Extracted modules ---
import {
  getAllowedDmUserIdsForAdmin,
  isAllowedDmUserById,
  isAllowedDmUser,
  isTelegramUserOwnerOfAvatar,
  upsertTelegramUserMapping,
  isTelegramSuperadmin,
  mergeAllowedChats,
  buildRedirectMessage,
  buildDmRedirectMessage,
  isTelegramChatAllowed,
  resolveTelegramUsername,
  type HomeChannelChecker,
} from './webhook-chat-access.js';

import {
  cleanupChannelState,
  registerHomeChannelFromWebhook,
  updateAvatarHomeChannel,
  createHomeChannelChecker,
  activateAvatarInChatFromWebhook,
  addSharedChannelMembership,
  maybeBootstrapHomeChannelFromGroupEngagement,
  getChannelRegisteredAvatars,
  resolveMentionedAvatar,
} from './webhook-home-channel.js';

import {
  initialize,
  getStateService,
  getWebhookSecret,
  verifySecretToken,
  getAvatarConfig,
  invalidateAvatarConfigCache,
  getAvatarStatus,
  getTelegramAdapter,
} from './webhook-security.js';

import {
  createBindHandler,
  handleBindCallback,
  handleBindStart,
} from './webhook-bind.js';
import {
  createGroupEnableHandler,
  handleGroupEnableCallback,
  postGroupEnablementKeyboard,
  revokeChatFromAllowedList,
} from './webhook-group-enable.js';
import {
  createDmApprovalHandler,
  handleDmApprovalCallback,
  handleStrangerDm,
} from './webhook-dm-approval.js';
import { getDynamoClient } from '../services/dynamo-client.js';

// --- Re-exports for external consumers ---
export {
  getAllowedDmUserIdsForAdmin,
  isAllowedDmUserById,
  mergeAllowedChats,
  buildDmRedirectMessage,
  isTelegramChatAllowed,
  resolveTelegramUsername,
  maybeBootstrapHomeChannelFromGroupEngagement,
  addSharedChannelMembership,
};
export type { HomeChannelChecker };


const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const ADMIN_TABLE = process.env.ADMIN_TABLE;
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;
const RUNTIME_ENV = (process.env.ENVIRONMENT || process.env.NODE_ENV || '').trim().toLowerCase();
const NFT_OWNERSHIP_ENFORCEMENT = process.env.NFT_OWNERSHIP_ENFORCEMENT === 'on';

function ok(): APIGatewayProxyResultV2 {
  return { statusCode: 200, body: 'OK' };
}

function lowerHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k.toLowerCase()] = v || '';
  }
  return out;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const avatarId = event.pathParameters?.avatarId;
  const requestId = event.requestContext.requestId;
  const correlationId = extractCorrelationIdFromApiEvent(event);

  const headers = lowerHeaders(event.headers);
  const traceId = headers['x-trace-id'] || randomUUID();

  logger.setContext({ subsystem: 'telegram', avatarId, requestId, correlationId, traceId });
  logger.info('Telegram webhook received', { event: 'request_received' });

  try {
    await initialize();
    const stateService = getStateService();

    if (!avatarId || !/^[a-zA-Z0-9_-]+$/.test(avatarId)) {
      logger.warn('Invalid avatarId');
      return ok();
    }

    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8') : Buffer.from('');

    const avatarConfig = await getAvatarConfig(avatarId);
    if (!avatarConfig?.platforms.telegram?.enabled) {
      logger.info('Telegram disabled or config missing');
      return ok();
    }

    // Check avatar status - only active avatars should process messages
    const avatarStatus = await getAvatarStatus(avatarId);
    if (avatarStatus !== 'active') {
      logger.info('Avatar not active, skipping message processing', {
        event: 'avatar_inactive',
        status: avatarStatus,
      });
      return ok();
    }

    // Check NFT ownership if enforcement is enabled
    if (NFT_OWNERSHIP_ENFORCEMENT) {
      try {
        await assertAvatarStillOwnedByClaimer({
          avatarId,
          nftMint: avatarConfig.nftMint,
          creatorWallet: avatarConfig.creatorWallet,
        });
      } catch (err) {
        if (err instanceof HandlerOwnershipError) {
          logger.info('NFT ownership check failed', {
            event: 'nft_revoked',
            code: err.code,
            avatarId,
          });
          return ok();
        }
        throw err;
      }
    }

    const telegramAdapter = await getTelegramAdapter(avatarId, avatarConfig);
    if (!telegramAdapter) {
      logger.error('Missing Telegram bot token');
      return ok();
    }

    // Verify webhook secret token.
    // Allow bypass with internal test key for E2E testing
    const bypassAuth = hasValidInternalTestKey({
      headers,
      internalTestKey: INTERNAL_TEST_KEY,
      environment: RUNTIME_ENV,
      nodeEnv: process.env.NODE_ENV,
    });

    if (!bypassAuth) {
      const webhookSecret = await getWebhookSecret(avatarId);
      if (!webhookSecret) {
        logger.error('Missing webhook secret; refusing unauthenticated Telegram request', undefined, {
          event: 'validation_error',
          reason: 'missing_webhook_secret',
          avatarId,
        });
        return { statusCode: 503, body: 'Webhook secret not configured' };
      }

      const provided = headers['x-telegram-bot-api-secret-token'];
      if (!verifySecretToken(provided, webhookSecret)) {
        logger.warn('Invalid webhook secret', { event: 'validation_error', reason: 'invalid_secret' });
        return { statusCode: 401, body: 'Unauthorized' };
      }
    }

    let update: Update;
    try {
      update = JSON.parse(body.toString()) as Update;
    } catch (err) {
      logger.warn('Invalid JSON', { event: 'parse_error', error: err instanceof Error ? err.message : String(err) });
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    // Handle bot added/removed from channel (my_chat_member update)
    if (update.my_chat_member) {
      const myChatMember = update.my_chat_member as {
        chat?: {
          id?: number;
          type?: string;
          username?: string;
          title?: string;
        };
        new_chat_member?: { status?: string };
      };
      const newStatus = myChatMember.new_chat_member?.status;
      const chatId = myChatMember.chat?.id;
      const chatUsername = myChatMember.chat?.username;
      const chatTitle = myChatMember.chat?.title;
      const chatType = myChatMember.chat?.type;

      // Bot was ADDED to a group/supergroup/channel
      if (chatId && (newStatus === 'member' || newStatus === 'administrator')) {
        // Only auto-register for groups, supergroups, channels (not private chats)
        if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
          const botUsername = avatarConfig.platforms.telegram?.botUsername || '';

          // #1472 — post the signed inline-keyboard enablement prompt for
          // groups/supergroups (channels use a different moderation model
          // that's out of scope for this redesign). Until the owner taps
          // Enable, the chat is not added to allowedChats and the existing
          // webhook gate silently drops all messages.
          if (chatType === 'group' || chatType === 'supergroup') {
            try {
              const groupSigningKey = await getWebhookSecret(avatarId);
              const bot = telegramAdapter.getBot();
              if (groupSigningKey && ADMIN_TABLE && bot) {
                const groupDeps = createGroupEnableHandler({
                  dynamoClient: getDynamoClient(),
                  tableName: ADMIN_TABLE,
                  signingKey: groupSigningKey,
                  botApi: {
                    sendMessage: (cid, text, extra) => bot.api.sendMessage(cid, text, extra as Parameters<typeof bot.api.sendMessage>[2]),
                    editMessageText: (cid, mid, text, extra) => bot.api.editMessageText(cid, mid, text, extra as Parameters<typeof bot.api.editMessageText>[3]),
                    answerCallbackQuery: (id, extra) => bot.api.answerCallbackQuery(id, extra as Parameters<typeof bot.api.answerCallbackQuery>[1]),
                    leaveChat: (cid) => bot.api.leaveChat(cid),
                    deleteMessage: (cid, mid) => bot.api.deleteMessage(cid, mid),
                  },
                  stateService: getStateService(),
                });
                await postGroupEnablementKeyboard({
                  deps: groupDeps,
                  chatId,
                  chatTitle,
                  botUsername,
                  avatarId,
                });
              }
            } catch (err) {
              logger.warn('Failed to post Telegram group enablement keyboard', {
                event: 'telegram_group_enable_prompt_failed',
                avatarId,
                chatId: String(chatId),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Special-case @ratibots: treat as a global home channel so *all* bots can work there,
          // but do not set it as the bot's own homeChannelId.
          if (chatUsername?.toLowerCase() === 'ratibots') {
            if (ADMIN_TABLE && botUsername) {
              try {
                await registerHomeChannelFromWebhook(
                  avatarId,
                  String(chatId),
                  botUsername,
                  chatUsername,
                  chatTitle
                );

                logger.info('Registered @ratibots as global home channel', {
                  event: 'ratibots_registered',
                  avatarId,
                  chatId: String(chatId),
                  chatUsername,
                  chatTitle,
                });
              } catch (err) {
                logger.warn('Failed to register @ratibots as global home channel', {
                  event: 'ratibots_register_failed',
                  avatarId,
                  chatId: String(chatId),
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            return ok();
          }

          // Check if avatar already has a home channel configured
          const hasHomeChannel = Boolean(avatarConfig.platforms.telegram?.homeChannelId);

          if (!hasHomeChannel && ADMIN_TABLE && botUsername) {
            try {
              // Register as home channel
              await registerHomeChannelFromWebhook(
                avatarId,
                String(chatId),
                botUsername,
                chatUsername,
                chatTitle
              );

              // Update avatar config with home channel info
              await updateAvatarHomeChannel(
                avatarId,
                String(chatId),
                chatUsername,
                chatTitle
              );

              // Invalidate config cache after update
              invalidateAvatarConfigCache(avatarId);

              logger.info('Auto-registered home channel', {
                event: 'home_channel_auto_registered',
                avatarId,
                chatId: String(chatId),
                chatUsername,
                chatTitle,
              });
            } catch (err) {
              logger.warn('Failed to auto-register home channel', {
                event: 'home_channel_auto_register_failed',
                avatarId,
                chatId: String(chatId),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        return ok();
      }

      // Bot was REMOVED (left or kicked), clean up channel state and the
      // allowlist entry (#1472) so we don't keep routing messages to an
      // LLM for a chat the bot can no longer reach.
      if (chatId && (newStatus === 'left' || newStatus === 'kicked')) {
        logger.info('Bot removed from channel, cleaning up state', {
          event: 'bot_removed',
          chatId: String(chatId),
          newStatus,
        });
        await cleanupChannelState(avatarId, String(chatId));
        try {
          const revoked = await revokeChatFromAllowedList({
            avatarConfig,
            chatId: String(chatId),
            stateService: getStateService(),
          });
          if (revoked) {
            invalidateAvatarConfigCache(avatarId);
            logger.info('Revoked chat from allowedChats after bot removal', {
              event: 'telegram_allowed_chat_revoked_on_removal',
              avatarId,
              chatId: String(chatId),
            });
          }
        } catch (err) {
          logger.warn('Failed to revoke allowedChats entry on bot removal', {
            event: 'telegram_allowed_chat_revoke_failed',
            avatarId,
            chatId: String(chatId),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return ok();
      }
    }

    const telegramCfg = avatarConfig.platforms.telegram;

    // Handle callback_query updates (inline button presses).
    //
    // Order matters: bind-flow callbacks (#1471) are checked first because
    // they are dispatched via signed callback_data (not the legacy admin-
    // handler action registry) and have their own authz path.
    if (update.callback_query) {
      logger.info('Callback query received', { event: 'callback_query' });

      // #1471 / #1472 — signed-callback dispatch for owner binding + group
      // enablement. Try the redesign handlers before the legacy admin-
      // handler action registry; if none of them claim the payload we fall
      // through to the legacy handler.
      try {
        const redesignSigningKey = await getWebhookSecret(avatarId);
        const bot = telegramAdapter.getBot();
        if (redesignSigningKey && ADMIN_TABLE && bot) {
          const sharedBotApi = {
            sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => bot.api.sendMessage(chatId, text, extra as Parameters<typeof bot.api.sendMessage>[2]),
            editMessageText: (chatId: number, messageId: number, text: string, extra?: Record<string, unknown>) => bot.api.editMessageText(chatId, messageId, text, extra as Parameters<typeof bot.api.editMessageText>[3]),
            answerCallbackQuery: (id: string, extra?: Record<string, unknown>) => bot.api.answerCallbackQuery(id, extra as Parameters<typeof bot.api.answerCallbackQuery>[1]),
          };

          // 1. Owner-binding confirm/cancel.
          const bindDeps = createBindHandler({
            dynamoClient: getDynamoClient(),
            tableName: ADMIN_TABLE,
            signingKey: redesignSigningKey,
            botApi: sharedBotApi,
          });
          const bindResult = await handleBindCallback({
            deps: bindDeps,
            update,
            avatarId,
          });
          if (bindResult.handled) return ok();

          // 2. Group enablement (enable / disable / leave).
          const groupDeps = createGroupEnableHandler({
            dynamoClient: getDynamoClient(),
            tableName: ADMIN_TABLE,
            signingKey: redesignSigningKey,
            botApi: {
              ...sharedBotApi,
              leaveChat: (cid: number) => bot.api.leaveChat(cid),
              deleteMessage: (cid: number, mid: number) => bot.api.deleteMessage(cid, mid),
            },
            stateService: getStateService(),
          });
          const groupResult = await handleGroupEnableCallback({
            deps: groupDeps,
            update,
            avatarId,
            avatarConfig,
          });
          if (groupResult.handled) {
            invalidateAvatarConfigCache(avatarId);
            return ok();
          }

          // 3. DM approval (allow / deny / block / revoke / undo / unblock).
          const dmDeps = createDmApprovalHandler({
            dynamoClient: getDynamoClient(),
            tableName: ADMIN_TABLE,
            signingKey: redesignSigningKey,
            botApi: sharedBotApi,
            stateService: getStateService(),
          });
          const dmResult = await handleDmApprovalCallback({
            deps: dmDeps,
            update,
            avatarId,
            avatarConfig,
          });
          if (dmResult.handled) {
            invalidateAvatarConfigCache(avatarId);
            return ok();
          }
        }
      } catch (err) {
        logger.error('Signed-callback handler error', err, { event: 'signed_callback_error', avatarId });
        // Fall through to the legacy handler rather than swallow the update.
      }

      try {
        const { processAdminCallbackQuery } = await import('../services/telegram-admin-handler.js');
        await processAdminCallbackQuery(avatarId, avatarConfig, update as unknown);
        return ok();
      } catch (err) {
        logger.error('Callback handler error', err, { event: 'callback_error' });
        return ok();
      }
    }

    const envelope = await telegramAdapter.parseMessage(update);
    if (!envelope) return ok();

    envelope.traceId = traceId;

    // /start bind_<code> flow (#1471): the owner tapped the deep link from
    // the web dashboard. Verify the tap lands in a DM, then post the signed
    // confirmation keyboard. The binding is not written until the user taps
    // Confirm on the keyboard.
    if (envelope.content.command?.command === 'start' && envelope.content.command?.args?.[0]?.startsWith('bind_')) {
      if (envelope.metadata.chatType !== 'private') {
        return ok();
      }
      const bindCode = envelope.content.command.args![0]!.slice('bind_'.length);
      if (!bindCode) return ok();

      try {
        const bindSigningKey = await getWebhookSecret(avatarId);
        const bot = telegramAdapter.getBot();
        if (bindSigningKey && ADMIN_TABLE && bot) {
          const bindDeps = createBindHandler({
            dynamoClient: getDynamoClient(),
            tableName: ADMIN_TABLE,
            signingKey: bindSigningKey,
            botApi: {
              sendMessage: (chatId, text, extra) => bot.api.sendMessage(chatId, text, extra as Parameters<typeof bot.api.sendMessage>[2]),
              editMessageText: (chatId, messageId, text, extra) => bot.api.editMessageText(chatId, messageId, text, extra as Parameters<typeof bot.api.editMessageText>[3]),
              answerCallbackQuery: (id, extra) => bot.api.answerCallbackQuery(id, extra as Parameters<typeof bot.api.answerCallbackQuery>[1]),
            },
          });
          await handleBindStart({
            deps: bindDeps,
            chatId: parseInt(envelope.conversationId),
            code: bindCode,
            avatarId,
          });
        }
      } catch (err) {
        logger.warn('Telegram bind-start handler failed', {
          event: 'telegram_bind_start_failed',
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return ok();
    }

    // /start approve_AVATAR_ID flow: deep link approval for adding users to DM allowlist
    // Format: /start approve_<avatar-id> — add sender to this avatar's allowedDmUsers
    if (envelope.content.command?.command === 'start' && envelope.content.command?.args?.[0]?.startsWith('approve_')) {
      if (envelope.metadata.chatType !== 'private') {
        return ok();
      }

      const approveAvatarId = envelope.content.command.args![0]!.split('_')[1];
      if (!approveAvatarId) {
        return ok();
      }

      const senderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
      const senderUsername = envelope.sender.username;
      const senderDisplayName = envelope.sender.displayName;

      try {
        // Get the avatar config we're approving for
        const approveConfig = await getAvatarConfig(approveAvatarId);
        if (!approveConfig || !approveConfig.platforms.telegram) {
          logger.warn('Approval avatar not found or not Telegram-enabled', {
            event: 'approve_avatar_not_found',
            avatarId: approveAvatarId,
          });
          return ok();
        }

        const approvePolicy = approveConfig.platforms.telegram.allowedDmUsers || [];
        const isAlreadyAllowed = approvePolicy.some(u => String(u.userId) === senderId);

        if (!isAlreadyAllowed) {
          // Add to allowedDmUsers
          const updatedPolicy = [...approvePolicy, { userId: senderId, username: senderUsername, displayName: senderDisplayName }];

          // Update avatar config (fire and forget, non-critical)
          try {
            await getStateService().saveAvatarConfig({
              ...approveConfig,
              platforms: {
                ...approveConfig.platforms,
                telegram: {
                  ...approveConfig.platforms.telegram!,
                  allowedDmUsers: updatedPolicy,
                },
              },
            });
            logger.info('Added user via deep link approval', {
              event: 'deep_link_approval_added',
              avatarId: approveAvatarId,
              userId: senderId,
              username: senderUsername,
            });
          } catch (err) {
            logger.warn('Failed to update avatar config with approved user', {
              event: 'deep_link_approval_update_failed',
              avatarId: approveAvatarId,
              userId: senderId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Send confirmation message to user
        try {
          const bot = telegramAdapter.getBot();
          if (bot) {
            const avatarName = approveConfig.name || 'Avatar';
            const message = isAlreadyAllowed
              ? `You're already connected to ${avatarName}!`
              : `You're now connected to ${avatarName}! Send me a message to get started.`;
            await bot.api.sendMessage(parseInt(envelope.conversationId), message);
          }
        } catch (err) {
          logger.warn('Failed to send approval confirmation message', {
            event: 'approve_confirmation_failed',
            avatarId: approveAvatarId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        return ok();
      } catch (err) {
        logger.warn('Deep link approval failed', {
          event: 'deep_link_approval_failed',
          avatarId: approveAvatarId,
          error: err instanceof Error ? err.message : String(err),
        });
        return ok();
      }
    }

    // /activate command: allow bot owner (and superadmins) to activate this bot in the current chat.
    // This must run BEFORE the chat-allowed gate so activation works in new channels.
    if (envelope.content.command?.command === 'activate') {
      const message = getMessageFromUpdate(update);
      const chatType = envelope.metadata.chatType;
      const chatId = envelope.conversationId;
      const chatUsername = message?.chat?.username as string | undefined;
      const chatTitle = message?.chat?.title as string | undefined;

      if (chatType === 'private') {
        return ok();
      }

      const activateSenderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
      const activateSenderUsername = envelope.sender.username;

      const allowedDmUserIds = getAllowedDmUserIdsForAdmin(avatarConfig.platforms.telegram);
      const isAllowedUser = await isAllowedDmUser(activateSenderId, activateSenderUsername, allowedDmUserIds);
      const isOwnerLike = isAllowedUser || (await isTelegramUserOwnerOfAvatar(activateSenderId, avatarId));
      const authorized = isTelegramSuperadmin(activateSenderUsername) || isOwnerLike;

      try {
        const bot = telegramAdapter.getBot();
        if (bot) {
          if (!authorized) {
            await bot.api.sendMessage(
              parseInt(chatId),
              'Not authorized to activate this avatar in this channel.',
              { reply_to_message_id: parseInt(envelope.messageId) }
            );
            return ok();
          }

          await activateAvatarInChatFromWebhook(avatarId, {
            chatId,
            username: chatUsername,
            title: chatTitle,
          }, {
            getAvatarConfig,
            invalidateAvatarConfigCache,
          });

          // Register explicit shared-channel membership so home-channel
          // checks scope this avatar (and only this avatar) to this channel.
          const botUsername = avatarConfig.platforms.telegram?.botUsername || '';
          await addSharedChannelMembership(avatarId, chatId, botUsername, chatTitle);

          await bot.api.sendMessage(
            parseInt(chatId),
            'Activated for this channel. I can now respond here (typically when mentioned or replied to).',
            { reply_to_message_id: parseInt(envelope.messageId) }
          );
        }
      } catch (err) {
        logger.warn('Failed to activate avatar in chat', {
          event: 'activate_failed',
          avatarId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return ok();
    }

    // Use home channel checker for groups/channels if ADMIN_TABLE is configured
    const homeChecker = ADMIN_TABLE ? createHomeChannelChecker(avatarId) : undefined;

    // Track username -> userId mapping for any user we see (for username-based allowlist resolution)
    const senderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
    const senderUsername = envelope.sender.username;
    const senderDisplayName = envelope.sender.displayName;
    if (senderUsername) {
      // Fire and forget - don't await, non-critical
      upsertTelegramUserMapping(senderId, senderUsername, senderDisplayName).catch(() => {});
    }

    // DMs: check if sender is in allowedDmUserIds before deciding how to handle
    if (envelope.metadata.chatType === 'private') {
      // Idempotency check (before any responses)
      const isNewMessage = await stateService.checkAndSetIdempotency(envelope.metadata.idempotencyKey);
      if (!isNewMessage) {
        logger.info('Duplicate DM, skipping', { messageId: envelope.messageId });
        return ok();
      }

      // Check if sender is in the allowed DM users list OR is the bot owner
      const allowedDmUserIds = getAllowedDmUserIdsForAdmin(telegramCfg);
      const isAllowedUser = await isAllowedDmUser(senderId, senderUsername, allowedDmUserIds);
      const isBotOwner = await isTelegramUserOwnerOfAvatar(senderId, avatarId);

      // Debug-level only: contains user identifiers for troubleshooting DM access.
      // Demoted from INFO to avoid retaining PII in production CloudWatch logs.
      logger.debug('DM allowlist check', {
        event: 'dm_allowlist_check',
        isAllowedDmUser: isAllowedUser,
        isBotOwner,
        hasTelegramCfg: !!telegramCfg,
      });

      if (isAllowedUser || isBotOwner) {
        // Allowed users or bot owner can DM - queue the message for processing
        logger.info('DM from allowed user or owner, queueing for processing', {
          event: 'dm_allowed',
          senderId,
          messageId: envelope.messageId,
          reason: isBotOwner ? 'bot_owner' : 'allowlist',
        });

        // Evaluate if we should respond
        const evaluator = createMessageEvaluator(avatarConfig, stateService, {
          botUsernames: [telegramCfg?.botUsername || ''],
        });

        const evaluation = await evaluator.evaluate(envelope);
        envelope.metadata.shouldRespond = evaluation.shouldRespond;
        envelope.metadata.responseReason = evaluation.reason;
        envelope.metadata.priority = evaluation.priority;

        // Send typing indicator immediately so the user sees instant feedback
        try {
          await telegramAdapter.sendTypingIndicator(envelope.conversationId);
        } catch { /* non-critical */ }

        // Queue for processing.
        // Pass the full ContextMessage (see #1573) — processor's idempotency
        // guard skips its own write if the messageId is already in the buffer,
        // so the flags must be set here.
        await stateService.addMessageToChannel(
          avatarId,
          envelope.conversationId,
          'telegram',
          {
            messageId: envelope.messageId,
            sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
            isBot: envelope.sender.isBot,
            content: envelope.content.text || '[media]',
            timestamp: envelope.timestamp,
            userId: envelope.sender.id,
            username: envelope.sender.username,
            isMention: envelope.metadata.isMention,
            isReplyToBot: envelope.metadata.isReplyToBot,
            replyToMessageId: envelope.replyTo,
          },
          undefined,
          'private',
          undefined
        );

        await sendSqsMessage({
          QueueUrl: MESSAGE_QUEUE_URL,
          MessageAttributes: {
            traceId: { DataType: 'String', StringValue: traceId },
            [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
          },
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: envelope.metadata.idempotencyKey,
        }, {
          envelope,
          enqueuedAt: Date.now(),
          attempts: 0,
          maxAttempts: 3,
        });

        logger.info('DM message queued', {
          event: 'dm_message_queued',
          messageId: envelope.messageId,
          senderId,
        });

        return ok();
      }

      // Non-allowed users: try the owner-approval flow (#1473). If the
      // avatar has no owner bound yet (#1471 never ran for this avatar),
      // fall back to the existing RATi Chat onboarding redirect so
      // unbound bots remain usable.
      try {
        const bot = telegramAdapter.getBot();
        const dmSigningKey = await getWebhookSecret(avatarId);
        if (bot && dmSigningKey && ADMIN_TABLE) {
          const dmDeps = createDmApprovalHandler({
            dynamoClient: getDynamoClient(),
            tableName: ADMIN_TABLE,
            signingKey: dmSigningKey,
            botApi: {
              sendMessage: (cid, text, extra) => bot.api.sendMessage(cid, text, extra as Parameters<typeof bot.api.sendMessage>[2]),
              editMessageText: (cid, mid, text, extra) => bot.api.editMessageText(cid, mid, text, extra as Parameters<typeof bot.api.editMessageText>[3]),
              answerCallbackQuery: (id, extra) => bot.api.answerCallbackQuery(id, extra as Parameters<typeof bot.api.answerCallbackQuery>[1]),
            },
            stateService: getStateService(),
          });
          const dmResult = await handleStrangerDm({
            deps: dmDeps,
            input: {
              avatarId,
              avatarConfig,
              requesterId: senderId,
              requesterUsername: senderUsername,
              requesterDisplayName: envelope.sender.displayName,
              requesterChatId: parseInt(envelope.conversationId),
              firstMessage: envelope.content.text || '[media]',
            },
          });

          // If the avatar has no bound owner, fall back to the legacy
          // redirect so unbound bots still produce a useful reply.
          if (dmResult.status === 'notified' ||
              dmResult.status === 'dropped_blocked' ||
              dmResult.status === 'dropped_pending' ||
              dmResult.status === 'owner_unreachable') {
            logger.info('Handled stranger DM via owner approval flow', {
              event: 'telegram_stranger_dm_handled',
              avatarId,
              status: dmResult.status,
            });
            return ok();
          }

          // status === 'unbound_owner' — fall through to redirect.
          const dm = buildDmRedirectMessage(avatarConfig.platforms.telegram);
          await bot.api.sendMessage(
            parseInt(envelope.conversationId),
            dm.text,
            { reply_markup: dm.replyMarkup }
          );
          logger.info('Sent DM redirect message (unbound owner fallback)', {
            event: 'dm_redirect_sent_unbound',
            avatarId,
          });
        }
      } catch (err) {
        logger.warn('Failed to handle stranger DM', {
          event: 'dm_stranger_handle_failed',
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return ok();
    }

    // Groups/channels: Check if chat is allowed (home channel registry)
    let chatAllowed = await Promise.resolve(isTelegramChatAllowed(envelope, telegramCfg, homeChecker));
    if (!chatAllowed) {
      const isMentioned = envelope.metadata.isMention || envelope.metadata.isReplyToBot;

      // Bots may already be in a group before we start receiving my_chat_member updates.
      // When directly engaged (mention/reply) and no home channel exists yet, bootstrap it.
      if (isMentioned) {
        const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement({
          avatarId,
          avatarConfig,
          envelope,
        });
        if (bootstrapped) {
          chatAllowed = true;
        }
      }

      // Superadmin auto-activation: if a superadmin mentions the bot in any channel, activate automatically
      if (!chatAllowed && isMentioned && isTelegramSuperadmin(envelope.sender.username)) {
        const message = getMessageFromUpdate(update);
        const chatUsername = message?.chat?.username as string | undefined;
        const chatTitle = message?.chat?.title as string | undefined;

        try {
          await activateAvatarInChatFromWebhook(avatarId, {
            chatId: envelope.conversationId,
            username: chatUsername,
            title: chatTitle,
          }, {
            getAvatarConfig,
            invalidateAvatarConfigCache,
          });
          chatAllowed = true;
          logger.info('Superadmin auto-activated avatar in chat', {
            event: 'superadmin_auto_activate',
            avatarId,
            chatId: envelope.conversationId,
            senderUsername: envelope.sender.username,
          });
        } catch (err) {
          logger.warn('Failed to auto-activate avatar via superadmin mention', {
            event: 'superadmin_auto_activate_failed',
            avatarId,
            chatId: envelope.conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // DM allowlist user auto-activation: if a user on the DM allowlist mentions the bot in any channel, activate automatically
      if (!chatAllowed && isMentioned) {
        const autoActivateSenderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
        const autoActivateSenderUsername = envelope.sender.username;
        const allowedDmUserIds = getAllowedDmUserIdsForAdmin(telegramCfg || {});
        const isOnDmAllowlist = await isAllowedDmUser(autoActivateSenderId, autoActivateSenderUsername, allowedDmUserIds);

        if (isOnDmAllowlist) {
          const message = getMessageFromUpdate(update);
          const chatUsername = message?.chat?.username as string | undefined;
          const chatTitle = message?.chat?.title as string | undefined;

          try {
            await activateAvatarInChatFromWebhook(avatarId, {
              chatId: envelope.conversationId,
              username: chatUsername,
              title: chatTitle,
            }, {
              getAvatarConfig,
              invalidateAvatarConfigCache,
            });
            chatAllowed = true;
            logger.info('DM allowlist user auto-activated avatar in chat', {
              event: 'dm_allowlist_auto_activate',
              avatarId,
              chatId: envelope.conversationId,
              senderId,
              senderUsername: envelope.sender.username,
            });
          } catch (err) {
            logger.warn('Failed to auto-activate avatar via DM allowlist mention', {
              event: 'dm_allowlist_auto_activate_failed',
              avatarId,
              chatId: envelope.conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (!chatAllowed) {
        logger.info('Chat not in home channel registry', { event: 'chat_blocked', chatId: envelope.conversationId });

        // Send redirect message if mentioned or replied to in non-home channel
        if (isMentioned) {
          try {
            const bot = telegramAdapter.getBot();
            if (bot) {
              const redirectMessage = buildRedirectMessage(telegramCfg);
              await bot.api.sendMessage(
                parseInt(envelope.conversationId),
                redirectMessage,
                { reply_to_message_id: parseInt(envelope.messageId) }
              );
              logger.info('Sent redirect message', {
                event: 'redirect_sent',
                chatId: envelope.conversationId,
              });
            }
          } catch (err) {
            logger.warn('Failed to send redirect message', {
              error: err instanceof Error ? err.message : String(err),
              chatId: envelope.conversationId
            });
          }
        }

        return ok();
      }
    }

    // Idempotency
    const isNewMessage = await stateService.checkAndSetIdempotency(envelope.metadata.idempotencyKey);
    if (!isNewMessage) {
      logger.info('Duplicate message, skipping', { messageId: envelope.messageId });
      return ok();
    }

    // Evaluate if we should respond
    const evaluator = createMessageEvaluator(avatarConfig, stateService, {
      botUsernames: [avatarConfig.platforms.telegram?.botUsername || ''],
    });

    const evaluation = await evaluator.evaluate(envelope);
    if (!evaluation.shouldRespond) {
      logger.info('Not responding', { reason: evaluation.reason });
      return ok();
    }

    envelope.metadata.shouldRespond = evaluation.shouldRespond;
    envelope.metadata.responseReason = evaluation.reason;
    envelope.metadata.priority = evaluation.priority;

    // Note: DMs (private chats) are handled earlier and routed to admin service
    // This code path is only for groups/channels
    const normalizedChatType =
      envelope.metadata.chatType === 'group' ||
      envelope.metadata.chatType === 'supergroup' ||
      envelope.metadata.chatType === 'channel'
        ? envelope.metadata.chatType
        : undefined;

    // Check if this is a shared room (multiple avatars in the channel).
    // Shared rooms use room-scoped ingress: one ledger append + one SQS job per
    // inbound message, keyed by roomKey instead of avatarId#conversationId.
    const shared = await isSharedRoom('telegram', envelope.conversationId);

    if (shared) {
      const senderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
      const ingressResult = await processSharedRoomMessage('telegram', envelope.conversationId, {
        messageId: envelope.messageId,
        senderId,
        senderType: envelope.sender.isBot ? 'avatar' : 'human',
        content: envelope.content.text || '[media]',
        timestamp: envelope.timestamp,
      });

      if (!ingressResult.isNew) {
        logger.info('Shared room dedup — skipping duplicate', {
          event: 'shared_room_dedup',
          roomKey: ingressResult.roomKey,
          messageId: envelope.messageId,
        });
        return ok();
      }

      // Redirect the SQS job to the @-mentioned avatar when several bots
      // are in this chat. Telegram fans the same update out to every bot;
      // whichever webhook wins the dedup race owns the avatarId on the
      // envelope, but the user may have explicitly @-mentioned a different
      // bot. Without this redirect the wrong avatar processes the message
      // and decides not to respond, which leaves the mention unanswered.
      try {
        const messageText = envelope.content.text || '';
        if (messageText) {
          const registered = await getChannelRegisteredAvatars(envelope.conversationId);
          const mentioned = resolveMentionedAvatar(messageText, registered);
          if (mentioned && mentioned.avatarId !== avatarId) {
            logger.info('Redirecting shared-room job to @-mentioned avatar', {
              event: 'shared_room_mention_redirect',
              roomKey: ingressResult.roomKey,
              messageId: envelope.messageId,
              fromAvatarId: avatarId,
              toAvatarId: mentioned.avatarId,
              mentionedBot: mentioned.botUsername,
            });
            envelope.avatarId = mentioned.avatarId;
            envelope.metadata.isMention = true;
          }
        }
      } catch (err) {
        logger.warn('mention-redirect failed; continuing with original avatar', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Send typing indicator immediately so group members see instant feedback
      try {
        await telegramAdapter.sendTypingIndicator(envelope.conversationId);
      } catch { /* non-critical */ }

      // Enqueue one coordination job keyed by roomKey (not per-avatar)
      const roomKey = buildRoomKey('telegram', envelope.conversationId);
      await sendSqsMessage({
        QueueUrl: MESSAGE_QUEUE_URL,
        MessageAttributes: {
          traceId: { DataType: 'String', StringValue: traceId },
          [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
        },
        MessageGroupId: roomKey,
        MessageDeduplicationId: envelope.metadata.idempotencyKey,
      }, {
        envelope,
        roomKey,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      });

      logger.info('Shared room message queued (room-scoped)', {
        event: 'room_message_queued',
        roomKey,
        messageId: envelope.messageId,
        reason: evaluation.reason,
        durationMs: Date.now() - startTime,
      });
    } else {
      // Single-avatar channel: use legacy per-avatar enqueue path.
      // IMPORTANT: pass the FULL ContextMessage including isMention /
      // isReplyToBot / userId / username / replyToMessageId. The processor
      // calls addMessageToChannel again with the same messageId; its
      // idempotency guard (channel-state.ts) then skips the second write,
      // so the buffer entry the response evaluator reads is whatever the
      // webhook wrote here. Stripping flags here means evaluateResponseTrigger
      // sees `m.isMention === undefined` for every message, hasDirectEngagement
      // is always false, and the bot ignores @-mentions in groups (#1573).
      await stateService.addMessageToChannel(
        avatarId,
        envelope.conversationId,
        'telegram',
        {
          messageId: envelope.messageId,
          sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
          isBot: envelope.sender.isBot,
          content: envelope.content.text || '[media]',
          timestamp: envelope.timestamp,
          userId: envelope.sender.id,
          username: envelope.sender.username,
          isMention: envelope.metadata.isMention,
          isReplyToBot: envelope.metadata.isReplyToBot,
          replyToMessageId: envelope.replyTo,
        },
        undefined,
        normalizedChatType,
        envelope.metadata.chatTitle
      );

      // Send typing indicator immediately so group members see instant feedback
      try {
        await telegramAdapter.sendTypingIndicator(envelope.conversationId);
      } catch { /* non-critical */ }

      await sendSqsMessage({
        QueueUrl: MESSAGE_QUEUE_URL,
        MessageAttributes: {
          traceId: { DataType: 'String', StringValue: traceId },
          [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
        },
        MessageGroupId: `${avatarId}#${envelope.conversationId}`,
        MessageDeduplicationId: envelope.metadata.idempotencyKey,
      }, {
        envelope,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      });

      logger.info('Message queued (per-avatar)', {
        event: 'message_queued',
        messageId: envelope.messageId,
        reason: evaluation.reason,
        durationMs: Date.now() - startTime,
      });
    }

    return ok();
  } catch (err) {
    logger.error('Telegram webhook handler error', err, { event: 'handler_error' });
    // Telegram will retry on non-200. We generally want to ACK to avoid retries.
    return ok();
  }
}
