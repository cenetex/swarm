import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord, UserSession } from '../types.js';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'test-admin-table';

const sendMock = vi.fn();
const syncAvatarConfigMock = vi.fn();
const decrementCreatorCountMock = vi.fn();
const removeAvatarFromAllHomeChannelsMock = vi.fn();
const deleteAllAvatarSecretsMock = vi.fn();

vi.mock('@swarm/core', () => ({
  DEFAULT_LLM_MODEL: 'test-model',
  DEFAULT_LLM_PROVIDER: 'openrouter',
  DEFAULT_LLM_TEMPERATURE: 0.8,
  DEFAULT_LLM_MAX_TOKENS: 1024,
}));

vi.mock('./config-sync.js', () => ({
  syncAvatarConfig: syncAvatarConfigMock,
}));

vi.mock('./web3/nft-gate.js', () => ({
  getGateStatus: vi.fn(),
  decrementCreatorCount: decrementCreatorCountMock,
  incrementCreatorCount: vi.fn(),
  checkNFTGate: vi.fn(),
  reserveCreatorSlot: vi.fn(),
  verifyNFTOwnership: vi.fn(),
  isCollectionWhitelisted: vi.fn(),
}));

vi.mock('./secrets.js', () => ({
  storeSecret: vi.fn(),
  deleteAllAvatarSecrets: deleteAllAvatarSecretsMock,
}));

vi.mock('./telegram.js', () => ({
  registerTelegramWebhook: vi.fn(),
  generateWebhookSecret: vi.fn(),
}));

vi.mock('./home-channel.js', () => ({
  registerHomeChannel: vi.fn(),
  removeAvatarFromAllHomeChannels: removeAvatarFromAllHomeChannelsMock,
}));

vi.mock('./billing/entitlements.js', () => ({
  clearStripeDataForAvatar: vi.fn(),
}));

vi.mock('./dynamo-client.js', () => ({
  getDynamoClient: () => ({
    send: sendMock,
  }),
}));

vi.mock('./funnel-emitter.js', () => ({
  emitAvatarCreated: vi.fn(),
  emitAvatarCreationFailed: vi.fn(),
}));

const { deleteAvatar } = await import('./avatars.js');

const session = {
  email: 'test@example.com',
} as UserSession;

function makeAvatar(overrides: Partial<AvatarRecord> = {}): AvatarRecord {
  const now = Date.now();
  return {
    pk: 'AVATAR#nft-avatar',
    sk: 'CONFIG',
    avatarId: 'nft-avatar',
    name: 'NFT Avatar',
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: 'openrouter',
      model: 'test-model',
      temperature: 0.8,
      maxTokens: 1024,
      useGlobalKey: true,
    },
    currentEra: 0,
    status: 'active',
    creatorWallet: 'wallet-1',
    createdAt: now,
    createdBy: 'test@example.com',
    updatedAt: now,
    updatedBy: 'test@example.com',
    ...overrides,
  };
}

describe('avatars deleteAvatar', () => {
  beforeEach(() => {
    sendMock.mockReset();
    syncAvatarConfigMock.mockReset();
    decrementCreatorCountMock.mockReset();
    removeAvatarFromAllHomeChannelsMock.mockReset();
    deleteAllAvatarSecretsMock.mockReset();
  });

  it('releases claimed NFT mint markers when deleting NFT-backed avatars', async () => {
    const avatar = makeAvatar({ nftMint: 'mint-123' });

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: avatar };
      }
      if (command instanceof PutCommand) {
        return {};
      }
      if (command instanceof DeleteCommand) {
        return {};
      }
      throw new Error(`Unexpected command: ${String((command as { constructor?: { name?: string } }).constructor?.name)}`);
    });

    await deleteAvatar('nft-avatar', session);

    expect(decrementCreatorCountMock).toHaveBeenCalledWith('wallet-1');
    expect(syncAvatarConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: 'nft-avatar', status: 'deleted' })
    );

    const deleteCommand = sendMock.mock.calls
      .map(([command]) => command)
      .find((command): command is DeleteCommand => command instanceof DeleteCommand);

    expect(deleteCommand).toBeDefined();
    expect(deleteCommand?.input).toMatchObject({
      TableName: 'test-admin-table',
      Key: {
        pk: 'CLAIMED_NFT#mint-123',
        sk: 'AVATAR',
      },
    });
  });
});
