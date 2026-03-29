/**
 * Platform MCP Adapter Tests
 *
 * Tests covering:
 * - ADMIN_TABLE validation (existing)
 * - createPlatformMCPServices: read-only service stubs
 * - createPlatformMCPServices: write operations throw from platform handlers
 * - createPlatformMCPServices: media credits preflight
 * - createPlatformMCPServices: wallet listing
 * - createPlatformMCPServices: profile/model read-only access
 *
 * @see packages/handlers/src/services/platform-mcp-adapter.ts
 * @see https://github.com/cenetex/aws-swarm/issues/233
 * @see https://github.com/cenetex/aws-swarm/issues/353
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getAdminTable, _resetAdminTableCache } from './platform-mcp-adapter.js';
import { createPlatformMCPServices } from './platform-mcp-adapter.js';
import { _setDynamoClient } from './dynamo-client.js';
import type { AvatarConfig, StateService } from '@swarm/core';

// =============================================================================
// Existing: getAdminTable validation
// =============================================================================

describe('getAdminTable', () => {
  let originalAdminTable: string | undefined;

  beforeEach(() => {
    originalAdminTable = process.env.ADMIN_TABLE;
    _resetAdminTableCache();
  });

  afterEach(() => {
    // Restore original value
    if (originalAdminTable !== undefined) {
      process.env.ADMIN_TABLE = originalAdminTable;
    } else {
      delete process.env.ADMIN_TABLE;
    }
    _resetAdminTableCache();
  });

  it('throws when ADMIN_TABLE is not set', () => {
    delete process.env.ADMIN_TABLE;
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('throws when ADMIN_TABLE is empty string', () => {
    process.env.ADMIN_TABLE = '';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('throws when ADMIN_TABLE is whitespace only', () => {
    process.env.ADMIN_TABLE = '   ';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is required but not set',
    );
  });

  it('returns the env value when ADMIN_TABLE is set', () => {
    process.env.ADMIN_TABLE = 'SwarmAdmin-staging';
    expect(getAdminTable()).toBe('SwarmAdmin-staging');
  });

  it('trims surrounding whitespace from ADMIN_TABLE', () => {
    process.env.ADMIN_TABLE = '  SwarmAdmin-staging  ';
    expect(getAdminTable()).toBe('SwarmAdmin-staging');
  });

  it('throws when ADMIN_TABLE contains invalid characters', () => {
    process.env.ADMIN_TABLE = 'Swarm Admin staging';
    expect(() => getAdminTable()).toThrow(
      'ADMIN_TABLE environment variable is invalid',
    );
  });

  it('throws when ADMIN_TABLE is shorter than DynamoDB minimum length', () => {
    process.env.ADMIN_TABLE = 'ab';
    expect(() => getAdminTable()).toThrow(
      'Expected 3-255 characters',
    );
  });

  it('accepts ADMIN_TABLE at DynamoDB maximum length', () => {
    process.env.ADMIN_TABLE = 'a'.repeat(255);
    expect(getAdminTable()).toBe('a'.repeat(255));
  });

  it('throws when ADMIN_TABLE exceeds DynamoDB maximum length', () => {
    process.env.ADMIN_TABLE = 'a'.repeat(256);
    expect(() => getAdminTable()).toThrow(
      'Expected 3-255 characters',
    );
  });

  it('caches the value across calls', () => {
    process.env.ADMIN_TABLE = 'SwarmAdmin-staging';
    const first = getAdminTable();
    // Even if env changes after first read, cached value should persist
    process.env.ADMIN_TABLE = 'SwarmAdmin-other';
    const second = getAdminTable();
    expect(first).toBe(second);
    expect(second).toBe('SwarmAdmin-staging');
  });

  it('does not default to SwarmAdmin-prod', () => {
    delete process.env.ADMIN_TABLE;
    try {
      getAdminTable();
    } catch {
      // expected
    }
    // Ensure no production fallback leaks through
    process.env.ADMIN_TABLE = 'MyTable';
    _resetAdminTableCache();
    expect(getAdminTable()).not.toBe('SwarmAdmin-prod');
  });
});

// =============================================================================
// NEW: createPlatformMCPServices
// =============================================================================

/**
 * Build minimal AvatarConfig for testing.
 * Only provides the fields required by createPlatformMCPServices.
 */
