import { beforeEach, afterEach, describe, expect, it, spyOn, mock } from 'bun:test';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord, UserSession } from '../types.js';
import { _setDynamoClient } from './dynamo-client.js';
import * as configSync from './config-sync.js';

// Dynamic import with query param to bypass vi.mock() from handler tests
const { deleteAvatar } = await import('./avatars.js?test');
type DeleteAvatarDeps = import('./avatars.js').DeleteAvatarDeps;

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
  let sendMock: ReturnType<typeof spyOn>;
  let syncConfigSpy: ReturnType<typeof spyOn>;
  let mockDeps: DeleteAvatarDeps;

  beforeEach(() => {
    process.env.ADMIN_TABLE = 'test-admin-table';

    const mockClient = { send: async () => ({}) };
    sendMock = spyOn(mockClient, 'send');
    _setDynamoClient(mockClient as unknown as DynamoDBDocumentClient);

    // Spy on syncAvatarConfig (called internally by updateAvatar)
    syncConfigSpy = spyOn(configSync, 'syncAvatarConfig').mockResolvedValue(undefined as never);

    // Inject deps via DI to avoid vi.mock() bleed
    mockDeps = {
      decrementCreatorCount: mock(async () => {}) as DeleteAvatarDeps['decrementCreatorCount'],
      removeAvatarFromAllHomeChannels: mock(async () => {}) as DeleteAvatarDeps['removeAvatarFromAllHomeChannels'],
      deleteAllAvatarSecrets: mock(async () => {}) as DeleteAvatarDeps['deleteAllAvatarSecrets'],
    };
  });

  afterEach(() => {
    _setDynamoClient(null);
    syncConfigSpy.mockRestore();
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

    await deleteAvatar('nft-avatar', session, mockDeps);

    expect(mockDeps.decrementCreatorCount).toHaveBeenCalledWith('wallet-1');
    expect(syncConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: 'nft-avatar', status: 'deleted' })
    );

    const deleteCall = sendMock.mock.calls
      .map(([command]) => command)
      .find((command): command is DeleteCommand => command instanceof DeleteCommand);

    expect(deleteCall).toBeDefined();
    expect(deleteCall?.input).toMatchObject({
      TableName: 'test-admin-table',
      Key: {
        pk: 'CLAIMED_NFT#mint-123',
        sk: 'AVATAR',
      },
    });
  });
});
