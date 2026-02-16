/**
 * Memory Service Tests
 *
 * Tests for the memory service covering:
 * 1. Input validation (avatarId, content, themes, strength)
 * 2. Strength capping at MAX_STRENGTH
 * 3. Parallel query execution (getMemoryCounts)
 * 4. Batch operations (applyDecay)
 * 5. Transaction atomicity (promoteImmediateToRecent)
 * 6. Recency scoring in search
 * 7. Error handling throughout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AvatarMemory, MemoryTier } from '../types.js';
import * as memory from './memory.js';
import * as embedding from './embedding.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Mock DynamoDB document client
const mockSend = vi.fn(() => Promise.resolve({}));
const mockClient = {
  send: mockSend,
} as unknown as DynamoDBDocumentClient;

// Track transaction calls via spy on DynamoDBClient prototype
let transactionSendSpy: ReturnType<typeof vi.spyOn>;
const transactionCalls: unknown[] = [];
let embeddingServiceSpy: ReturnType<typeof vi.spyOn>;

describe('Memory Service', () => {
  beforeEach(() => {
    mockSend.mockReset();
    transactionCalls.length = 0;
    memory._setDynamoClient(mockClient);

    // Override getRetentionDaysForAvatar to avoid the dynamic
    // import('./entitlements.js') which conflicts with bun:test's
    // process-global mock.module in other test files.
    memory._setRetentionDaysOverride(async () => 30);

    // Avoid external calls during tests (Bedrock/OpenRouter).
    // Memory service should remain deterministic and fast.
    embedding._resetEmbeddingService();
    embeddingServiceSpy = vi.spyOn(embedding, 'getEmbeddingService').mockImplementation(() => ({
      modelId: 'test-embedding',
      dimensions: 3,
      embed: async () => [0, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [0, 0, 0]),
    }));

    // Spy on DynamoDBClient.prototype.send for transactions
    transactionSendSpy = vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation(
      async (command: unknown) => {
        transactionCalls.push(command);
        return {};
      }
    );
  });

  afterEach(() => {
    memory._setDynamoClient(null);
    memory._setRetentionDaysOverride(null);
    embedding._resetEmbeddingService();
    embeddingServiceSpy?.mockRestore();
    transactionSendSpy?.mockRestore();
  });

  // ==========================================================================
  // Issue 1: Input Validation Tests
  // ==========================================================================
  describe('Input Validation', () => {
    describe('avatarId validation', () => {
      it('should reject empty avatarId', async () => {
        await expect(memory.createMemory('', {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        })).rejects.toThrow('avatarId is required');
      });

      it('should reject null avatarId', async () => {
        await expect(memory.createMemory(null as unknown as string, {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        })).rejects.toThrow('avatarId is required');
      });

      it('should reject whitespace-only avatarId', async () => {
        await expect(memory.createMemory('   ', {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        })).rejects.toThrow('avatarId cannot be empty');
      });

      it('should reject avatarId with invalid characters', async () => {
        await expect(memory.createMemory('avatar@123!', {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        })).rejects.toThrow('avatarId contains invalid characters');
      });

      it('should reject avatarId that is too long', async () => {
        const longId = 'a'.repeat(101);
        await expect(memory.createMemory(longId, {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        })).rejects.toThrow('avatarId too long');
      });

      it('should accept valid avatarId with alphanumeric, dash, underscore', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('valid-agent_123', {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        });

        expect(result.avatarId).toBe('valid-agent_123');
      });

      it('should trim whitespace from avatarId', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('  my-avatar  ', {
          tier: 'immediate',
          type: 'fact',
          content: 'test content',
        });

        expect(result.avatarId).toBe('my-avatar');
      });
    });

    describe('content validation', () => {
      it('should reject empty content', async () => {
        await expect(memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: '',
        })).rejects.toThrow('content is required');
      });

      it('should reject whitespace-only content', async () => {
        await expect(memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: '   ',
        })).rejects.toThrow('content cannot be empty');
      });

      it('should truncate content exceeding MAX_CONTENT_LENGTH', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const longContent = 'x'.repeat(2500); // Exceeds 2000 char limit
        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: longContent,
        });

        expect(result.content.length).toBe(2000);
      });

      it('should trim whitespace from content', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: '  trimmed content  ',
        });

        expect(result.content).toBe('trimmed content');
      });
    });

    describe('themes validation', () => {
      it('should filter out non-string themes', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: 'test',
          themes: ['valid', null as unknown as string, 123 as unknown as string, 'also-valid'],
        });

        expect(result.themes).toEqual(['valid', 'also-valid']);
      });

      it('should filter out empty string themes', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: 'test',
          themes: ['valid', '', '  ', 'also-valid'],
        });

        expect(result.themes).toEqual(['valid', 'also-valid']);
      });

      it('should lowercase all themes', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: 'test',
          themes: ['UPPERCASE', 'MixedCase', 'lowercase'],
        });

        expect(result.themes).toEqual(['uppercase', 'mixedcase', 'lowercase']);
      });

      it('should limit themes to MAX_THEMES (10)', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const manyThemes = Array.from({ length: 15 }, (_, i) => `theme${i}`);
        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: 'test',
          themes: manyThemes,
        });

        expect(result.themes?.length).toBe(10);
      });

      it('should truncate individual themes to 50 characters', async () => {
        mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

        const longTheme = 'a'.repeat(60);
        const result = await memory.createMemory('test-avatar', {
          tier: 'immediate',
          type: 'fact',
          content: 'test',
          themes: [longTheme],
        });

        expect(result.themes?.[0].length).toBe(50);
      });
    });
  });

  // ==========================================================================
  // Issue 2: Strength Capping Tests
  // ==========================================================================
  describe('Strength Capping', () => {
    it('should default strength to 1.0 when not provided', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

      const result = await memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
      });

      expect(result.strength).toBe(1.0);
    });

    it('should cap strength at MAX_STRENGTH (2.0)', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

      const result = await memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        strength: 5.0,
      });

      expect(result.strength).toBe(2.0);
    });

    it('should floor strength at 0', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

      const result = await memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        strength: -1.0,
      });

      expect(result.strength).toBe(0);
    });

    it('should handle NaN strength by defaulting to 1.0', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

      const result = await memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        strength: NaN,
      });

      expect(result.strength).toBe(1.0);
    });

    it('should handle undefined strength by defaulting to 1.0', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({})); // PutCommand

      const result = await memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        strength: undefined,
      });

      expect(result.strength).toBe(1.0);
    });

    describe('reinforceMemory strength capping', () => {
      it('should cap strength after reinforcement', async () => {
        // First UpdateCommand (add boost)
        mockSend.mockReturnValueOnce(Promise.resolve({}));
        // Second UpdateCommand (cap at max) - simulates condition check pass
        mockSend.mockReturnValueOnce(Promise.resolve({}));

        await memory.reinforceMemory('test-avatar', 'memory-1', 'immediate#123#uuid', 0.5);

        expect(mockSend).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ==========================================================================
  // Issue 3: Parallel Query Execution (getMemoryCounts)
  // ==========================================================================
  describe('Parallel Query Execution', () => {
    it('should execute tier count queries in parallel', async () => {
      const callOrder: string[] = [];

      mockSend.mockImplementation(async (command) => {
        const tierValue = command.input?.ExpressionAttributeValues?.[':tier'];
        callOrder.push(`start-${tierValue}`);
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 10));
        callOrder.push(`end-${tierValue}`);
        return { Count: 5 };
      });

      await memory.getMemoryCounts('test-avatar');

      // All starts should happen before all ends (parallel execution)
      const startIndices = callOrder
        .map((item, idx) => item.startsWith('start') ? idx : -1)
        .filter(idx => idx >= 0);
      const endIndices = callOrder
        .map((item, idx) => item.startsWith('end') ? idx : -1)
        .filter(idx => idx >= 0);

      // In parallel execution, all starts should be in first 3 positions
      expect(startIndices.every(idx => idx < 3)).toBe(true);
      expect(endIndices.every(idx => idx >= 3)).toBe(true);
    });

    it('should return correct counts for each tier', async () => {
      mockSend.mockImplementation(async (command) => {
        const tierValue = command.input?.ExpressionAttributeValues?.[':tier'];
        const counts: Record<string, number> = {
          'immediate#': 3,
          'recent#': 15,
          'core#': 8,
        };
        return { Count: counts[tierValue] || 0 };
      });

      const result = await memory.getMemoryCounts('test-avatar');

      expect(result).toEqual({
        immediate: 3,
        recent: 15,
        core: 8,
      });
    });
  });

  // ==========================================================================
  // Issue 4: Batch Operations (applyDecay)
  // ==========================================================================
  describe('Batch Operations (applyDecay)', () => {
    it('should process updates in batches of 25 in parallel', async () => {
      const memories: AvatarMemory[] = Array.from({ length: 50 }, (_, i) => ({
        pk: `MEMORY#test-avatar`,
        sk: `immediate#${Date.now()}#${i}`,
        id: `memory-${i}`,
        avatarId: 'test-avatar',
        tier: 'immediate' as MemoryTier,
        type: 'fact' as const,
        content: `Memory ${i}`,
        strength: 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));

      let _queryCallCount = 0;
      let updateCallCount = 0;

      mockSend.mockImplementation(async (command) => {
        if (command.constructor.name === 'QueryCommand' || command.input?.KeyConditionExpression) {
          _queryCallCount++;
          return { Items: memories };
        }
        // UpdateCommand
        updateCallCount++;
        return {};
      });

      const result = await memory.applyDecay('test-avatar', 'immediate', 0.95);

      // Should have called update for all 50 memories
      expect(updateCallCount).toBe(50);
      expect(result.decayed).toBe(50);
    });

    it('should prune memories below threshold', async () => {
      const memories: AvatarMemory[] = [
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#123#1',
          id: 'strong-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'Strong',
          strength: 0.5,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#123#2',
          id: 'weak-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'Weak',
          strength: 0.05, // Below threshold after decay
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      let batchWriteCalled = false;

      mockSend.mockImplementation(async (command) => {
        if (command.input?.KeyConditionExpression) {
          return { Items: memories };
        }
        if (command.input?.RequestItems) {
          batchWriteCalled = true;
          return {};
        }
        return {};
      });

      const result = await memory.applyDecay('test-avatar', 'immediate', 0.95);

      expect(batchWriteCalled).toBe(true);
      expect(result.pruned).toBe(1);
      expect(result.decayed).toBe(1);
    });
  });

  // ==========================================================================
  // Issue 5: Transaction Atomicity (promoteImmediateToRecent)
  // ==========================================================================
  describe('Transaction Atomicity', () => {
    it('should use DynamoDB transactions for memory promotion', async () => {
      const oldMemories: AvatarMemory[] = Array.from({ length: 15 }, (_, i) => ({
        pk: 'MEMORY#test-avatar',
        sk: `immediate#${Date.now() - i * 1000}#memory-${i}`,
        id: `memory-${i}`,
        avatarId: 'test-avatar',
        tier: 'immediate' as MemoryTier,
        type: 'fact' as const,
        content: `Memory ${i}`,
        strength: 1.0,
        createdAt: Date.now() - i * 1000,
        updatedAt: Date.now() - i * 1000,
      }));

      // Document client for initial query
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: oldMemories }));

      const result = await memory.promoteImmediateToRecent('test-avatar', 10);

      // Should promote 5 memories (15 - 10 = 5)
      expect(transactionCalls.length).toBe(5);
      expect(result.promoted).toBe(5);

      // Verify each transaction had Put and Delete
      for (const cmd of transactionCalls) {
        const transactItems = (cmd as { input?: { TransactItems?: unknown[] } }).input?.TransactItems;
        expect(transactItems).toHaveLength(2);
      }
    });

    it('should continue promoting remaining memories if one transaction fails', async () => {
      const oldMemories: AvatarMemory[] = Array.from({ length: 12 }, (_, i) => ({
        pk: 'MEMORY#test-avatar',
        sk: `immediate#${Date.now() - i * 1000}#memory-${i}`,
        id: `memory-${i}`,
        avatarId: 'test-avatar',
        tier: 'immediate' as MemoryTier,
        type: 'fact' as const,
        content: `Memory ${i}`,
        strength: 1.0,
        createdAt: Date.now() - i * 1000,
        updatedAt: Date.now() - i * 1000,
      }));

      // Document client for initial query
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: oldMemories }));

      // Override spy to fail on first call
      let callCount = 0;
      transactionSendSpy.mockImplementation(async (command: unknown) => {
        callCount++;
        transactionCalls.push(command);
        if (callCount === 1) {
          throw new Error('Transaction failed');
        }
        return {};
      });

      const result = await memory.promoteImmediateToRecent('test-avatar', 10);

      // Should attempt 2 promotions (12 - 10 = 2), one failed
      expect(transactionCalls.length).toBe(2);
      expect(result.promoted).toBe(1); // Only one succeeded
    });

    it('should not promote if count is within limit', async () => {
      const memories: AvatarMemory[] = Array.from({ length: 5 }, (_, i) => ({
        pk: 'MEMORY#test-avatar',
        sk: `immediate#${Date.now()}#memory-${i}`,
        id: `memory-${i}`,
        avatarId: 'test-avatar',
        tier: 'immediate' as MemoryTier,
        type: 'fact' as const,
        content: `Memory ${i}`,
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));

      mockSend.mockReturnValueOnce(Promise.resolve({ Items: memories }));

      const result = await memory.promoteImmediateToRecent('test-avatar', 10);

      expect(result.promoted).toBe(0);
      expect(transactionCalls.length).toBe(0); // No transactions needed
    });
  });

  // ==========================================================================
  // Issue 6: Recency Scoring in Search
  // ==========================================================================
  describe('Recency Scoring', () => {
    it('should score newer memories higher than older ones', async () => {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      const memories: AvatarMemory[] = [
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#old#1',
          id: 'old-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'cheetah fact old',
          strength: 1.0,
          createdAt: now - 60 * dayMs, // 60 days old
          updatedAt: now - 60 * dayMs,
        },
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#new#2',
          id: 'new-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'cheetah fact new',
          strength: 1.0,
          createdAt: now - dayMs, // 1 day old
          updatedAt: now - dayMs,
        },
      ];

      mockSend.mockReturnValueOnce(Promise.resolve({ Items: memories }));

      const results = await memory.searchMemories('test-avatar', 'cheetah');

      // Newer memory should be first due to recency boost
      expect(results[0].id).toBe('new-memory');
      expect(results[1].id).toBe('old-memory');
    });

    it('should apply tier multipliers correctly', async () => {
      const now = Date.now();

      const memories: AvatarMemory[] = [
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#1',
          id: 'immediate-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'cheetah speed',
          strength: 1.0,
          createdAt: now,
          updatedAt: now,
        },
        {
          pk: 'MEMORY#test-avatar',
          sk: 'core#2',
          id: 'core-memory',
          avatarId: 'test-avatar',
          tier: 'core',
          type: 'fact',
          content: 'cheetah speed',
          strength: 1.0,
          createdAt: now,
          updatedAt: now,
        },
      ];

      mockSend.mockReturnValueOnce(Promise.resolve({ Items: memories }));

      const results = await memory.searchMemories('test-avatar', 'cheetah');

      // Core memory should be first due to 1.5x tier multiplier
      expect(results[0].id).toBe('core-memory');
    });

    it('should factor in strength for scoring', async () => {
      const now = Date.now();

      const memories: AvatarMemory[] = [
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#1',
          id: 'weak-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'cheetah',
          strength: 0.3,
          createdAt: now,
          updatedAt: now,
        },
        {
          pk: 'MEMORY#test-avatar',
          sk: 'immediate#2',
          id: 'strong-memory',
          avatarId: 'test-avatar',
          tier: 'immediate',
          type: 'fact',
          content: 'cheetah',
          strength: 1.8,
          createdAt: now,
          updatedAt: now,
        },
      ];

      mockSend.mockReturnValueOnce(Promise.resolve({ Items: memories }));

      const results = await memory.searchMemories('test-avatar', 'cheetah');

      // Strong memory should be first
      expect(results[0].id).toBe('strong-memory');
    });

    it('should return empty array for empty query', async () => {
      const results = await memory.searchMemories('test-avatar', '   ');

      expect(results).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should limit initial fetch to 200 memories', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [] }));

      await memory.searchMemories('test-avatar', 'query');

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Limit: 200,
          }),
        })
      );
    });
  });

  // ==========================================================================
  // Issue 7: Error Handling
  // ==========================================================================
  describe('Error Handling', () => {
    it('should throw on createMemory failure', async () => {
      mockSend.mockReturnValueOnce(Promise.reject(new Error('DynamoDB error')));

      await expect(memory.createMemory('test-avatar', {
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        skipEmbedding: true, // Skip embedding to ensure DynamoDB mock is hit directly
      })).rejects.toThrow('DynamoDB error');
    });

    it('should return empty array on getMemories failure', async () => {
      mockSend.mockReturnValueOnce(Promise.reject(new Error('Query failed')));

      const result = await memory.getMemories('test-avatar');

      expect(result).toEqual([]);
    });

    it('should not throw on reinforceMemory failure', async () => {
      mockSend.mockReturnValueOnce(Promise.reject(new Error('Update failed')));

      // Should not throw
      await expect(
        memory.reinforceMemory('test-avatar', 'memory-1', 'sk', 0.1)
      ).resolves.toBeUndefined();
    });

    it('should throw on deleteMemory failure', async () => {
      mockSend.mockReturnValueOnce(Promise.reject(new Error('Delete failed')));

      await expect(
        memory.deleteMemory('test-avatar', 'immediate#123#uuid')
      ).rejects.toThrow('Delete failed');
    });

    it('should handle partial batch delete failures gracefully', async () => {
      // First batch succeeds, second fails
      mockSend
        .mockReturnValueOnce(Promise.resolve({}))
        .mockReturnValueOnce(Promise.reject(new Error('Batch failed')));

      // Should not throw, just log
      await expect(
        memory.deleteMemories('test-avatar', [
          ...Array.from({ length: 25 }, (_, i) => `sk-${i}`),
          ...Array.from({ length: 25 }, (_, i) => `sk-${i + 25}`),
        ])
      ).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Additional Function Tests
  // ==========================================================================
  describe('getMemory', () => {
    it('should find memory by ID with tier hint', async () => {
      const mockMemory: AvatarMemory = {
        pk: 'MEMORY#test-avatar',
        sk: 'immediate#123#uuid',
        id: 'uuid',
        avatarId: 'test-avatar',
        tier: 'immediate',
        type: 'fact',
        content: 'test',
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [mockMemory] }));

      const result = await memory.getMemory('test-avatar', 'uuid', 'immediate');

      expect(result).toEqual(mockMemory);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should search all tiers when no tier hint provided', async () => {
      const mockMemory: AvatarMemory = {
        pk: 'MEMORY#test-avatar',
        sk: 'recent#123#uuid',
        id: 'uuid',
        avatarId: 'test-avatar',
        tier: 'recent',
        type: 'fact',
        content: 'test',
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // immediate search returns nothing
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [] }));
      // recent search returns the memory
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [mockMemory] }));

      const result = await memory.getMemory('test-avatar', 'uuid');

      expect(result).toEqual(mockMemory);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should return null when memory not found', async () => {
      mockSend.mockReturnValue(Promise.resolve({ Items: [] }));

      const result = await memory.getMemory('test-avatar', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getMemoryStats', () => {
    it('should return comprehensive statistics', async () => {
      const now = Date.now();
      const memories = {
        immediate: [
          { tier: 'immediate', strength: 1.0, createdAt: now - 1000, updatedAt: now },
          { tier: 'immediate', strength: 0.8, createdAt: now - 2000, updatedAt: now },
        ],
        recent: [
          { tier: 'recent', strength: 0.7, createdAt: now - 5000, updatedAt: now },
        ],
        core: [
          { tier: 'core', strength: 1.5, createdAt: now - 10000, updatedAt: now },
        ],
      };

      mockSend.mockImplementation(async (command) => {
        const tierValue = command.input?.ExpressionAttributeValues?.[':tier'];

        if (command.input?.Select === 'COUNT') {
          const counts: Record<string, number> = {
            'immediate#': 2,
            'recent#': 1,
            'core#': 1,
          };
          return { Count: counts[tierValue] || 0 };
        }

        // Memory queries for average strength
        const tierMemories: Record<string, unknown[]> = {
          'immediate#': memories.immediate,
          'recent#': memories.recent,
          'core#': memories.core,
        };
        return { Items: tierMemories[tierValue] || [] };
      });

      const stats = await memory.getMemoryStats('test-avatar');

      expect(stats.counts).toEqual({
        immediate: 2,
        recent: 1,
        core: 1,
      });
      expect(stats.totalMemories).toBe(4);
      expect(stats.averageStrength.immediate).toBeCloseTo(0.9);
      expect(stats.averageStrength.recent).toBeCloseTo(0.7);
      expect(stats.averageStrength.core).toBeCloseTo(1.5);
      expect(stats.oldestMemory?.tier).toBe('core');
      expect(stats.newestMemory?.tier).toBe('immediate');
    });
  });

  describe('remember', () => {
    it('should create new memory when no similar exists', async () => {
      // recallAbout query
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [] }));
      // createMemory PutCommand
      mockSend.mockReturnValueOnce(Promise.resolve({}));
      // promoteImmediateToRecent query (background)
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [] }));

      const result = await memory.remember('test-avatar', 'New fact', 'topic');

      expect(result.saved).toBe(true);
      expect(result.reinforced).toBeUndefined();
    });

    it('should reinforce existing similar memory', async () => {
      const existingMemory: AvatarMemory = {
        pk: 'MEMORY#test-avatar',
        sk: 'immediate#123#uuid',
        id: 'existing-uuid',
        avatarId: 'test-avatar',
        tier: 'immediate',
        type: 'fact',
        content: 'Similar existing fact',
        about: 'topic',
        strength: 0.8,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // recallAbout query returns existing
      mockSend.mockReturnValueOnce(Promise.resolve({ Items: [existingMemory] }));
      // reinforceMemory UpdateCommands
      mockSend.mockReturnValueOnce(Promise.resolve({}));
      mockSend.mockReturnValueOnce(Promise.resolve({}));

      const result = await memory.remember('test-avatar', 'Similar existing', 'topic');

      expect(result.saved).toBe(true);
      expect(result.reinforced).toBe(true);
      expect(result.memoryId).toBe('existing-uuid');
    });
  });

  describe('recallAbout pagination', () => {
    it('should use pagination when initial query does not return enough results', async () => {
      const memory1: AvatarMemory = {
        pk: 'MEMORY#test-avatar',
        sk: 'immediate#1#uuid1',
        id: 'uuid1',
        avatarId: 'test-avatar',
        tier: 'immediate',
        type: 'fact',
        content: 'Memory 1 about topic',
        about: 'topic',
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      const memory2: AvatarMemory = {
        pk: 'MEMORY#test-avatar',
        sk: 'immediate#2#uuid2',
        id: 'uuid2',
        avatarId: 'test-avatar',
        tier: 'immediate',
        type: 'fact',
        content: 'Memory 2 about topic',
        about: 'topic',
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // First page returns 1 result with LastEvaluatedKey
      mockSend.mockReturnValueOnce(Promise.resolve({
        Items: [memory1],
        LastEvaluatedKey: { pk: 'MEMORY#test-avatar', sk: 'immediate#1#uuid1' },
      }));

      // Second page returns 1 more result without LastEvaluatedKey
      mockSend.mockReturnValueOnce(Promise.resolve({
        Items: [memory2],
      }));

      const results = await memory.recallAbout('test-avatar', 'topic', 2);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('uuid1');
      expect(results[1].id).toBe('uuid2');
      // Verify pagination was used (2 calls)
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('getMemoryContext', () => {
    it('should format memory context correctly', async () => {
      const coreMemories = [
        { type: 'identity', content: 'I am becoming more curious' },
        { type: 'learning', content: 'Users prefer short responses' },
        { type: 'pattern', content: 'Most questions are about speed' },
        { type: 'relationship', content: 'Good rapport with user123', about: 'user123' },
      ];

      const recentMemories = [
        { content: 'Discussed hunting techniques', about: 'wildlife' },
      ];

      const identityMemories = [
        { type: 'identity', content: 'I am becoming more curious' },
      ];

      mockSend
        .mockReturnValueOnce(Promise.resolve({ Items: coreMemories }))
        .mockReturnValueOnce(Promise.resolve({ Items: recentMemories }))
        .mockReturnValueOnce(Promise.resolve({ Items: identityMemories }));

      const context = await memory.getMemoryContext('test-avatar');

      expect(context).toContain('## Who I Am');
      expect(context).toContain('I am becoming more curious');
      expect(context).toContain("## What I've Learned");
      expect(context).toContain('Users prefer short responses');
      expect(context).toContain('## People I Know');
      expect(context).toContain('Good rapport with user123');
      expect(context).toContain('## Recent Experiences');
      expect(context).toContain('Discussed hunting techniques');
    });

    it('should return empty string when no memories exist', async () => {
      mockSend
        .mockReturnValueOnce(Promise.resolve({ Items: [] }))
        .mockReturnValueOnce(Promise.resolve({ Items: [] }))
        .mockReturnValueOnce(Promise.resolve({ Items: [] }));

      const context = await memory.getMemoryContext('test-avatar');

      expect(context).toBe('');
    });
  });

  // ==========================================================================
  // Issue 35: batchWriteWithRetry — UnprocessedItems handling
  // ==========================================================================
  describe('batchWriteWithRetry', () => {
    it('should complete immediately when no UnprocessedItems are returned', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({ UnprocessedItems: {} }));

      await memory.batchWriteWithRetry({
        'test-table': [
          { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } },
        ],
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should complete immediately when UnprocessedItems is undefined', async () => {
      mockSend.mockReturnValueOnce(Promise.resolve({}));

      await memory.batchWriteWithRetry({
        'test-table': [
          { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } },
        ],
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should retry unprocessed items up to maxRetries', async () => {
      const unprocessedItem = { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } };

      // First call: returns unprocessed items
      mockSend.mockReturnValueOnce(Promise.resolve({
        UnprocessedItems: { 'test-table': [unprocessedItem] },
      }));
      // Second call (retry 1): returns unprocessed items again
      mockSend.mockReturnValueOnce(Promise.resolve({
        UnprocessedItems: { 'test-table': [unprocessedItem] },
      }));
      // Third call (retry 2): succeeds
      mockSend.mockReturnValueOnce(Promise.resolve({ UnprocessedItems: {} }));

      await memory.batchWriteWithRetry(
        { 'test-table': [unprocessedItem] },
        2, // maxRetries = 2
        10, // baseDelayMs = 10 (fast for tests)
      );

      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('should throw after exhausting maxRetries with unprocessed items', async () => {
      const unprocessedItem = { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } };

      // All calls return unprocessed items
      mockSend.mockReturnValue(Promise.resolve({
        UnprocessedItems: { 'test-table': [unprocessedItem] },
      }));

      await expect(
        memory.batchWriteWithRetry(
          { 'test-table': [unprocessedItem] },
          2, // maxRetries = 2
          10, // baseDelayMs = 10 (fast for tests)
        )
      ).rejects.toThrow('1 items still unprocessed after 2 retries');

      // initial attempt + 2 retries = 3 total
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('should pass only unprocessed items to subsequent retries', async () => {
      const item1 = { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } };
      const item2 = { DeleteRequest: { Key: { pk: 'PK2', sk: 'SK2' } } };

      // First call: item2 is unprocessed
      mockSend.mockReturnValueOnce(Promise.resolve({
        UnprocessedItems: { 'test-table': [item2] },
      }));
      // Second call: all processed
      mockSend.mockReturnValueOnce(Promise.resolve({ UnprocessedItems: {} }));

      await memory.batchWriteWithRetry(
        { 'test-table': [item1, item2] },
        3,
        10,
      );

      expect(mockSend).toHaveBeenCalledTimes(2);

      // The second call should only contain item2
      const secondCallArg = mockSend.mock.calls[1][0];
      const retryItems = secondCallArg.input?.RequestItems?.['test-table'];
      expect(retryItems).toHaveLength(1);
      expect(retryItems[0]).toEqual(item2);
    });

    it('should propagate errors from the BatchWriteCommand', async () => {
      mockSend.mockReturnValueOnce(Promise.reject(new Error('Throughput exceeded')));

      await expect(
        memory.batchWriteWithRetry({
          'test-table': [
            { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } },
          ],
        })
      ).rejects.toThrow('Throughput exceeded');
    });

    it('should apply exponential backoff between retries', async () => {
      const unprocessedItem = { DeleteRequest: { Key: { pk: 'PK1', sk: 'SK1' } } };
      const callTimestamps: number[] = [];

      mockSend.mockImplementation(async () => {
        callTimestamps.push(Date.now());
        if (callTimestamps.length < 3) {
          return { UnprocessedItems: { 'test-table': [unprocessedItem] } };
        }
        return { UnprocessedItems: {} };
      });

      await memory.batchWriteWithRetry(
        { 'test-table': [unprocessedItem] },
        3,
        50, // 50ms base delay
      );

      expect(callTimestamps.length).toBe(3);

      // First retry delay should be ~50ms, second ~100ms
      // Allow generous tolerance for CI/test environments
      const delay1 = callTimestamps[1] - callTimestamps[0];
      const delay2 = callTimestamps[2] - callTimestamps[1];

      expect(delay1).toBeGreaterThanOrEqual(40); // ~50ms
      expect(delay2).toBeGreaterThanOrEqual(80); // ~100ms
      // Second delay should be roughly double the first
      expect(delay2).toBeGreaterThan(delay1);
    });
  });
});
