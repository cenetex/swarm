import { beforeEach, afterEach, describe, expect, it, spyOn, mock, afterAll } from 'bun:test';
import type { AvatarRecord, UserSession } from '../types.js';
import { _setDynamoClient } from './dynamo-client.js';
import * as configSync from './config-sync.js';
import { DeleteCommand, GetCommand, PutCommand } from '@swarm/core';

// Dynamic import with query param to bypass vi.mock() from handler tests
const {
  deleteAvatar,
  assertAvatarOwnership,
  AvatarOwnershipError,
} = await import('./avatars.js?test');
type DeleteAvatarDeps = import('./avatars.js').DeleteAvatarDeps;

// Cache-layer mock lives in a separate module — mock it directly so the
// avatars.ts code under test calls our stub rather than Helius.
import * as nftOwnershipCache from './nft-ownership-cache.js';
import * as auditLog from './audit-log.js';

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
      getTelegramBotToken: mock(async () => null) as DeleteAvatarDeps['getTelegramBotToken'],
      deleteTelegramWebhook: mock(async () => true) as DeleteAvatarDeps['deleteTelegramWebhook'],
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

  it('does not decrement creator slots when deleting scan-created NFT slot avatars', async () => {
    const avatar = makeAvatar({
      nftMint: 'mint-123',
      slotType: 'nft',
    });

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

    expect(mockDeps.decrementCreatorCount).not.toHaveBeenCalled();

    const deleteCall = sendMock.mock.calls
      .map(([command]) => command)
      .find((command): command is DeleteCommand => command instanceof DeleteCommand);

    expect(deleteCall).toBeDefined();
    expect(deleteCall?.input).toMatchObject({
      Key: {
        pk: 'CLAIMED_NFT#mint-123',
        sk: 'AVATAR',
      },
    });
  });

  // #1464 — When Telegram is enabled, deregister the webhook BEFORE wiping
  // secrets; otherwise the webhook is orphaned and Telegram keeps POSTing.
  it('deregisters the Telegram webhook before secrets are deleted', async () => {
    const avatar = makeAvatar({
      platforms: { telegram: { enabled: true, botUsername: 'testbot' } },
    });

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: avatar };
      if (command instanceof PutCommand) return {};
      if (command instanceof DeleteCommand) return {};
      throw new Error(`Unexpected command: ${String((command as { constructor?: { name?: string } }).constructor?.name)}`);
    });

    mockDeps.getTelegramBotToken = mock(async () => 'bot-token-xyz') as DeleteAvatarDeps['getTelegramBotToken'];

    const callOrder: string[] = [];
    mockDeps.deleteTelegramWebhook = mock(async () => {
      callOrder.push('deleteTelegramWebhook');
      return true;
    }) as DeleteAvatarDeps['deleteTelegramWebhook'];
    mockDeps.deleteAllAvatarSecrets = mock(async () => {
      callOrder.push('deleteAllAvatarSecrets');
    }) as DeleteAvatarDeps['deleteAllAvatarSecrets'];

    await deleteAvatar('nft-avatar', session, mockDeps);

    expect(mockDeps.getTelegramBotToken).toHaveBeenCalledWith('nft-avatar');
    expect(mockDeps.deleteTelegramWebhook).toHaveBeenCalledWith('bot-token-xyz');
    expect(callOrder).toEqual(['deleteTelegramWebhook', 'deleteAllAvatarSecrets']);
  });

  it('skips webhook deregister when Telegram is not enabled', async () => {
    const avatar = makeAvatar({ platforms: {} });

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: avatar };
      return {};
    });

    await deleteAvatar('nft-avatar', session, mockDeps);

    expect(mockDeps.getTelegramBotToken).not.toHaveBeenCalled();
    expect(mockDeps.deleteTelegramWebhook).not.toHaveBeenCalled();
  });

  it('does not fail the delete when Telegram deregistration throws', async () => {
    const avatar = makeAvatar({
      platforms: { telegram: { enabled: true, botUsername: 'testbot' } },
    });

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: avatar };
      return {};
    });

    mockDeps.getTelegramBotToken = mock(async () => 'bot-token-xyz') as DeleteAvatarDeps['getTelegramBotToken'];
    mockDeps.deleteTelegramWebhook = mock(async () => {
      throw new Error('Telegram API unreachable');
    }) as DeleteAvatarDeps['deleteTelegramWebhook'];

    await deleteAvatar('nft-avatar', session, mockDeps);

    expect(mockDeps.deleteAllAvatarSecrets).toHaveBeenCalled();
    expect(syncConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: 'nft-avatar', status: 'deleted' })
    );
  });
});

