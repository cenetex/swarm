/**
 * Tests for the lightweight ServiceContainer factory.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  createServiceContainer,
  getDefaultContainer,
  _setDefaultContainer,
  type ServiceContainer,
} from './service-container.js';

describe('createServiceContainer', () => {
  test('returns an object with all expected service keys', () => {
    const container = createServiceContainer();
    const expectedKeys: Array<keyof ServiceContainer> = [
      'avatars',
      'secrets',
      'wallets',
      'telegram',
      'discord',
      'media',
      'gallery',
      'credits',
      'mediaJobs',
      'voice',
      'avatarOwnership',
      'nftGate',
      'lineageNft',
      'propertyResearch',
      'stickers',
      'avatarObservability',
      'memory',
      'memoryMigration',
      'memoryConsolidation',
      'observability',
      'chatVoting',
      'chatHistory',
      'integrations',
      'tokenLaunch',
      'entitlements',
      'telegramAdmin',
      'replicate',
      'modelsRegistry',
      'stripe',
      'createWebSearch',
      'createMcpAdminServices',
      'createTwitterServices',
      'createStickerServices',
    ];
    for (const key of expectedKeys) {
      expect(container[key]).toBeDefined();
    }
  });

  test('overrides replace default services', () => {
    const mockAvatars = { getAvatar: async () => null } as unknown as ServiceContainer['avatars'];
    const container = createServiceContainer({ avatars: mockAvatars });
    expect(container.avatars).toBe(mockAvatars);
    // Other services should still be real
    expect(container.secrets).toBeDefined();
    expect(container.wallets).toBeDefined();
  });

  test('partial overrides do not affect unrelated services', () => {
    const mockMemory = { remember: async () => ({ saved: true }) } as unknown as ServiceContainer['memory'];
    const container = createServiceContainer({ memory: mockMemory });
    expect(container.memory).toBe(mockMemory);
    expect(container.avatars).not.toBe(mockMemory);
  });
});

describe('getDefaultContainer', () => {
  afterEach(() => {
    // Reset singleton
    _setDefaultContainer(null);
  });

  test('returns same instance on repeated calls', () => {
    const a = getDefaultContainer();
    const b = getDefaultContainer();
    expect(a).toBe(b);
  });

  test('_setDefaultContainer swaps the singleton', () => {
    const original = getDefaultContainer();
    const custom = createServiceContainer({
      avatars: { getAvatar: async () => null } as unknown as ServiceContainer['avatars'],
    });
    const prev = _setDefaultContainer(custom);
    expect(prev).toBe(original);
    expect(getDefaultContainer()).toBe(custom);
  });
});