function buildTestAvatarConfig(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    name: 'TestAvatar',
    persona: 'A test avatar',
    llm: {
      model: 'claude-3-haiku-20240307',
      provider: 'anthropic',
      temperature: 0.7,
      maxTokens: 1024,
    },
    platforms: {},
    media: {
      image: {
        model: 'black-forest-labs/flux-schnell',
        provider: 'replicate',
      },
    },
    brain: {},
    ...overrides,
  } as AvatarConfig;
}

/**
 * Build a minimal stub of StateService for testing.
 * We only need the interface shape - real methods won't be called in these tests.
 */
function buildTestStateService(): StateService {
  return {
    getAvatarConfig: async () => null,
    getAvatarConfigWithStatus: async () => null,
    checkAndSetIdempotency: async () => true,
    addMessageToChannel: async () => {},
  } as unknown as StateService;
}

/**
 * Create a mock DynamoDB client for testing.
 */
function createMockClient(sendFn: (...args: unknown[]) => Promise<unknown>) {
  return { send: sendFn } as any;
}

describe('createPlatformMCPServices', () => {
  let originalAdminTable: string | undefined;

  beforeEach(() => {
    originalAdminTable = process.env.ADMIN_TABLE;
    process.env.ADMIN_TABLE = 'TestTable';
    _resetAdminTableCache();
    _setDynamoClient(null);  // Reset the DynamoDB client mock
  });

  afterEach(() => {
    if (originalAdminTable !== undefined) {
      process.env.ADMIN_TABLE = originalAdminTable;
    } else {
      delete process.env.ADMIN_TABLE;
    }
    _resetAdminTableCache();
    _setDynamoClient(null);  // Clean up the mock client
  });

  // ---------------------------------------------------------------------------
  // Profile services (read-only)
  // ---------------------------------------------------------------------------

  describe('profile service', () => {
    it('getProfile returns avatar name and persona', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({ name: 'MyBot', persona: 'A helpful bot' }),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const profile = await services.profile.getProfile();
      expect(profile.name).toBe('MyBot');
      expect(profile.persona).toBe('A helpful bot');
    });

    it('updateProfile throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.profile.updateProfile()).rejects.toThrow(
        'Profile updates not allowed from platform handlers',
      );
    });

    it('setProfileImage throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.profile.setProfileImage()).rejects.toThrow(
        'Profile uploads not allowed from platform handlers',
      );
    });

    it('getProfileUploadUrl throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.profile.getProfileUploadUrl()).rejects.toThrow(
        'Profile uploads not allowed from platform handlers',
      );
    });

    it('saveProfileImage throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.profile.saveProfileImage()).rejects.toThrow(
        'Profile uploads not allowed from platform handlers',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Model services (read-only)
  // ---------------------------------------------------------------------------

  describe('models service', () => {
    it('listModels returns empty array', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const models = await services.models.listModels();
      expect(models).toEqual([]);
    });

    it('getConfig returns avatar LLM configuration', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          llm: {
            model: 'gpt-4',
            provider: 'openai',
            temperature: 0.5,
            maxTokens: 2048,
          },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const config = await services.models.getConfig();
      expect(config.model).toBe('gpt-4');
      expect(config.provider).toBe('openai');
      expect(config.temperature).toBe(0.5);
      expect(config.maxTokens).toBe(2048);
    });

    it('updateConfig throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.models.updateConfig()).rejects.toThrow(
        'Model changes not allowed from platform handlers',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Wallet services
  // ---------------------------------------------------------------------------

  describe('wallets service', () => {
    it('listWallets returns empty array when no wallets provided', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const wallets = await services.wallets.listWallets();
      expect(wallets).toEqual([]);
    });

    it('listWallets returns provided wallets with zero balances', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
        wallets: [
          { name: 'sol-wallet', publicKey: 'abc123', walletType: 'solana' },
          { name: 'eth-wallet', publicKey: 'def456', address: '0xABC', walletType: 'ethereum' },
        ],
      });

      const wallets = await services.wallets.listWallets();
      expect(wallets).toHaveLength(2);

      expect(wallets[0].name).toBe('sol-wallet');
      expect(wallets[0].publicKey).toBe('abc123');
      expect(wallets[0].walletType).toBe('solana');
      expect(wallets[0].balance).toBe(0);
      expect(wallets[0].solBalance).toBe(0);
      expect(wallets[0].ethBalance).toBeUndefined();

      expect(wallets[1].name).toBe('eth-wallet');
      expect(wallets[1].address).toBe('0xABC');
      expect(wallets[1].walletType).toBe('ethereum');
      expect(wallets[1].ethBalance).toBe(0);
      expect(wallets[1].solBalance).toBeUndefined();
    });

    // createWallet test removed — custodial wallet generation deprecated (#608)

    it('getBalance returns zero balance for any chain', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const solBalance = await services.wallets.getBalance('pubkey', 'test-avatar', 'solana');
      expect(solBalance.balance).toBe(0);
      expect(solBalance.chain).toBe('solana');
      expect(solBalance.solBalance).toBe(0);
      expect(solBalance.solBalanceLamports).toBe(0);
      expect(solBalance.tokens).toEqual([]);

      const ethBalance = await services.wallets.getBalance('pubkey', 'test-avatar', 'ethereum');
      expect(ethBalance.balance).toBe(0);
      expect(ethBalance.chain).toBe('ethereum');
      expect(ethBalance.ethBalance).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Secrets services (no access from platform)
  // ---------------------------------------------------------------------------

  describe('secrets service', () => {
    it('listSecrets returns empty array', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const secrets = await services.secrets.listSecrets();
      expect(secrets).toEqual([]);
    });

    it('storeSecret throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.secrets.storeSecret()).rejects.toThrow(
        'Secret management not allowed from platform handlers',
      );
    });

    it('validateTelegramToken returns valid for non-empty token', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.secrets.validateTelegramToken('123:ABC');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('validateTelegramToken returns invalid for empty token', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.secrets.validateTelegramToken('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('No token');
    });
  });

  // ---------------------------------------------------------------------------
  // Jobs services (simplified)
  // ---------------------------------------------------------------------------

  describe('jobs service', () => {
    it('getPendingJobs returns empty array', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const jobs = await services.jobs.getPendingJobs();
      expect(jobs).toEqual([]);
    });

    it('getJob returns null', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const job = await services.jobs.getJob();
      expect(job).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Reference images (not available from platform)
  // ---------------------------------------------------------------------------

  describe('reference service', () => {
    it('listReferenceImages returns empty array', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const images = await services.reference.listReferenceImages();
      expect(images).toEqual([]);
    });

    it('getUploadUrl throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.reference.getUploadUrl()).rejects.toThrow(
        'Reference uploads not allowed from platform handlers',
      );
    });

    it('saveReferenceImage throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.reference.saveReferenceImage()).rejects.toThrow(
        'Reference uploads not allowed from platform handlers',
      );
    });

    it('deleteReferenceImage throws from platform handlers', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.reference.deleteReferenceImage()).rejects.toThrow(
        'Reference deletes not allowed from platform handlers',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Media services - profile/reference image read access
  // ---------------------------------------------------------------------------

  describe('media service - image URL access', () => {
    it('getProfileImageUrl returns avatar profile image URL', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          profileImage: { url: 'https://cdn.example.com/profile.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getProfileImageUrl();
      expect(url).toBe('https://cdn.example.com/profile.png');
    });

    it('getProfileImageUrl returns undefined when no profile image', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getProfileImageUrl();
      expect(url).toBeUndefined();
    });

    it('getCharacterReferenceUrl returns character reference URL', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          characterReference: { url: 'https://cdn.example.com/char-ref.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getCharacterReferenceUrl();
      expect(url).toBe('https://cdn.example.com/char-ref.png');
    });

    it('getBestReferenceImageUrl prefers character reference over profile image', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          characterReference: { url: 'https://cdn.example.com/char-ref.png' },
          profileImage: { url: 'https://cdn.example.com/profile.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getBestReferenceImageUrl();
      expect(url).toBe('https://cdn.example.com/char-ref.png');
    });

    it('getBestReferenceImageUrl falls back to profile image when no character reference', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          profileImage: { url: 'https://cdn.example.com/profile.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getBestReferenceImageUrl();
      expect(url).toBe('https://cdn.example.com/profile.png');
    });

    it('getReferenceImageUrl returns character reference for character category', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          characterReference: { url: 'https://cdn.example.com/char-ref.png' },
          profileImage: { url: 'https://cdn.example.com/profile.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getReferenceImageUrl('test-avatar', 'character');
      expect(url).toBe('https://cdn.example.com/char-ref.png');
    });

    it('getReferenceImageUrl falls back to profile image for non-character category', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({
          characterReference: { url: 'https://cdn.example.com/char-ref.png' },
          profileImage: { url: 'https://cdn.example.com/profile.png' },
        } as Partial<AvatarConfig>),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const url = await services.media.getReferenceImageUrl('test-avatar', 'style');
      expect(url).toBe('https://cdn.example.com/profile.png');
    });
  });

  // ---------------------------------------------------------------------------
  // Media credits (preflight checks)
  // ---------------------------------------------------------------------------

  describe('mediaCredits service', () => {
    it('canUseTool allows non-media tools unconditionally', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.mediaCredits.canUseTool('test-avatar', 'recall_memory');
      expect(result.allowed).toBe(true);
    });

    it('consumeCredit always returns true (platform stub)', async () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.mediaCredits.consumeCredit();
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Memory services (wired to brain adapter)
  // ---------------------------------------------------------------------------

  describe('memory service', () => {
    it('exposes remember and recall methods', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(typeof services.memory.remember).toBe('function');
      expect(typeof services.memory.recall).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Twitter/Discord services should not be present without config
  // ---------------------------------------------------------------------------

  describe('conditional platform services', () => {
    it('does not include twitter service when twitter is not configured', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({ platforms: {} }),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect('twitter' in services).toBe(false);
    });

    it('does not include discord service when discord is not configured', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig({ platforms: {} }),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect('discord' in services).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Voice services
  // ---------------------------------------------------------------------------

  describe('voice service', () => {
    it('exposes voice services with entitlement-gated methods', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(services.voice).toBeDefined();
      expect(typeof services.voice.generateVoiceMessage).toBe('function');
      expect(typeof services.voice.sendVoiceMessage).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Token launch services
  // ---------------------------------------------------------------------------

  describe('tokenLaunch service', () => {
    it('exposes token launch methods', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(typeof services.tokenLaunch.preflightLaunch).toBe('function');
      expect(typeof services.tokenLaunch.launchToken).toBe('function');
      expect(typeof services.tokenLaunch.getTokenStatus).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Billing services
  // ---------------------------------------------------------------------------

  describe('billing service', () => {
    it('exposes billing methods', () => {
      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      expect(typeof services.billing.createCheckoutSession).toBe('function');
      expect(typeof services.billing.createPortalSession).toBe('function');
      expect(typeof services.billing.getBillingStatus).toBe('function');
      expect(typeof services.billing.getUsage).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Gallery services — storage unification (issue #821)
  // ---------------------------------------------------------------------------

  describe('gallery service - write-then-read unification', () => {
    it('getGallery reads from ADMIN_TABLE (not STATE_TABLE)', async () => {
      const galleryItems = [
        {
          id: 'img_123',
          url: 'https://cdn.example.com/image1.png',
          s3Key: 'avatars/test-avatar/images/123.png',
          type: 'image',
          prompt: 'a sunset',
          platform: 'telegram',
          createdAt: 1000000,
        },
      ];

      let tableName: string | undefined;
      const mockClient = createMockClient(async (cmd: unknown) => {
        // Verify the query targets ADMIN_TABLE (TestTable), not STATE_TABLE
        const input = (cmd as { input?: { TableName?: string } }).input;
        tableName = input?.TableName;
        expect(tableName).toBe('TestTable');
        return { Items: galleryItems };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.getGallery('test-avatar');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img_123');
      expect(result[0].url).toBe('https://cdn.example.com/image1.png');
    });

    it('searchGallery reads from ADMIN_TABLE', async () => {
      let tableName: string | undefined;
      const mockClient = createMockClient(async (cmd: unknown) => {
        const input = (cmd as { input?: { TableName?: string } }).input;
        tableName = input?.TableName;
        expect(tableName).toBe('TestTable');
        return {
          Items: [
            {
              id: 'img_456',
              url: 'https://cdn.example.com/sunset.png',
              s3Key: 'avatars/test-avatar/images/456.png',
              type: 'image',
              prompt: 'beautiful sunset over ocean',
              createdAt: 2000000,
            },
          ],
        };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.searchGallery('test-avatar', 'sunset');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img_456');
      expect(result[0].prompt).toBe('beautiful sunset over ocean');
    });

    it('getGalleryItem reads from ADMIN_TABLE', async () => {
      let tableName: string | undefined;
      const mockClient = createMockClient(async (cmd: unknown) => {
        const input = (cmd as { input?: { TableName?: string } }).input;
        tableName = input?.TableName;
        expect(tableName).toBe('TestTable');
        return {
          Items: [
            {
              id: 'img_789',
              url: 'https://cdn.example.com/cat.png',
              s3Key: 'avatars/test-avatar/images/789.png',
              type: 'image',
              prompt: 'a cat',
              createdAt: 3000000,
            },
          ],
        };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.getGalleryItem('test-avatar', 'img_789');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('img_789');
    });
  });

  // ---------------------------------------------------------------------------
  // Gallery services — pagination regression (issue #234)
  // ---------------------------------------------------------------------------

  describe('gallery service - getGalleryItem pagination', () => {
    it('finds item beyond first 100 records via pagination', async () => {
      const targetItem = {
        id: 'target-item-id',
        url: 'https://cdn.example.com/old-image.png',
        s3Key: 'gallery/old-image.png',
        type: 'image',
        prompt: 'an old image',
        platform: 'telegram',
        createdAt: 1000000,
      };

      let callCount = 0;
      const mockClient = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          // First page: 100 items, none matching the filter; has more pages
          return {
            Items: [],  // FilterExpression removed non-matching items
            Count: 0,
            ScannedCount: 100,
            LastEvaluatedKey: { pk: 'AVATAR#test-avatar', sk: 'GALLERY#099' },
          };
        }
        // Second page: contains the target item
        return {
          Items: [targetItem],
          Count: 1,
          ScannedCount: 50,
          // No LastEvaluatedKey — this is the last page
        };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.getGalleryItem('test-avatar', 'target-item-id');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('target-item-id');
      expect(result!.url).toBe('https://cdn.example.com/old-image.png');
      expect(result!.type).toBe('image');
      expect(result!.prompt).toBe('an old image');
      expect(result!.createdAt).toBe(1000000);

      // Should have made exactly 2 DynamoDB queries (paginated)
      expect(callCount).toBe(2);
    });

    it('returns null when item does not exist across all pages', async () => {
      let callCount = 0;
      const mockClient = createMockClient(async () => {
        callCount++;
        if (callCount <= 2) {
          // Two pages of non-matching items
          return {
            Items: [],
            Count: 0,
            ScannedCount: 100,
            LastEvaluatedKey: { pk: 'AVATAR#test-avatar', sk: `GALLERY#page${callCount}` },
          };
        }
        // Final page — still no match, no more pages
        return {
          Items: [],
          Count: 0,
          ScannedCount: 30,
        };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.getGalleryItem('test-avatar', 'nonexistent-id');

      expect(result).toBeNull();
      // Should have paginated through all 3 pages
      expect(callCount).toBe(3);
    });

    it('returns item on first page without unnecessary pagination', async () => {
      let callCount = 0;
      const mockClient = createMockClient(async () => {
        callCount++;
        return {
          Items: [{
            id: 'first-page-item',
            url: 'https://cdn.example.com/image.png',
            s3Key: 'gallery/image.png',
            type: 'image',
            createdAt: 2000000,
          }],
          Count: 1,
          ScannedCount: 50,
          LastEvaluatedKey: { pk: 'AVATAR#test-avatar', sk: 'GALLERY#050' },
        };
      });

      _setDynamoClient(mockClient);

      const services = createPlatformMCPServices({
        avatarId: 'test-avatar',
        avatarConfig: buildTestAvatarConfig(),
        stateService: buildTestStateService(),
        secrets: {},
      });

      const result = await services.gallery.getGalleryItem('test-avatar', 'first-page-item');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('first-page-item');
      // Should NOT continue paginating after finding the item
      expect(callCount).toBe(1);
    });
  });
});