// ── assertAvatarOwnership (#1385) ───────────────────────────────────────────
describe('avatars assertAvatarOwnership', () => {
  let sendMock: ReturnType<typeof spyOn>;
  let getCachedNFTOwnerSpy: ReturnType<typeof spyOn>;
  let recordAuditEventSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.ADMIN_TABLE = 'test-admin-table';
    const mockClient = { send: async () => ({}) };
    sendMock = spyOn(mockClient, 'send');
    _setDynamoClient(mockClient as unknown as DynamoDBDocumentClient);

    getCachedNFTOwnerSpy = spyOn(nftOwnershipCache, 'getCachedNFTOwner');
    recordAuditEventSpy = spyOn(auditLog, 'recordAuditEvent').mockResolvedValue({
      id: 'audit-1',
      avatarId: 'avatar-1',
      eventType: 'avatar_ownership_denied',
      actorId: 'x',
      actorType: 'owner',
      details: {},
      timestamp: Date.now(),
    });
  });

  afterEach(() => {
    _setDynamoClient(null);
    getCachedNFTOwnerSpy.mockRestore();
    recordAuditEventSpy.mockRestore();
  });

  function mockAvatarFound(avatar: AvatarRecord): void {
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: avatar };
      }
      return {};
    });
  }

  it('throws not_found when avatar does not exist', async () => {
    sendMock.mockImplementation(async () => ({}));
    const promise = assertAvatarOwnership('missing', 'wallet-1');
    await expect(promise).rejects.toBeInstanceOf(AvatarOwnershipError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found' });
  });

  it('non-NFT avatar: returns record when creatorWallet matches', async () => {
    const avatar = makeAvatar({ creatorWallet: 'wallet-match' });
    mockAvatarFound(avatar);
    const result = await assertAvatarOwnership('nft-avatar', 'wallet-match');
    expect(result.avatarId).toBe('nft-avatar');
    expect(getCachedNFTOwnerSpy).not.toHaveBeenCalled();
  });

  it('non-NFT avatar: throws not_owner on wallet mismatch', async () => {
    const avatar = makeAvatar({ creatorWallet: 'wallet-other' });
    mockAvatarFound(avatar);
    await expect(assertAvatarOwnership('nft-avatar', 'wallet-me')).rejects.toMatchObject({
      code: 'not_owner',
    });
    expect(getCachedNFTOwnerSpy).not.toHaveBeenCalled();
  });

  it('NFT avatar: returns record when cached owner matches caller', async () => {
    const avatar = makeAvatar({ creatorWallet: 'original', nftMint: 'mint-1' });
    mockAvatarFound(avatar);
    getCachedNFTOwnerSpy.mockResolvedValue('current-holder' as never);

    const result = await assertAvatarOwnership('nft-avatar', 'current-holder');
    expect(result.nftMint).toBe('mint-1');
    expect(getCachedNFTOwnerSpy).toHaveBeenCalledWith('mint-1');
  });

  it('NFT avatar: throws nft_revoked when current owner differs', async () => {
    const avatar = makeAvatar({ creatorWallet: 'original', nftMint: 'mint-1' });
    mockAvatarFound(avatar);
    getCachedNFTOwnerSpy.mockResolvedValue('new-holder' as never);

    await expect(assertAvatarOwnership('nft-avatar', 'original')).rejects.toMatchObject({
      code: 'nft_revoked',
    });
    expect(recordAuditEventSpy).toHaveBeenCalled();
  });

  it('NFT avatar: throws verification_unavailable when cache throws', async () => {
    const avatar = makeAvatar({ creatorWallet: 'original', nftMint: 'mint-1' });
    mockAvatarFound(avatar);
    getCachedNFTOwnerSpy.mockRejectedValue(new Error('helius down'));

    await expect(assertAvatarOwnership('nft-avatar', 'original')).rejects.toMatchObject({
      code: 'verification_unavailable',
    });
  });

  it('admin bypass: returns record even when wallet would not match', async () => {
    const avatar = makeAvatar({ creatorWallet: 'other', nftMint: 'mint-1' });
    mockAvatarFound(avatar);
    // Helius would normally be called — prove it isn't under admin bypass.
    getCachedNFTOwnerSpy.mockImplementation(() => {
      throw new Error('admin bypass should short-circuit before Helius');
    });

    const result = await assertAvatarOwnership('nft-avatar', 'unrelated-admin-wallet', {
      isAdmin: true,
    });
    expect(result.avatarId).toBe('nft-avatar');
    expect(getCachedNFTOwnerSpy).not.toHaveBeenCalled();
  });
});

afterAll(() => { mock.restore(); });
