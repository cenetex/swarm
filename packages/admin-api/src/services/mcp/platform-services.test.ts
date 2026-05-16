import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInfo, ChannelState } from '@swarm/core';
import type { ServiceContainer } from '../service-container.js';
import type { UserSession } from '../../types.js';

const presenceService = {
  getChannelsForPlatform: vi.fn(),
};

const stateService = {
  getChannelStatesForPlatform: vi.fn(),
};

vi.mock('@swarm/core', () => ({
  createPresenceService: vi.fn(() => presenceService),
  createStateService: vi.fn(() => stateService),
}));

import { createPresenceService, createStateService } from '@swarm/core';
import { createPlatformServices } from './platform-services.js';

const createPresenceServiceMock = createPresenceService as unknown as ReturnType<typeof vi.fn>;
const createStateServiceMock = createStateService as unknown as ReturnType<typeof vi.fn>;

const session: UserSession = {
  email: 'test@example.com',
  userId: 'user-1',
  isAdmin: true,
  accessToken: 'token',
};

const originalStateTable = process.env.STATE_TABLE;

function makeStateChannel(overrides: Partial<ChannelState>): ChannelState {
  return {
    avatarId: 'avatar-1',
    channelId: '-100state',
    platform: 'telegram',
    recentMessages: [],
    lastActivityAt: 100,
    messageCount: 1,
    ...overrides,
  };
}

function makeServiceContainer(overrides: Partial<ServiceContainer> = {}): ServiceContainer {
  const telegram = {
    getUserProfilePhotos: vi.fn(),
    getFileUrl: vi.fn(),
    getBotName: vi.fn(),
    setBotName: vi.fn(),
    getBotDescription: vi.fn(),
    setBotDescription: vi.fn(),
    getBotShortDescription: vi.fn(),
    setBotShortDescription: vi.fn(),
    sendChatAction: vi.fn(),
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
  };

  const base = {
    avatars: {
      getAvatar: vi.fn().mockResolvedValue({
        avatarId: 'avatar-1',
        platforms: { telegram: { enabled: true } },
      }),
    },
    secrets: {
      _getSecretValueInternal: vi.fn().mockResolvedValue('telegram-token'),
    },
    telegram,
    discord: {
      getConnectionStatus: vi.fn(),
      sendMessage: vi.fn(),
      sendWebhookMessage: vi.fn(),
      getChannel: vi.fn(),
      listChannels: vi.fn(),
      listGuilds: vi.fn(),
      getMessages: vi.fn(),
      addReaction: vi.fn(),
      removeReaction: vi.fn(),
    },
    chatVoting: {
      getChatBots: vi.fn(),
      createProposal: vi.fn(),
      voteOnProposal: vi.fn(),
      getActiveProposals: vi.fn(),
      getProposal: vi.fn(),
      canModifyChat: vi.fn(),
      executeModification: vi.fn(),
      computeProposalCounts: vi.fn((proposal) => proposal),
    },
    integrations: {
      getIntegrationStatus: vi.fn(),
      getAllIntegrationStatuses: vi.fn(),
      testIntegrationConnection: vi.fn(),
      setModelPreference: vi.fn(),
    },
    telegramAdmin: {
      diagnoseTelegram: vi.fn(),
      setupTelegramIntegration: vi.fn(),
    },
    modelsRegistry: {
      getModelsForCapability: vi.fn(() => []),
      AVAILABLE_MODELS: [],
    },
    createTwitterServices: vi.fn(() => undefined),
  } as unknown as ServiceContainer;

  return {
    ...base,
    ...overrides,
  } as ServiceContainer;
}

