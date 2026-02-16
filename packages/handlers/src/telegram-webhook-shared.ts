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
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import type { Update } from 'grammy/types';
import {
  createMessageEvaluator,
  logger,
  CORRELATION_ID_ATTR,
  extractCorrelationIdFromApiEvent,
  hasValidInternalTestKey,
} from '@swarm/core';
import { getMessageFromUpdate } from './utils/telegram-type-guards.js';

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
  maybeBootstrapHomeChannelFromGroupEngagement,
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

// --- Re-exports for external consumers ---
export {
  getAllowedDmUserIdsForAdmin,
  isAllowedDmUserById,
  mergeAllowedChats,
  buildDmRedirectMessage,
  isTelegramChatAllowed,
  resolveTelegramUsername,
  maybeBootstrapHomeChannelFromGroupEngagement,
};
export type { HomeChannelChecker };

const sqs = new SQSClient({});

const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const ADMIN_TABLE = process.env.ADMIN_TABLE;
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;
const RUNTIME_ENV = (process.env.ENVIRONMENT || process.env.NODE_ENV || '').trim().toLowerCase();

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

      // Bot was REMOVED (left or kicked), clean up channel state
      if (chatId && (newStatus === 'left' || newStatus === 'kicked')) {
        logger.info('Bot removed from channel, cleaning up state', {
          event: 'bot_removed',
          chatId: String(chatId),
          newStatus,
        });
        await cleanupChannelState(avatarId, String(chatId));
        return ok();
      }
    }

    const telegramCfg = avatarConfig.platforms.telegram;

    // Handle callback_query updates (inline button presses) for DM bot creation flow
    if (update.callback_query) {
      logger.info('Callback query received', { event: 'callback_query' });
      try {
        const { processAdminCallbackQuery } = await import('./services/telegram-admin-handler.js');
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
    const homeChecker = ADMIN_TABLE ? createHomeChannelChecker() : undefined;

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

      // Debug logging to understand why DMs are being blocked
      logger.info('DM allowlist check', {
        event: 'dm_allowlist_check',
        senderId,
        senderUsername,
        allowedDmUserIds,
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

        // Queue for processing
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
          },
          undefined,
          'private',
          undefined
        );

        await sqs.send(new SendMessageCommand({
          QueueUrl: MESSAGE_QUEUE_URL,
          MessageBody: JSON.stringify({
            envelope,
            enqueuedAt: Date.now(),
            attempts: 0,
            maxAttempts: 3,
          }),
          MessageAttributes: {
            traceId: { DataType: 'String', StringValue: traceId },
            [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
          },
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: envelope.metadata.idempotencyKey,
        }));

        logger.info('DM message queued', {
          event: 'dm_message_queued',
          messageId: envelope.messageId,
          senderId,
        });

        return ok();
      }

      // Non-allowed users: redirect to RATi Chat onboarding
      try {
        const bot = telegramAdapter.getBot();
        if (bot) {
          const dm = buildDmRedirectMessage(avatarConfig.platforms.telegram);
          await bot.api.sendMessage(
            parseInt(envelope.conversationId),
            dm.text,
            { reply_markup: dm.replyMarkup }
          );

          logger.info('Sent DM redirect message', {
            event: 'dm_redirect_sent',
            chatId: envelope.conversationId,
            messageId: envelope.messageId,
          });
        }
      } catch (err) {
        logger.warn('Failed to send DM redirect message', {
          event: 'dm_redirect_failed',
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
      },
      undefined,
      normalizedChatType,
      envelope.metadata.chatTitle
    );

    await sqs.send(new SendMessageCommand({
      QueueUrl: MESSAGE_QUEUE_URL,
      MessageBody: JSON.stringify({
        envelope,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      }),
      MessageAttributes: {
        traceId: { DataType: 'String', StringValue: traceId },
        [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
      },
      MessageGroupId: `${avatarId}#${envelope.conversationId}`,
      MessageDeduplicationId: envelope.metadata.idempotencyKey,
    }));

    logger.info('Message queued', {
      event: 'message_queued',
      messageId: envelope.messageId,
      reason: evaluation.reason,
      durationMs: Date.now() - startTime,
    });

    return ok();
  } catch (err) {
    logger.error('Telegram webhook handler error', err, { event: 'handler_error' });
    // Telegram will retry on non-200. We generally want to ACK to avoid retries.
    return ok();
  }
}
