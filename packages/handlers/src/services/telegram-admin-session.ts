/**
 * Telegram Admin Session Service
 * Manages user sessions for the in-Telegram bot creation and admin feature
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@swarm/core';
import { logger } from '@swarm/core';
import type {
  TelegramAdminSession,
  AdminSessionState,
  TelegramUserBotRecord,
} from '../types/telegram-admin.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();

// Session TTLs
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours for active sessions
const ONBOARDING_TTL_SECONDS = 15 * 60; // 15 minutes for incomplete onboarding

/**
 * Create a Telegram Admin Session Service
 */
export function createTelegramAdminSessionService(tableName: string) {
  const service = {
    /**
     * Get or create a session for a Telegram user
     */
    async getOrCreateSession(
      telegramUserId: string,
      telegramUsername?: string,
      telegramDisplayName?: string
    ): Promise<TelegramAdminSession> {
      const pk = `TG_ADMIN#${telegramUserId}`;
      const sk = 'SESSION';

      // Try to get existing session
      const result = await dynamoClient.send(new GetCommand({
        TableName: tableName,
        Key: { pk, sk },
      }));

      if (result.Item) {
        const session = result.Item as TelegramAdminSession;

        // Update username/displayName if changed and refresh TTL
        if (
          session.telegramUsername !== telegramUsername ||
          session.telegramDisplayName !== telegramDisplayName
        ) {
          const now = Date.now();
          await dynamoClient.send(new UpdateCommand({
            TableName: tableName,
            Key: { pk, sk },
            UpdateExpression: 'SET #username = :username, #displayName = :displayName, #updatedAt = :updatedAt, #ttl = :ttl',
            ExpressionAttributeNames: {
              '#username': 'telegramUsername',
              '#displayName': 'telegramDisplayName',
              '#updatedAt': 'updatedAt',
              '#ttl': 'ttl',
            },
            ExpressionAttributeValues: {
              ':username': telegramUsername,
              ':displayName': telegramDisplayName,
              ':updatedAt': now,
              ':ttl': Math.floor(now / 1000) + SESSION_TTL_SECONDS,
            },
          }));

          session.telegramUsername = telegramUsername;
          session.telegramDisplayName = telegramDisplayName;
        }

        return session;
      }

      // Create new session
      const now = Date.now();
      const newSession: TelegramAdminSession = {
        pk,
        sk,
        telegramUserId,
        telegramUsername,
        telegramDisplayName,
        state: 'idle',
        startedAt: now,
        updatedAt: now,
        ttl: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
      };

      await dynamoClient.send(new PutCommand({
        TableName: tableName,
        Item: newSession,
      }));

      logger.info('Created new Telegram admin session', {
        telegramUserId,
        telegramUsername,
      });

      return newSession;
    },

    /**
     * Get session by Telegram user ID
     */
    async getSession(telegramUserId: string): Promise<TelegramAdminSession | null> {
      const result = await dynamoClient.send(new GetCommand({
        TableName: tableName,
        Key: {
          pk: `TG_ADMIN#${telegramUserId}`,
          sk: 'SESSION',
        },
      }));

      return (result.Item as TelegramAdminSession) || null;
    },

    /**
     * Update session state
     */
    async updateState(
      telegramUserId: string,
      state: AdminSessionState,
      stateData?: Record<string, unknown>
    ): Promise<void> {
      const now = Date.now();

      // Use shorter TTL for onboarding states
      const isOnboarding = state.startsWith('onboarding_');
      const ttlSeconds = isOnboarding ? ONBOARDING_TTL_SECONDS : SESSION_TTL_SECONDS;

      await dynamoClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `TG_ADMIN#${telegramUserId}`,
          sk: 'SESSION',
        },
        UpdateExpression: 'SET #state = :state, #stateData = :stateData, #updatedAt = :updatedAt, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#state': 'state',
          '#stateData': 'stateData',
          '#updatedAt': 'updatedAt',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':state': state,
          ':stateData': stateData || null,
          ':updatedAt': now,
          ':ttl': Math.floor(now / 1000) + ttlSeconds,
        },
      }));

      logger.info('Updated session state', {
        telegramUserId,
        state,
        hasStateData: !!stateData,
      });
    },

    /**
     * Update session with avatar ID after bot creation
     */
    async setAvatarId(telegramUserId: string, avatarId: string): Promise<void> {
      const now = Date.now();

      await dynamoClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `TG_ADMIN#${telegramUserId}`,
          sk: 'SESSION',
        },
        UpdateExpression: 'SET #avatarId = :avatarId, #state = :state, #stateData = :stateData, #updatedAt = :updatedAt, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#avatarId': 'avatarId',
          '#state': 'state',
          '#stateData': 'stateData',
          '#updatedAt': 'updatedAt',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':avatarId': avatarId,
          ':state': 'idle',
          ':stateData': null,
          ':updatedAt': now,
          ':ttl': Math.floor(now / 1000) + SESSION_TTL_SECONDS,
        },
      }));

      logger.info('Set avatar ID for session', {
        telegramUserId,
        avatarId,
      });
    },

    /**
     * Update last bot message ID (for updating inline keyboards)
     */
    async setLastBotMessageId(telegramUserId: string, messageId: number): Promise<void> {
      await dynamoClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `TG_ADMIN#${telegramUserId}`,
          sk: 'SESSION',
        },
        UpdateExpression: 'SET #lastBotMessageId = :messageId, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#lastBotMessageId': 'lastBotMessageId',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':messageId': messageId,
          ':updatedAt': Date.now(),
        },
      }));
    },

    /**
     * Reset session to idle state
     */
    async resetState(telegramUserId: string): Promise<void> {
      await service.updateState(telegramUserId, 'idle', undefined);
    },

    /**
     * Delete session
     */
    async deleteSession(telegramUserId: string): Promise<void> {
      await dynamoClient.send(new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `TG_ADMIN#${telegramUserId}`,
          sk: 'SESSION',
        },
      }));

      logger.info('Deleted Telegram admin session', { telegramUserId });
    },

    // =========================================================================
    // User Bot Registry (one bot per user limit)
    // =========================================================================

    /**
     * Check if user has already created a bot
     */
    async getUserBot(telegramUserId: string): Promise<TelegramUserBotRecord | null> {
      // New format: store one record per avatar (sk=CREATED_BOT#{avatarId}).
      // This getter returns the most recently created record (by createdAt) to preserve
      // the existing UX, while allowing users to own multiple bots.
      const result = await dynamoClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `TELEGRAM_USER#${telegramUserId}`,
          ':skPrefix': 'CREATED_BOT#',
        },
      }));

      const items = (result.Items as TelegramUserBotRecord[] | undefined) || [];
      if (items.length === 0) {
        // Legacy fallback (back-compat)
        const legacy = await dynamoClient.send(new GetCommand({
          TableName: tableName,
          Key: {
            pk: `TELEGRAM_USER#${telegramUserId}`,
            sk: 'CREATED_BOT',
          },
        }));

        return (legacy.Item as TelegramUserBotRecord) || null;
      }

      return items.reduce((best, item) => (item.createdAt > best.createdAt ? item : best), items[0]);
    },

    /**
     * Register that a user has created a bot (enforces one per user)
     */
    async registerUserBot(
      telegramUserId: string,
      telegramUsername: string | undefined,
      avatarId: string,
      botUsername: string
    ): Promise<void> {
      const now = Date.now();

      const record: TelegramUserBotRecord = {
        pk: `TELEGRAM_USER#${telegramUserId}`,
        sk: `CREATED_BOT#${avatarId}`,
        telegramUserId,
        telegramUsername,
        avatarId,
        botUsername,
        createdAt: now,
        updatedAt: now,
      };

      await dynamoClient.send(new PutCommand({
        TableName: tableName,
        Item: record,
        ConditionExpression: 'attribute_not_exists(pk)',
      }));

      logger.info('Registered user bot', {
        telegramUserId,
        avatarId,
        botUsername,
      });
    },

    /**
     * Look up avatar by Telegram bot ID (using GSI)
     */
    async getAvatarByBotId(botId: number): Promise<string | null> {
      // Query using GSI3 (TELEGRAM_BOT#{botId})
      const result = await dynamoClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'gsi3',
        KeyConditionExpression: 'gsi3pk = :pk',
        ExpressionAttributeValues: {
          ':pk': `TELEGRAM_BOT#${botId}`,
        },
        Limit: 1,
      }));

      if (result.Items && result.Items.length > 0) {
        return result.Items[0].avatarId as string;
      }

      return null;
    },
  };

  return service;
}

export type TelegramAdminSessionService = ReturnType<typeof createTelegramAdminSessionService>;
