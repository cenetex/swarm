/**
 * Telegram Admin Service
 * Main orchestrator for the in-Telegram bot creation and admin feature
 */
import { Bot } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { logger, type SwarmEnvelope } from '@swarm/core';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type {
  TelegramAdminSession,
  OnboardingStateData,
  AdminCommand,
} from '../types/telegram-admin.js';
import { createTelegramAdminSessionService } from './telegram-admin-session.js';
import {
  parseAndValidateBotToken,
  mightContainBotToken,
} from './botfather-parser.js';
import * as keyboards from './telegram-keyboards.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Dependencies for the Telegram admin service
 */
export interface TelegramAdminDependencies {
  /** DynamoDB table name for admin data */
  adminTable: string;
  /** Bot token for the admin bot */
  botToken: string;
  /** Username of the admin/manager bot, used for Telegram managed-bot creation links */
  managerBotUsername?: string;
  /** Function to create avatar from Telegram */
  createAvatar: (params: CreateAvatarParams) => Promise<CreateAvatarResult>;
  /** Function to retrieve a token for a Telegram managed bot */
  getManagedBotToken?: (managedBotUserId: number) => Promise<ManagedBotTokenResult>;
  /** Function to get avatar by ID */
  getAvatar?: (avatarId: string) => Promise<AvatarInfo | null>;
  /** Function to update avatar */
  updateAvatar?: (avatarId: string, updates: AvatarUpdates) => Promise<void>;
  /** Test seam for session persistence */
  sessionService?: TelegramAdminSessionStore;
  /** Test seam for Telegram Bot API calls */
  botApi?: TelegramBotApi;
}

export interface CreateAvatarParams {
  botToken: string;
  botUsername: string;
  botId: number;
  name: string;
  description?: string;
  persona?: string;
  telegramUserId: string;
  telegramUsername?: string;
}

export interface CreateAvatarResult {
  success: boolean;
  avatarId?: string;
  error?: string;
}

export interface ManagedBotTokenResult {
  success: boolean;
  token?: string;
  error?: string;
}

export interface AvatarInfo {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  platforms: {
    telegram?: { enabled: boolean; botUsername?: string };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean };
  };
  profileImage?: { url: string };
}

export interface AvatarUpdates {
  name?: string;
  description?: string;
  persona?: string;
}

/**
 * Message sending options
 */
interface SendOptions {
  replyMarkup?: InlineKeyboardMarkup;
  replyToMessageId?: number;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

interface TelegramBotApi {
  sendMessage(chatId: number | string, text: string, options?: Record<string, unknown>): Promise<Message>;
  editMessageText(chatId: number | string, messageId: number, text: string, options?: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface TelegramAdminSessionStore {
  getOrCreateSession(
    telegramUserId: string,
    telegramUsername?: string,
    telegramDisplayName?: string
  ): Promise<TelegramAdminSession>;
  getSession(telegramUserId: string): Promise<TelegramAdminSession | null>;
  updateState(
    telegramUserId: string,
    state: TelegramAdminSession['state'],
    stateData?: Record<string, unknown>
  ): Promise<void>;
  resetState(telegramUserId: string): Promise<void>;
  setAvatarId(telegramUserId: string, avatarId: string): Promise<void>;
  getUserBot(telegramUserId: string): Promise<{ avatarId: string; botUsername: string } | null>;
  registerUserBot(
    telegramUserId: string,
    telegramUsername: string | undefined,
    avatarId: string,
    botUsername: string
  ): Promise<void>;
}

interface ManagedBotUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface ManagedBotEvent {
  user?: ManagedBotUser;
  bot?: ManagedBotUser;
  chatId?: number | string;
}

// =============================================================================
// SERVICE IMPLEMENTATION
// =============================================================================

/**
 * Create a Telegram Admin Service
 */
export function createTelegramAdminService(deps: TelegramAdminDependencies) {
  const sessionService = deps.sessionService || createTelegramAdminSessionService(deps.adminTable);
  const bot = deps.botApi ? undefined : new Bot(deps.botToken);
  const botApi = deps.botApi || bot!.api;

  /**
   * Send a message to a chat
   */
  async function sendMessage(chatId: number | string, text: string, options?: SendOptions): Promise<Message> {
    const message = await botApi.sendMessage(chatId, text, {
      reply_markup: options?.replyMarkup,
      reply_to_message_id: options?.replyToMessageId,
      parse_mode: options?.parseMode,
    });
    return message;
  }

  /**
   * Edit a message
   */
  async function editMessage(chatId: number | string, messageId: number, text: string, options?: SendOptions): Promise<void> {
    try {
      await botApi.editMessageText(chatId, messageId, text, {
        reply_markup: options?.replyMarkup,
        parse_mode: options?.parseMode,
      });
    } catch (err) {
      // Ignore "message is not modified" errors
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('message is not modified')) {
        throw err;
      }
    }
  }

  /**
   * Answer a callback query (acknowledge button press)
   */
  async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await botApi.answerCallbackQuery(callbackQueryId, { text });
  }