describe('createPlatformServices Telegram chat services', () => {
  beforeEach(() => {
    process.env.STATE_TABLE = 'state-table';
    presenceService.getChannelsForPlatform.mockReset();
    stateService.getChannelStatesForPlatform.mockReset();
    createPresenceServiceMock.mockClear();
    createStateServiceMock.mockClear();
  });

  afterEach(() => {
    if (originalStateTable === undefined) {
      delete process.env.STATE_TABLE;
    } else {
      process.env.STATE_TABLE = originalStateTable;
    }
  });

  it('lists known Telegram chats from config, presence, and state', async () => {
    const presenceChannels: ChannelInfo[] = [
      {
        channelId: '-100presence',
        platform: 'telegram',
        title: 'Presence Chat',
        type: 'supergroup',
        lastActivityAt: 200,
        summary: 'recent presence summary',
      },
    ];
    const stateChannels = [
      makeStateChannel({
        channelId: '-100state',
        chatTitle: 'State Chat',
        chatType: 'group',
        lastActivityAt: 300,
        summary: 'state summary',
      }),
      makeStateChannel({
        channelId: '-100allowed',
        chatTitle: 'Allowed From State',
        chatType: 'supergroup',
        lastActivityAt: 250,
      }),
    ];

    presenceService.getChannelsForPlatform.mockResolvedValue(presenceChannels);
    stateService.getChannelStatesForPlatform.mockResolvedValue(stateChannels);

    const svc = makeServiceContainer({
      avatars: {
        getAvatar: vi.fn().mockResolvedValue({
          avatarId: 'avatar-1',
          platforms: {
            telegram: {
              enabled: true,
              homeChannelId: '-100home',
              homeChannelUsername: 'home_chat',
              allowedChats: [{ chatId: '-100allowed', title: 'Allowed Chat' }],
              allowedChatIds: ['-100legacy'],
            },
          },
        }),
      } as unknown as ServiceContainer['avatars'],
    });

    const services = createPlatformServices('avatar-1', session, svc);
    const chats = await services.telegram!.listChats!('avatar-1');

    expect(createPresenceService).toHaveBeenCalledWith('state-table');
    expect(createStateService).toHaveBeenCalledWith('state-table');
    expect(presenceService.getChannelsForPlatform).toHaveBeenCalledWith('avatar-1', 'telegram');
    expect(stateService.getChannelStatesForPlatform).toHaveBeenCalledWith('avatar-1', 'telegram');
    expect(chats.map((chat) => String(chat.chatId))).toEqual([
      '-100state',
      '-100allowed',
      '-100presence',
      '-100home',
      '-100legacy',
    ]);
    expect(chats.find((chat) => chat.chatId === '-100allowed')).toMatchObject({
      title: 'Allowed From State',
      type: 'supergroup',
    });
  });

  it('falls back to Telegram avatar config when state table access is unavailable', async () => {
    delete process.env.STATE_TABLE;

    const svc = makeServiceContainer({
      avatars: {
        getAvatar: vi.fn().mockResolvedValue({
          avatarId: 'avatar-1',
          platforms: {
            telegram: {
              enabled: true,
              allowedChats: [{ chatId: '-100allowed', title: 'Allowed Chat' }],
            },
          },
        }),
      } as unknown as ServiceContainer['avatars'],
    });

    const services = createPlatformServices('avatar-1', session, svc);
    const chats = await services.telegram!.discoverChats!('avatar-1');

    expect(createPresenceService).not.toHaveBeenCalled();
    expect(createStateService).not.toHaveBeenCalled();
    expect(chats).toEqual([
      {
        chatId: '-100allowed',
        title: 'Allowed Chat',
        username: undefined,
        type: 'supergroup',
      },
    ]);
  });

  it('keeps config-backed chat listing available when presence lookup fails', async () => {
    presenceService.getChannelsForPlatform.mockRejectedValue(new Error('DynamoDB denied'));
    stateService.getChannelStatesForPlatform.mockResolvedValue([]);

    const svc = makeServiceContainer({
      avatars: {
        getAvatar: vi.fn().mockResolvedValue({
          avatarId: 'avatar-1',
          platforms: {
            telegram: {
              enabled: true,
              allowedChats: [{ chatId: '-100allowed', title: 'Allowed Chat' }],
            },
          },
        }),
      } as unknown as ServiceContainer['avatars'],
    });

    const services = createPlatformServices('avatar-1', session, svc);
    const chats = await services.telegram!.listChats!('avatar-1');

    expect(chats).toEqual([
      {
        chatId: '-100allowed',
        title: 'Allowed Chat',
        username: undefined,
        type: 'supergroup',
      },
    ]);
  });

  it('returns chat info and summary for known Telegram chats', async () => {
    presenceService.getChannelsForPlatform.mockResolvedValue([
      {
        channelId: '-100presence',
        platform: 'telegram',
        title: 'Presence Chat',
        type: 'supergroup',
        lastActivityAt: 200,
        summary: 'recent presence summary',
      },
    ] satisfies ChannelInfo[]);
    stateService.getChannelStatesForPlatform.mockResolvedValue([]);

    const services = createPlatformServices('avatar-1', session, makeServiceContainer());

    await expect(services.telegram!.getChatInfo!('avatar-1', '-100presence')).resolves.toMatchObject({
      chatId: '-100presence',
      title: 'Presence Chat',
      summary: 'recent presence summary',
    });
    await expect(services.telegram!.getChatSummary!('avatar-1', '-100presence')).resolves.toBe('recent presence summary');
    await expect(services.telegram!.getChatInfo!('avatar-1', '-100missing')).resolves.toBeNull();
  });

  it('sends Telegram messages through the existing token lookup and API service', async () => {
    presenceService.getChannelsForPlatform.mockResolvedValue([]);
    stateService.getChannelStatesForPlatform.mockResolvedValue([]);

    const telegram = {
      getUserProfilePhotos: vi.fn(),
      getFileUrl: vi.fn(),
      getBotName: vi.fn(),
      setBotName: vi.fn(),
      getBotDescription: vi.fn(),
      setBotDescription: vi.fn(),
      getBotShortDescription: vi.fn(),
      setBotShortDescription: vi.fn(),
      sendChatAction: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ messageId: 42 }),
      setMessageReaction: vi.fn(),
    };
    const secrets = {
      _getSecretValueInternal: vi.fn().mockResolvedValue('telegram-token'),
    };
    const svc = makeServiceContainer({
      telegram: telegram as unknown as ServiceContainer['telegram'],
      secrets: secrets as unknown as ServiceContainer['secrets'],
    });

    const services = createPlatformServices('avatar-1', session, svc);
    const result = await services.telegram!.sendToChat!('avatar-1', '-1001', 'hello', {
      replyToMessageId: 99,
    });

    expect(secrets._getSecretValueInternal).toHaveBeenCalledWith('avatar-1', 'telegram_bot_token', 'default');
    expect(telegram.sendMessage).toHaveBeenCalledWith('telegram-token', -1001, 'hello', {
      replyToMessageId: 99,
    });
    expect(result).toEqual({ messageId: 42 });
  });
});
