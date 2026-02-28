/**
 * MCP Platform Services
 *
 * Service implementations for Telegram, Twitter, Discord,
 * and unified integration configuration.
 */
import type { AllServices } from '@swarm/mcp-server';
import type { IntegrationType, AICapability } from '../integrations.js';
import type { UserSession } from '../../types.js';
import type { ServiceContainer } from '../service-container.js';
import { getBotToken } from './helpers.js';

type PlatformServices = Pick<AllServices, 'telegram' | 'twitter' | 'discord' | 'integrations'>;

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
          return _AVAILABLE_MODELS.filter(m => m.provider === integration);
        }
        return _AVAILABLE_MODELS;
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
