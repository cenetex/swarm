/**
 * MCP Platform Services
 *
 * Service implementations for Telegram, Twitter, Discord,
 * and unified integration configuration.
 */
import type { AllServices } from '@swarm/mcp-server';
import {
  createPresenceService,
  createStateService,
  type ChannelInfo,
  type ChannelState,
} from '@swarm/core';
import type { IntegrationType, AICapability } from '../integrations.js';
import type { UserSession } from '../../types.js';
import type { ServiceContainer } from '../service-container.js';
import { getBotToken } from './helpers.js';
import { isRetiredReplicateMediaModel } from '../models-registry.js';

type PlatformServices = Pick<AllServices, 'telegram' | 'twitter' | 'discord' | 'integrations'>;
type TelegramServices = NonNullable<AllServices['telegram']>;
type TelegramChatInfo = Awaited<ReturnType<NonNullable<TelegramServices['listChats']>>>[number];
type TelegramChatType = TelegramChatInfo['type'];

const TELEGRAM_CHAT_TYPES = new Set<TelegramChatType>([
  'private',
  'group',
  'supergroup',
  'channel',
]);

function normalizeTelegramChatType(type: unknown, chatId: string | number): TelegramChatType {
  if (typeof type === 'string' && TELEGRAM_CHAT_TYPES.has(type as TelegramChatType)) {
    return type as TelegramChatType;
  }

  const id = String(chatId);
  if (id.startsWith('-100')) return 'supergroup';
  if (id.startsWith('-')) return 'group';
  return 'private';
}

function upsertTelegramChat(
  chats: Map<string, TelegramChatInfo>,
  chat: TelegramChatInfo,
): void {
  const key = String(chat.chatId);
  const existing = chats.get(key);
  if (!existing) {
    chats.set(key, chat);
    return;
  }

  chats.set(key, {
    ...existing,
    ...chat,
    chatId: existing.chatId,
    title: chat.title ?? existing.title,
    username: chat.username ?? existing.username,
    memberCount: chat.memberCount ?? existing.memberCount,
    summary: chat.summary ?? existing.summary,
    lastActivityAt: Math.max(existing.lastActivityAt ?? 0, chat.lastActivityAt ?? 0) || undefined,
  });
}

function addConfigTelegramChats(
  chats: Map<string, TelegramChatInfo>,
  telegramConfig: {
    homeChannelId?: string;
    homeChannelUsername?: string;
    allowedChatIds?: string[];
    allowedChats?: Array<{ chatId: string; username?: string; title?: string }>;
  } | undefined,
): void {
  if (!telegramConfig) return;

  if (telegramConfig.homeChannelId) {
    upsertTelegramChat(chats, {
      chatId: telegramConfig.homeChannelId,
      title: telegramConfig.homeChannelUsername ? `@${telegramConfig.homeChannelUsername}` : undefined,
      username: telegramConfig.homeChannelUsername,
      type: normalizeTelegramChatType(undefined, telegramConfig.homeChannelId),
    });
  }

  for (const chat of telegramConfig.allowedChats ?? []) {
    upsertTelegramChat(chats, {
      chatId: chat.chatId,
      title: chat.title,
      username: chat.username,
      type: normalizeTelegramChatType(undefined, chat.chatId),
    });
  }

  const knownIds = new Set(Array.from(chats.keys()));
  for (const chatId of telegramConfig.allowedChatIds ?? []) {
    if (knownIds.has(String(chatId))) continue;
    upsertTelegramChat(chats, {
      chatId,
      type: normalizeTelegramChatType(undefined, chatId),
    });
  }
}

function addPresenceTelegramChats(
  chats: Map<string, TelegramChatInfo>,
  presenceChannels: ChannelInfo[],
): void {
  for (const channel of presenceChannels) {
    upsertTelegramChat(chats, {
      chatId: channel.channelId,
      title: channel.title,
      type: normalizeTelegramChatType(channel.type, channel.channelId),
      memberCount: channel.memberCount,
      lastActivityAt: channel.lastActivityAt,
      summary: channel.summary,
    });
  }
}

function addStateTelegramChats(
  chats: Map<string, TelegramChatInfo>,
  states: ChannelState[],
): void {
  for (const state of states) {
    upsertTelegramChat(chats, {
      chatId: state.channelId,
      title: state.chatTitle,
      type: normalizeTelegramChatType(state.chatType, state.channelId),
      lastActivityAt: state.lastActivityAt,
      summary: state.summary,
    });
  }
}

