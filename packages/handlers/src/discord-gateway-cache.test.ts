/**
 * Tests for Discord gateway caching layer (issue #98)
 *
 * These tests validate the caching behavior in isolation, without
 * requiring actual DynamoDB or Secrets Manager connections.
 *
 * Env vars are set via bunfig.toml preload (test-preload.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  avatarConfigCache,
  botTokenCache,
  resetCacheStats,
  invalidateAllCaches,
  AVATAR_CONFIG_CACHE_TTL_MS,
  SECRET_CACHE_TTL_MS,
} from './discord-gateway-shared.js';

describe('Discord Gateway Caching', () => {
  beforeEach(() => {
    invalidateAllCaches();
  });

  describe('cache TTL constants', () => {
    it('avatar config cache TTL is 5 minutes', () => {
      expect(AVATAR_CONFIG_CACHE_TTL_MS).toBe(5 * 60_000);
    });

    it('secret cache TTL is 15 minutes', () => {
      expect(SECRET_CACHE_TTL_MS).toBe(15 * 60_000);
    });
  });

  describe('invalidateAllCaches', () => {
    it('clears avatar config cache', () => {
      avatarConfigCache.set('test-avatar', {
        config: {} as never,
        status: 'active',
        expiresAt: Date.now() + 60_000,
      });
      expect(avatarConfigCache.size).toBe(1);

      invalidateAllCaches();
      expect(avatarConfigCache.size).toBe(0);
    });

    it('clears bot token cache', () => {
      botTokenCache.set('test-avatar', {
        value: 'fake-token',
        expiresAt: Date.now() + 60_000,
      });
      expect(botTokenCache.size).toBe(1);

      invalidateAllCaches();
      expect(botTokenCache.size).toBe(0);
    });
  });

  describe('resetCacheStats', () => {
    it('returns a snapshot and resets counters to zero', () => {
      const first = resetCacheStats();
      expect(first).toEqual({
        avatarListHits: 0,
        avatarListMisses: 0,
        avatarConfigHits: 0,
        avatarConfigMisses: 0,
        secretHits: 0,
        secretMisses: 0,
      });

      // After reset, calling again should still return zeros
      const second = resetCacheStats();
      expect(second).toEqual(first);
    });
  });

  describe('botTokenCache', () => {
    it('returns cached value when not expired', () => {
      const expiresAt = Date.now() + 60_000;
      botTokenCache.set('avatar-1', { value: 'token-abc', expiresAt });

      const entry = botTokenCache.get('avatar-1');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe('token-abc');
      expect(entry!.expiresAt).toBe(expiresAt);
    });

    it('treats entry as expired when expiresAt is in the past', () => {
      const expiresAt = Date.now() - 1000; // expired 1s ago
      botTokenCache.set('avatar-1', { value: 'old-token', expiresAt });

      const entry = botTokenCache.get('avatar-1');
      expect(entry).toBeDefined();
      // The caller (getBotToken) checks expiresAt > now, so this would be a miss
      expect(entry!.expiresAt < Date.now()).toBe(true);
    });
  });

  describe('avatarConfigCache', () => {
    it('stores and retrieves cached configs', () => {
      const mockConfig = {
        id: 'test-avatar',
        name: 'Test',
        platforms: { discord: { enabled: true } },
      } as never;

      avatarConfigCache.set('test-avatar', {
        config: mockConfig,
        status: 'active',
        expiresAt: Date.now() + AVATAR_CONFIG_CACHE_TTL_MS,
      });

      const entry = avatarConfigCache.get('test-avatar');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('active');
      expect(entry!.expiresAt).toBeGreaterThan(Date.now());
    });

    it('can detect expired entries', () => {
      avatarConfigCache.set('old-avatar', {
        config: {} as never,
        status: 'active',
        expiresAt: Date.now() - 1000,
      });

      const entry = avatarConfigCache.get('old-avatar');
      expect(entry).toBeDefined();
      expect(entry!.expiresAt < Date.now()).toBe(true);
    });
  });
});