  function buildSuggestedBotUsername(session: TelegramAdminSession): string {
    const source = session.telegramUsername || session.telegramDisplayName || `user${session.telegramUserId.slice(-6)}`;
    const normalized = source
      .toLowerCase()
      .replace(/^@+/, '')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    const fallback = `swarm${session.telegramUserId.slice(-6).replace(/\D/g, '') || 'user'}`;
    const base = (normalized || fallback).replace(/bot$/i, '').slice(0, 29) || 'swarm';
    const username = `${base}bot`;
    return username.length >= 5 ? username : 'swarmbot';
  }

  function buildSuggestedBotName(session: TelegramAdminSession): string {
    const name = session.telegramDisplayName?.trim() || session.telegramUsername || 'Swarm';
    const suffix = /bot$/i.test(name) ? '' : ' Bot';
    return `${name}${suffix}`.slice(0, 64);
  }

  function onboardingKeyboard(session: TelegramAdminSession): InlineKeyboardMarkup {
    return keyboards.onboardingStartKeyboard(
      deps.managerBotUsername,
      buildSuggestedBotUsername(session),
      buildSuggestedBotName(session)
    );
  }

  function displayNameFromManagedUser(user: ManagedBotUser): string | undefined {
    const parts = [user.first_name, user.last_name]
      .map(part => part?.trim())
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  function asManagedBotUser(value: unknown): ManagedBotUser | undefined {
    const record = asRecord(value);
    if (!record || typeof record.id !== 'number') return undefined;

    return {
      id: record.id,
      is_bot: typeof record.is_bot === 'boolean' ? record.is_bot : undefined,
      first_name: typeof record.first_name === 'string' ? record.first_name : undefined,
      last_name: typeof record.last_name === 'string' ? record.last_name : undefined,
      username: typeof record.username === 'string' ? record.username : undefined,
    };
  }

  function extractManagedBotEvent(update: unknown): ManagedBotEvent | null {
    const updateRecord = asRecord(update);
    if (!updateRecord) return null;

    const managedBot = asRecord(updateRecord.managed_bot);
    if (managedBot) {
      return {
        user: asManagedBotUser(managedBot.user),
        bot: asManagedBotUser(managedBot.bot),
      };
    }

    const message = asRecord(updateRecord.message);
    const managedBotCreated = asRecord(message?.managed_bot_created);
    if (message && managedBotCreated) {
      const chat = asRecord(message.chat);
      const chatId = typeof chat?.id === 'number' || typeof chat?.id === 'string' ? chat.id : undefined;
      return {
        user: asManagedBotUser(message.from),
        bot: asManagedBotUser(managedBotCreated.bot),
        chatId,
      };
    }

    return null;
  }

  /**
   * Process a message from the admin bot
   */
  async function processMessage(envelope: SwarmEnvelope): Promise<void> {
    const chatId = parseInt(envelope.conversationId);
    const telegramUserId = envelope.sender.platformUserId;
    const telegramUsername = envelope.sender.username;
    const telegramDisplayName = envelope.sender.displayName;

    logger.setContext({
      subsystem: 'telegram-admin',
      telegramUserId,
      chatId,
    });

    // Get or create session
    const session = await sessionService.getOrCreateSession(
      telegramUserId,
      telegramUsername,
      telegramDisplayName
    );

    // Check for commands
    if (envelope.content.command) {
      await handleCommand(
        envelope.content.command.command as AdminCommand,
        envelope.content.command.args,
        session,
        chatId
      );
      return;
    }

    // Check for BotFather forward
    const forwardMetadata = envelope.metadata.forwardMetadata;
    if (forwardMetadata?.isFromBotFather) {
      await handleBotFatherForward(envelope.content.text || '', session, chatId);
      return;
    }

    // Check if message might contain a bot token (even if not a forward)
    if (envelope.content.text && mightContainBotToken(envelope.content.text)) {
      // Only process if we're in the right state or idle
      if (session.state === 'idle' || session.state === 'onboarding_token') {
        await handleBotFatherForward(envelope.content.text, session, chatId);
        return;
      }
    }

    // Handle state-based input
    await handleStateInput(envelope.content.text || '', session, chatId, envelope);
  }

  /**
   * Handle a command
   */
  async function handleCommand(
    command: AdminCommand,
    _args: string[],
    session: TelegramAdminSession,
    chatId: number
  ): Promise<void> {
    logger.info('Handling command', { command, state: session.state });

    switch (command) {
      case 'start':
        await handleStartCommand(session, chatId);
        break;

      case 'cancel':
        await handleCancelCommand(session, chatId);
        break;

      case 'status':
        await handleStatusCommand(session, chatId);
        break;

      case 'profile':
        await handleProfileCommand(session, chatId);
        break;

      case 'help':
        await sendMessage(chatId, keyboards.HELP_MESSAGE, {
          replyMarkup: session.avatarId ? keyboards.mainMenu() : onboardingKeyboard(session),
        });
        break;

      default:
        await sendMessage(chatId, `Unknown command. Type /help for available commands.`);
    }
  }

  /**
   * Handle /start command
   */
  async function handleStartCommand(session: TelegramAdminSession, chatId: number): Promise<void> {
    // Check if user already has a bot
    const existingBot = await sessionService.getUserBot(session.telegramUserId);

    if (existingBot) {
      // Update session with avatar ID if not already set
      if (!session.avatarId) {
        await sessionService.setAvatarId(session.telegramUserId, existingBot.avatarId);
      }

      // Get avatar info for personalized welcome
      let avatarName = existingBot.botUsername;
      if (deps.getAvatar) {
        const avatar = await deps.getAvatar(existingBot.avatarId);
        if (avatar) {
          avatarName = avatar.name;
        }
      }

      const message = keyboards.welcomeReturningUser(existingBot.botUsername, avatarName);
      await sendMessage(chatId, message, {
        replyMarkup: keyboards.mainMenu(existingBot.botUsername),
      });
      return;
    }

    // New user - show onboarding instructions
    await sessionService.updateState(session.telegramUserId, 'onboarding_token');
    await sendMessage(chatId, keyboards.WELCOME_NEW_USER, {
      replyMarkup: onboardingKeyboard(session),
    });
  }

  /**
   * Handle /cancel command
   */
  async function handleCancelCommand(session: TelegramAdminSession, chatId: number): Promise<void> {
    await sessionService.resetState(session.telegramUserId);
    await sendMessage(chatId, keyboards.OPERATION_CANCELLED, {
      replyMarkup: session.avatarId ? keyboards.mainMenu() : onboardingKeyboard(session),
    });
  }

  /**
   * Handle /status command
   */
  async function handleStatusCommand(session: TelegramAdminSession, chatId: number): Promise<void> {
    if (!session.avatarId) {
      await sendMessage(chatId, `You don't have a bot yet. Send /start to create one!`);
      return;
    }

    if (!deps.getAvatar) {
      await sendMessage(chatId, 'Status checking is not available.');
      return;
    }

    const avatar = await deps.getAvatar(session.avatarId);
    if (!avatar) {
      await sendMessage(chatId, 'Could not find your bot. Please contact support.');
      return;
    }

    const statusText = keyboards.statusMessage(
      avatar.platforms.telegram?.botUsername || 'unknown',
      avatar.name,
      avatar.platforms.telegram?.enabled || false,
      {
        twitter: avatar.platforms.twitter?.enabled,
        discord: avatar.platforms.discord?.enabled,
      }
    );

    await sendMessage(chatId, statusText, {
      replyMarkup: keyboards.mainMenu(avatar.platforms.telegram?.botUsername),
    });
  }

  /**
   * Handle /profile command
   */
  async function handleProfileCommand(session: TelegramAdminSession, chatId: number): Promise<void> {
    if (!session.avatarId) {
      await sendMessage(chatId, `You don't have a bot yet. Send /start to create one!`);
      return;
    }

    await sendMessage(chatId, 'What would you like to update?', {
      replyMarkup: keyboards.profileMenu(),
    });
  }

  /**
   * Handle a BotFather forward or message containing a bot token
   */
  async function handleBotFatherForward(text: string, session: TelegramAdminSession, chatId: number): Promise<void> {
    // Check if user already has a bot
    const existingBot = await sessionService.getUserBot(session.telegramUserId);
    if (existingBot) {
      const message = keyboards.alreadyHasBotMessage(existingBot.botUsername);
      await sendMessage(chatId, message, {
        replyMarkup: keyboards.mainMenu(existingBot.botUsername),
      });
      return;
    }

    // Parse and validate the token
    const result = await parseAndValidateBotToken(text);

    if (!result.success) {
      await sendMessage(chatId, keyboards.INVALID_TOKEN, {
        replyMarkup: keyboards.cancelKeyboard(),
      });
      return;
    }

    // Store token in state data and move to name step
    const stateData: OnboardingStateData = {
      botToken: result.token,
      botUsername: result.botInfo.username,
      botId: result.botInfo.id,
      provisioningSource: 'manual_token',
    };

    await sessionService.updateState(session.telegramUserId, 'onboarding_name', stateData);

    const message = keyboards.tokenReceivedMessage(result.botInfo.username);
    await sendMessage(chatId, message, {
      replyMarkup: keyboards.cancelKeyboard(),
    });

    logger.info('Bot token validated', {
      botUsername: result.botInfo.username,
      botId: result.botInfo.id,
    });
  }

  /**
   * Handle Telegram managed-bot updates/service messages.
   */
  async function processManagedBotUpdate(update: unknown): Promise<void> {
    const event = extractManagedBotEvent(update);
    if (!event?.user || !event.bot) {
      logger.warn('Managed bot update missing user or bot', { event: 'managed_bot_invalid' });
      return;
    }

    const telegramUserId = event.user.id.toString();
    const chatId = event.chatId ?? event.user.id;
    const telegramUsername = event.user.username;
    const telegramDisplayName = displayNameFromManagedUser(event.user);

    logger.setContext({
      subsystem: 'telegram-admin',
      telegramUserId,
      chatId,
      managedBotId: event.bot.id,
    });

    const session = await sessionService.getOrCreateSession(
      telegramUserId,
      telegramUsername,
      telegramDisplayName
    );

    const existingBot = await sessionService.getUserBot(telegramUserId);
    if (existingBot) {
      const message = keyboards.alreadyHasBotMessage(existingBot.botUsername);
      await sendMessage(chatId, message, {
        replyMarkup: keyboards.mainMenu(existingBot.botUsername),
      });
      return;
    }

    if (!event.bot.username) {
      await sendMessage(chatId, keyboards.managedBotUnavailableMessage(), {
        replyMarkup: keyboards.onboardingStartKeyboard(
          deps.managerBotUsername,
          buildSuggestedBotUsername(session),
          buildSuggestedBotName(session)
        ),
      });
      logger.warn('Managed bot update missing bot username', {
        event: 'managed_bot_missing_username',
        managedBotId: event.bot.id,
      });
      return;
    }

    if (!deps.getManagedBotToken) {
      await sendMessage(chatId, keyboards.managedBotUnavailableMessage(event.bot.username), {
        replyMarkup: keyboards.onboardingStartKeyboard(
          deps.managerBotUsername,
          buildSuggestedBotUsername(session),
          buildSuggestedBotName(session)
        ),
      });
      logger.warn('Managed bot token retrieval not configured', {
        event: 'managed_bot_token_unconfigured',
        managedBotId: event.bot.id,
        botUsername: event.bot.username,
      });
      return;
    }

    const tokenResult = await deps.getManagedBotToken(event.bot.id);
    if (!tokenResult.success || !tokenResult.token) {
      await sendMessage(chatId, keyboards.managedBotUnavailableMessage(event.bot.username), {
        replyMarkup: keyboards.onboardingStartKeyboard(
          deps.managerBotUsername,
          buildSuggestedBotUsername(session),
          buildSuggestedBotName(session)
        ),
      });
      logger.warn('Managed bot token retrieval failed', {
        event: 'managed_bot_token_failed',
        managedBotId: event.bot.id,
        botUsername: event.bot.username,
        error: tokenResult.error,
      });
      return;
    }

    const stateData: OnboardingStateData = {
      botToken: tokenResult.token,
      botUsername: event.bot.username,
      botId: event.bot.id,
      provisioningSource: 'managed_bot',
    };

    await sessionService.updateState(telegramUserId, 'onboarding_name', stateData);

    const message = keyboards.managedBotReceivedMessage(event.bot.username);
    await sendMessage(chatId, message, {
      replyMarkup: keyboards.cancelKeyboard(),
    });

    logger.info('Managed bot token accepted', {
      managedBotId: event.bot.id,
      botUsername: event.bot.username,
    });
  }

  /**
   * Handle state-based input
   */
  async function handleStateInput(
    text: string,
    session: TelegramAdminSession,
    chatId: number,
    _envelope: SwarmEnvelope
  ): Promise<void> {
    const stateData = session.stateData as OnboardingStateData | undefined;

    switch (session.state) {
      case 'idle':
        // User sent a message without a command - show help or main menu
        if (session.avatarId) {
          await sendMessage(chatId, 'What would you like to do?', {
            replyMarkup: keyboards.mainMenu(),
          });
        } else {
          await sendMessage(chatId, keyboards.WELCOME_NEW_USER, {
            replyMarkup: onboardingKeyboard(session),
          });
          await sessionService.updateState(session.telegramUserId, 'onboarding_token');
        }
        break;

      case 'onboarding_token':
        // User sent text but it wasn't a valid token
        await sendMessage(chatId, keyboards.INVALID_TOKEN, {
          replyMarkup: keyboards.cancelKeyboard(),
        });
        break;

      case 'onboarding_name':
        await handleOnboardingName(text, session, chatId, stateData);
        break;

      case 'onboarding_description':
        await handleOnboardingDescription(text, session, chatId, stateData);
        break;

      case 'onboarding_persona':
        await handleOnboardingPersona(text, session, chatId, stateData);
        break;

      case 'editing_name':
        await handleEditName(text, session, chatId);
        break;

      case 'editing_description':
        await handleEditDescription(text, session, chatId);
        break;

      case 'editing_persona':
        await handleEditPersona(text, session, chatId);
        break;

      default:
        logger.warn('Unhandled state', { state: session.state });
        await sendMessage(chatId, keyboards.ERROR_GENERIC);
    }
  }

  /**
   * Handle name input during onboarding
   */
  async function handleOnboardingName(
    text: string,
    session: TelegramAdminSession,
    chatId: number,
    stateData?: OnboardingStateData
  ): Promise<void> {
    const name = text.trim();

    if (name.length < 2 || name.length > 64) {
      await sendMessage(chatId, 'Please enter a name between 2 and 64 characters.', {
        replyMarkup: keyboards.cancelKeyboard(),
      });
      return;
    }

    const newStateData: OnboardingStateData = {
      ...stateData,
      name,
    };

    await sessionService.updateState(session.telegramUserId, 'onboarding_description', newStateData);

    const message = keyboards.nameReceivedMessage(name);
    await sendMessage(chatId, message, {
      replyMarkup: keyboards.skipCancelKeyboard(),
    });
  }

  /**
   * Handle description input during onboarding
   */
  async function handleOnboardingDescription(
    text: string,
    session: TelegramAdminSession,
    chatId: number,
    stateData?: OnboardingStateData
  ): Promise<void> {
    const description = text.toLowerCase() === 'skip' ? undefined : text.trim();

    if (description && description.length > 512) {
      await sendMessage(chatId, 'Description is too long. Please keep it under 512 characters.', {
        replyMarkup: keyboards.skipCancelKeyboard(),
      });
      return;
    }

    const newStateData: OnboardingStateData = {
      ...stateData,
      description,
    };

    await sessionService.updateState(session.telegramUserId, 'onboarding_persona', newStateData);

    const message = keyboards.descriptionReceivedMessage(stateData?.name || 'Your bot');
    await sendMessage(chatId, message, {
      replyMarkup: keyboards.skipCancelKeyboard(),
    });
  }

  /**
   * Handle persona input during onboarding - this completes the bot creation
   */
  async function handleOnboardingPersona(
    text: string,
    session: TelegramAdminSession,
    chatId: number,
    stateData?: OnboardingStateData
  ): Promise<void> {
    const persona = text.toLowerCase() === 'skip' ? undefined : text.trim();

    if (persona && persona.length > 4096) {
      await sendMessage(chatId, 'Persona is too long. Please keep it under 4096 characters.', {
        replyMarkup: keyboards.skipCancelKeyboard(),
      });
      return;
    }

    // Validate we have all required data
    if (!stateData?.botToken || !stateData?.botUsername || !stateData?.botId || !stateData?.name) {
      logger.error('Missing required state data for bot creation', {
        hasBotToken: Boolean(stateData?.botToken),
        hasBotUsername: Boolean(stateData?.botUsername),
        hasBotId: Boolean(stateData?.botId),
        hasName: Boolean(stateData?.name),
        provisioningSource: stateData?.provisioningSource,
      });
      await sendMessage(chatId, keyboards.ERROR_GENERIC);
      await sessionService.resetState(session.telegramUserId);
      return;
    }

    // Create the avatar
    await sendMessage(chatId, 'Creating your bot... This may take a moment.');

    const result = await deps.createAvatar({
      botToken: stateData.botToken,
      botUsername: stateData.botUsername,
      botId: stateData.botId,
      name: stateData.name,
      description: stateData.description,
      persona,
      telegramUserId: session.telegramUserId,
      telegramUsername: session.telegramUsername,
    });

    if (!result.success || !result.avatarId) {
      logger.error('Failed to create avatar', { error: result.error });
      await sendMessage(chatId, result.error || keyboards.ERROR_GENERIC);
      await sessionService.resetState(session.telegramUserId);
      return;
    }

    // Register the user-bot mapping
    await sessionService.registerUserBot(
      session.telegramUserId,
      session.telegramUsername,
      result.avatarId,
      stateData.botUsername
    );

    // Update session with avatar ID
    await sessionService.setAvatarId(session.telegramUserId, result.avatarId);

    // Send success message
    const message = keyboards.creationSuccessMessage(stateData.botUsername);
    await sendMessage(chatId, message, {
      replyMarkup: keyboards.mainMenu(stateData.botUsername),
    });

    logger.info('Bot created successfully', {
      avatarId: result.avatarId,
      botUsername: stateData.botUsername,
    });
  }

  /**
   * Handle name edit
   */
  async function handleEditName(text: string, session: TelegramAdminSession, chatId: number): Promise<void> {
    const name = text.trim();

    if (name.length < 2 || name.length > 64) {
      await sendMessage(chatId, 'Please enter a name between 2 and 64 characters.', {
        replyMarkup: keyboards.cancelKeyboard(),
      });
      return;
    }

    if (!session.avatarId || !deps.updateAvatar) {
      await sendMessage(chatId, keyboards.ERROR_GENERIC);
      return;
    }

    await deps.updateAvatar(session.avatarId, { name });
    await sessionService.resetState(session.telegramUserId);
    await sendMessage(chatId, `Name updated to "${name}"!`, {
      replyMarkup: keyboards.mainMenu(),
    });
  }

  /**
   * Handle description edit
   */
  async function handleEditDescription(text: string, session: TelegramAdminSession, chatId: number): Promise<void> {
    const description = text.toLowerCase() === 'skip' || text.toLowerCase() === 'clear' ? '' : text.trim();

    if (description && description.length > 512) {
      await sendMessage(chatId, 'Description is too long. Please keep it under 512 characters.', {
        replyMarkup: keyboards.cancelKeyboard(),
      });
      return;
    }

    if (!session.avatarId || !deps.updateAvatar) {
      await sendMessage(chatId, keyboards.ERROR_GENERIC);
      return;
    }

    await deps.updateAvatar(session.avatarId, { description });
    await sessionService.resetState(session.telegramUserId);
    await sendMessage(chatId, description ? 'Description updated!' : 'Description cleared!', {
      replyMarkup: keyboards.mainMenu(),
    });
  }

  /**
   * Handle persona edit
   */
  async function handleEditPersona(text: string, session: TelegramAdminSession, chatId: number): Promise<void> {
    const persona = text.toLowerCase() === 'skip' || text.toLowerCase() === 'clear' ? '' : text.trim();

    if (persona && persona.length > 4096) {
      await sendMessage(chatId, 'Persona is too long. Please keep it under 4096 characters.', {
        replyMarkup: keyboards.cancelKeyboard(),
      });
      return;
    }

    if (!session.avatarId || !deps.updateAvatar) {
      await sendMessage(chatId, keyboards.ERROR_GENERIC);
      return;
    }

    await deps.updateAvatar(session.avatarId, { persona });
    await sessionService.resetState(session.telegramUserId);
    await sendMessage(chatId, persona ? 'Persona updated!' : 'Persona cleared!', {
      replyMarkup: keyboards.mainMenu(),
    });
  }

  /**
   * Handle a callback query (inline button press)
   */
  async function processCallbackQuery(update: Update): Promise<void> {
    const callback = update.callback_query;
    if (!callback || !callback.data || !callback.message || !callback.from) {
      return;
    }

    const chatId = callback.message.chat.id;
    const telegramUserId = callback.from.id.toString();
    const messageId = callback.message.message_id;

    logger.setContext({
      subsystem: 'telegram-admin',
      telegramUserId,
      chatId,
      callbackData: callback.data,
    });

    // Acknowledge the callback immediately
    await answerCallback(callback.id);

    // Get session
    const session = await sessionService.getSession(telegramUserId);
    if (!session) {
      await editMessage(chatId, messageId, 'Session expired. Please send /start to begin again.');
      return;
    }

    // Parse callback data
    const parsed = keyboards.decodeCallbackData(callback.data);

    logger.info('Processing callback', { action: parsed.action, data: parsed.data });

    switch (parsed.action) {
      case 'main_menu':
        if (session.avatarId) {
          await editMessage(chatId, messageId, 'What would you like to do?', {
            replyMarkup: keyboards.mainMenu(),
          });
        } else {
          // Start onboarding
          await sessionService.updateState(telegramUserId, 'onboarding_token');
          await editMessage(chatId, messageId, keyboards.WELCOME_NEW_USER, {
            replyMarkup: onboardingKeyboard(session),
          });
        }
        break;

      case 'manual_token':
        await sessionService.updateState(telegramUserId, 'onboarding_token');
        await editMessage(chatId, messageId, keyboards.MANUAL_TOKEN_INSTRUCTIONS, {
          replyMarkup: keyboards.cancelKeyboard(),
        });
        break;

      case 'profile_menu':
        await editMessage(chatId, messageId, 'What would you like to update?', {
          replyMarkup: keyboards.profileMenu(),
        });
        break;

      case 'edit_name':
        await sessionService.updateState(telegramUserId, 'editing_name');
        await editMessage(chatId, messageId, 'Enter a new name for your bot:', {
          replyMarkup: keyboards.cancelKeyboard(),
        });
        break;

      case 'edit_description':
        await sessionService.updateState(telegramUserId, 'editing_description');
        await editMessage(chatId, messageId, 'Enter a new description for your bot (or "clear" to remove):', {
          replyMarkup: keyboards.cancelKeyboard(),
        });
        break;

      case 'edit_persona':
        await sessionService.updateState(telegramUserId, 'editing_persona');
        await editMessage(chatId, messageId, 'Enter a new persona/personality for your bot (or "clear" to remove):', {
          replyMarkup: keyboards.cancelKeyboard(),
        });
        break;

      case 'integrations_menu':
        await editMessage(chatId, messageId, 'Configure your integrations:', {
          replyMarkup: keyboards.integrationsMenu(),
        });
        break;

      case 'media_menu':
        await editMessage(chatId, messageId, 'Media options:', {
          replyMarkup: keyboards.mediaMenu(),
        });
        break;

      case 'status':
        if (session.avatarId && deps.getAvatar) {
          const avatar = await deps.getAvatar(session.avatarId);
          if (avatar) {
            const statusText = keyboards.statusMessage(
              avatar.platforms.telegram?.botUsername || 'unknown',
              avatar.name,
              avatar.platforms.telegram?.enabled || false,
              {
                twitter: avatar.platforms.twitter?.enabled,
                discord: avatar.platforms.discord?.enabled,
              }
            );
            await editMessage(chatId, messageId, statusText, {
              replyMarkup: keyboards.mainMenu(avatar.platforms.telegram?.botUsername),
            });
          }
        }
        break;

      case 'help':
        await editMessage(chatId, messageId, keyboards.HELP_MESSAGE, {
          replyMarkup: session.avatarId ? keyboards.mainMenu() : onboardingKeyboard(session),
        });
        break;

      case 'cancel':
        await sessionService.resetState(telegramUserId);
        await editMessage(chatId, messageId, keyboards.OPERATION_CANCELLED, {
          replyMarkup: session.avatarId ? keyboards.mainMenu() : onboardingKeyboard(session),
        });
        break;

      case 'confirm_yes':
      case 'confirm_no':
        // Handle confirmation based on current state
        // This will be extended based on the confirmation context
        await sessionService.resetState(telegramUserId);
        await editMessage(chatId, messageId, parsed.action === 'confirm_yes' ? 'Confirmed!' : 'Cancelled.', {
          replyMarkup: keyboards.mainMenu(),
        });
        break;

      default:
        logger.warn('Unhandled callback action', { action: parsed.action });
    }
  }

  /**
   * Process a raw Telegram update (for use in webhook handler)
   */
  async function processUpdate(update: Update): Promise<void> {
    if (extractManagedBotEvent(update)) {
      await processManagedBotUpdate(update);
      return;
    }

    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      await processCallbackQuery(update);
      return;
    }

    // For messages, we need to convert to envelope first
    // This is handled by the webhook handler before calling processMessage
  }

  return {
    processMessage,
    processUpdate,
    processCallbackQuery,
    processManagedBotUpdate,
    sendMessage,
    editMessage,
    sessionService,
    bot,
  };
}

export type TelegramAdminService = ReturnType<typeof createTelegramAdminService>;