function getStateTableName(): string | undefined {
  const stateTable = process.env.STATE_TABLE?.trim();
  return stateTable || undefined;
}

/**
 * Create platform-related MCP services for a specific avatar.
 */
export function createPlatformServices(
  avatarId: string,
  _session: UserSession,
  svc: ServiceContainer,
): PlatformServices {
  const {
    telegram,
    discord,
    chatVoting,
    integrations,
    telegramAdmin: { diagnoseTelegram: _diagnoseTelegram },
    modelsRegistry: { getModelsForCapability: _getModelsForCapability, AVAILABLE_MODELS: _AVAILABLE_MODELS },
  } = svc;

  const listKnownTelegramChats = async (targetAvatarId: string): Promise<TelegramChatInfo[]> => {
    const chats = new Map<string, TelegramChatInfo>();

    const avatar = await svc.avatars.getAvatar(targetAvatarId);
    addConfigTelegramChats(chats, avatar?.platforms?.telegram);

    const stateTable = getStateTableName();
    if (stateTable) {
      try {
        const [presenceChannels, stateChannels] = await Promise.all([
          createPresenceService(stateTable).getChannelsForPlatform(targetAvatarId, 'telegram'),
          createStateService(stateTable).getChannelStatesForPlatform(targetAvatarId, 'telegram'),
        ]);
        addPresenceTelegramChats(chats, presenceChannels);
        addStateTelegramChats(chats, stateChannels);
      } catch {
        // Keep config-backed chat tools usable even if presence/state lookup is temporarily unavailable.
      }
    }

    return Array.from(chats.values())
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  };

  const getKnownTelegramChat = async (
    targetAvatarId: string,
    chatId: string | number,
  ): Promise<TelegramChatInfo | null> => {
    const target = String(chatId);
    const chats = await listKnownTelegramChats(targetAvatarId);
    return chats.find((chat) => String(chat.chatId) === target) ?? null;
  };

  return {
    // =========================================================================
    // Telegram Services
    // =========================================================================
    telegram: {
      diagnoseTelegram: async (avatarId: string) => {
        return _diagnoseTelegram(avatarId);
      },

      getUserProfilePhotos: async (avatarId, userId, options) => {
        const botToken = await getBotToken(svc, avatarId);

        const result = await telegram.getUserProfilePhotos(botToken, userId, options);

        const photos = [];
        for (const photoSizes of result.photos) {
          const largest = photoSizes.reduce((a, b) =>
            (a.width * a.height > b.width * b.height) ? a : b
          );

          let fileUrl: string | undefined;
          try {
            fileUrl = await telegram.getFileUrl(botToken, largest.file_id);
          } catch {
            // File URL fetch failed, skip
          }

          photos.push({
            fileId: largest.file_id,
            width: largest.width,
            height: largest.height,
            fileUrl,
          });
        }

        return {
          userId,
          totalPhotos: result.totalCount,
          photos,
        };
      },

      getBotName: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotName(botToken);
      },

      setBotName: async (avatarId, name, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotName(botToken, name, languageCode);
      },

      getBotDescription: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotDescription(botToken);
      },

      setBotDescription: async (avatarId, description, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotDescription(botToken, description, languageCode);
      },

      getBotShortDescription: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotShortDescription(botToken);
      },

      setBotShortDescription: async (avatarId, shortDescription, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotShortDescription(botToken, shortDescription, languageCode);
      },

      sendChatAction: async (avatarId, chatId, action) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.sendChatAction(botToken, chatId, action);
      },

      replyToMessage: async (avatarId, chatId, replyToMessageId, text) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.sendMessage(botToken, chatId, text, { replyToMessageId });
      },

      reactToMessage: async (avatarId, chatId, messageId, emoji) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setMessageReaction(botToken, chatId, messageId, emoji);
      },

      // Chat Modification Voting System
      getChatBots: async (chatId) => {
        return chatVoting.getChatBots(chatId);
      },

      proposeModification: async (avatarId, chatId, type, newValue, reason) => {
        const proposal = await chatVoting.createProposal(avatarId, chatId, type, newValue, reason);
        const withCounts = chatVoting.computeProposalCounts(proposal);
        return withCounts;
      },

      voteOnProposal: async (avatarId, proposalId, vote, comment) => {
        const proposal = await chatVoting.voteOnProposal(avatarId, proposalId, vote, comment);
        return chatVoting.computeProposalCounts(proposal);
      },

      getActiveProposals: async (chatId) => {
        const proposals = await chatVoting.getActiveProposals(chatId);
        return proposals.map(p => chatVoting.computeProposalCounts(p));
      },

      getProposal: async (proposalId) => {
        const proposal = await chatVoting.getProposal(proposalId);
        if (!proposal) return null;
        return chatVoting.computeProposalCounts(proposal);
      },

      canModifyChat: async (chatId, type) => {
        return chatVoting.canModifyChat(chatId, type);
      },

      executeModification: async (avatarId, proposalId) => {
        const botToken = await getBotToken(svc, avatarId);
        return chatVoting.executeModification(avatarId, proposalId, botToken);
      },

      listChats: async (avatarId) => {
        return listKnownTelegramChats(avatarId);
      },

      getChatInfo: async (avatarId, chatId) => {
        return getKnownTelegramChat(avatarId, chatId);
      },

      sendToChat: async (avatarId, chatId, text, options) => {
        const botToken = await getBotToken(svc, avatarId);
        const numericChatId = typeof chatId === 'number' ? chatId : Number(chatId);
        if (!Number.isFinite(numericChatId)) {
          throw new Error('Telegram chatId must be a numeric chat ID');
        }

        return telegram.sendMessage(botToken, numericChatId, text, {
          replyToMessageId: options?.replyToMessageId,
        });
      },

      getChatSummary: async (avatarId, chatId) => {
        const chat = await getKnownTelegramChat(avatarId, chatId);
        return chat?.summary ?? null;
      },

      discoverChats: async (avatarId) => {
        return listKnownTelegramChats(avatarId);
      },
    },

    // =========================================================================
    // Twitter Services (extracted to mcp-twitter-adapter.ts)
    // =========================================================================
    twitter: svc.createTwitterServices(avatarId),

    // =========================================================================
    // Discord Services
    // =========================================================================
    discord: {
      getConnectionStatus: async () => {
        return discord.getConnectionStatus(avatarId);
      },

      sendMessage: async (channelId, content, options) => {
        return discord.sendMessage(avatarId, channelId, content, options);
      },

      sendWebhookMessage: async (content, options) => {
        return discord.sendWebhookMessage(avatarId, content, options);
      },

      getChannel: async (channelId) => {
        return discord.getChannel(avatarId, channelId);
      },

      listChannels: async (guildId) => {
        return discord.listChannels(avatarId, guildId);
      },

      listGuilds: async () => {
        return discord.listGuilds(avatarId);
      },

      getMessages: async (channelId, limit) => {
        return discord.getMessages(avatarId, channelId, limit);
      },

      addReaction: async (channelId, messageId, emoji) => {
        return discord.addReaction(avatarId, channelId, messageId, emoji);
      },

      removeReaction: async (channelId, messageId, emoji) => {
        return discord.removeReaction(avatarId, channelId, messageId, emoji);
      },
    },

    // =========================================================================
    // Integrations Services (Unified Configuration)
    // =========================================================================
    integrations: {
      getStatus: async (integration: IntegrationType) => {
        return integrations.getIntegrationStatus(avatarId, integration);
      },

      getAllStatuses: async () => {
        return integrations.getAllIntegrationStatuses(avatarId);
      },

      testConnection: async (integration: IntegrationType) => {
        return integrations.testIntegrationConnection(avatarId, integration);
      },

      getAvailableModels: (integration?: string, capability?: string) => {
        if (capability && integration) {
          return _getModelsForCapability(capability as AICapability, integration);
        } else if (capability) {
          return _getModelsForCapability(capability as AICapability);
        } else if (integration) {
          return _AVAILABLE_MODELS.filter(m => m.provider === integration && !isRetiredReplicateMediaModel(m));
        }
        return _AVAILABLE_MODELS.filter(m => !isRetiredReplicateMediaModel(m));
      },

      setModelPreference: async (integration: string, capability: string, modelId: string) => {
        return integrations.setModelPreference(
          avatarId,
          integration as IntegrationType,
          capability as AICapability,
          modelId,
          _session,
        );
      },
    },
  };
}
