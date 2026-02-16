import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCanonicalMemoryClient, _setDynamoClient } from './canonical-memory.js';

describe('Canonical Memory Client', () => {
  let mockSend: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSend = mock(() => Promise.resolve({}));
    const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
    _setDynamoClient(mockDocClient);
  });

  afterEach(() => {
    _setDynamoClient(null);
  });

  describe('createCanonicalMemoryClient', () => {
    it('throws when no table name and no env var', () => {
      const origEnv = process.env.ADMIN_TABLE;
      delete process.env.ADMIN_TABLE;
      try {
        expect(() => createCanonicalMemoryClient()).toThrow('ADMIN_TABLE is required');
      } finally {
        if (origEnv) process.env.ADMIN_TABLE = origEnv;
      }
    });

    it('accepts explicit table name', () => {
      const client = createCanonicalMemoryClient('my-table');
      expect(client).toBeDefined();
      expect(typeof client.remember).toBe('function');
      expect(typeof client.recall).toBe('function');
    });

    it('falls back to ADMIN_TABLE env var', () => {
      const origEnv = process.env.ADMIN_TABLE;
      process.env.ADMIN_TABLE = 'env-table';
      try {
        const client = createCanonicalMemoryClient();
        expect(client).toBeDefined();
      } finally {
        if (origEnv) {
          process.env.ADMIN_TABLE = origEnv;
        } else {
          delete process.env.ADMIN_TABLE;
        }
      }
    });
  });

  describe('remember', () => {
    it('writes an immediate-tier memory to DynamoDB', async () => {
      const client = createCanonicalMemoryClient('test-table');
      const result = await client.remember('test-avatar', 'Dogs are loyal', 'dogs');

      expect(result.saved).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.TableName).toBe('test-table');
      expect(putInput.Item.pk).toBe('MEMORY#test-avatar');
      expect(putInput.Item.sk).toMatch(/^immediate#\d+#[0-9a-f-]+$/);
      expect(putInput.Item.content).toBe('Dogs are loyal');
      expect(putInput.Item.about).toBe('dogs');
      expect(putInput.Item.tier).toBe('immediate');
      expect(putInput.Item.type).toBe('fact');
      expect(putInput.Item.strength).toBe(1.0);
      expect(putInput.Item.ttl).toBeGreaterThan(0);
      expect(putInput.Item.createdAt).toBeGreaterThan(0);
      expect(putInput.Item.updatedAt).toBe(putInput.Item.createdAt);
    });

    it('uses event type when no about is provided', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await client.remember('test-avatar', 'Something happened');

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.type).toBe('event');
      expect(putInput.Item.about).toBeUndefined();
    });

    it('stores userId when provided', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await client.remember('test-avatar', 'User likes coffee', 'preferences', 'user-123');

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.userId).toBe('user-123');
    });

    it('validates avatarId - empty', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await expect(client.remember('', 'fact')).rejects.toThrow('avatarId is required');
    });

    it('validates avatarId - invalid characters', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await expect(client.remember('bad@id!', 'fact')).rejects.toThrow('invalid characters');
    });

    it('validates content - empty', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await expect(client.remember('avatar', '   ')).rejects.toThrow('content is required');
    });

    it('truncates long content to 2000 chars', async () => {
      const client = createCanonicalMemoryClient('test-table');
      const longContent = 'x'.repeat(2500);
      await client.remember('avatar', longContent);

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.content.length).toBe(2000);
    });

    it('truncates about to 100 chars', async () => {
      const client = createCanonicalMemoryClient('test-table');
      const longAbout = 'y'.repeat(150);
      await client.remember('avatar', 'some fact', longAbout);

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.about.length).toBe(100);
    });

    it('generates unique IDs for each memory', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await client.remember('avatar', 'fact one');
      await client.remember('avatar', 'fact two');

      const id1 = mockSend.mock.calls[0][0].input.Item.id;
      const id2 = mockSend.mock.calls[1][0].input.Item.id;
      expect(id1).not.toBe(id2);
    });
  });

  describe('recall', () => {
    it('returns matching memories by content keyword', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            { content: 'Dogs are loyal', about: 'dogs', createdAt: 1000, strength: 1.0 },
            { content: 'Cats are independent', about: 'cats', createdAt: 900, strength: 0.8 },
          ],
        })
      );

      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('test-avatar', 'dogs');

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].fact).toBe('Dogs are loyal');
      expect(result.facts[0].about).toBe('dogs');
      expect(result.facts[0].timestamp).toBe(1000);
      expect(result.facts[0].strength).toBe(1.0);
    });

    it('matches on about field', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            { content: 'They are fluffy', about: 'dogs', createdAt: 1000, strength: 1.0 },
            { content: 'They purr', about: 'cats', createdAt: 900, strength: 0.8 },
          ],
        })
      );

      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('test-avatar', 'dogs');

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].fact).toBe('They are fluffy');
    });

    it('returns empty for blank query', async () => {
      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('test-avatar', '   ');

      expect(result.facts).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('filters by userId when provided', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            { content: 'Fact from user1', userId: 'user1', createdAt: 1000, strength: 1.0 },
            { content: 'Fact from user2', userId: 'user2', createdAt: 900, strength: 0.8 },
            { content: 'General fact', createdAt: 800, strength: 0.7 },
          ],
        })
      );

      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('test-avatar', 'fact', 'user1');

      // Should include user1's fact and the general fact (no userId), but not user2's
      expect(result.facts).toHaveLength(2);
      expect(result.facts.map((f) => f.fact)).toContain('Fact from user1');
      expect(result.facts.map((f) => f.fact)).toContain('General fact');
      expect(result.facts.map((f) => f.fact)).not.toContain('Fact from user2');
    });

    it('queries with correct DynamoDB key', async () => {
      mockSend.mockImplementation(() => Promise.resolve({ Items: [] }));

      const client = createCanonicalMemoryClient('test-table');
      await client.recall('my-avatar', 'test query');

      const queryInput = mockSend.mock.calls[0][0].input;
      expect(queryInput.TableName).toBe('test-table');
      expect(queryInput.KeyConditionExpression).toBe('pk = :pk');
      expect(queryInput.ExpressionAttributeValues[':pk']).toBe('MEMORY#my-avatar');
      expect(queryInput.ScanIndexForward).toBe(false);
    });

    it('limits results to 20', async () => {
      const manyItems = Array.from({ length: 30 }, (_, i) => ({
        content: `matching fact ${i}`,
        about: 'topic',
        createdAt: 1000 - i,
        strength: 1.0,
      }));
      mockSend.mockImplementation(() => Promise.resolve({ Items: manyItems }));

      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('avatar', 'matching');

      expect(result.facts.length).toBeLessThanOrEqual(20);
    });

    it('is case-insensitive', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            { content: 'Dogs ARE Loyal', about: 'Dogs', createdAt: 1000, strength: 1.0 },
          ],
        })
      );

      const client = createCanonicalMemoryClient('test-table');
      const result = await client.recall('avatar', 'dogs');

      expect(result.facts).toHaveLength(1);
    });
  });

  describe('schema compatibility', () => {
    it('produces items matching admin-api AvatarMemory schema', async () => {
      const client = createCanonicalMemoryClient('test-table');
      await client.remember('test-avatar', 'Test fact', 'topic', 'user-123');

      const item = mockSend.mock.calls[0][0].input.Item;

      // All required fields for admin-api compatibility
      expect(item).toHaveProperty('pk');
      expect(item).toHaveProperty('sk');
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('avatarId');
      expect(item).toHaveProperty('tier');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('content');
      expect(item).toHaveProperty('strength');
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('updatedAt');
      expect(item).toHaveProperty('ttl');

      // UUID format for id
      expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

      // Correct key format
      expect(item.pk).toMatch(/^MEMORY#/);
      expect(item.sk).toMatch(/^immediate#\d+#[0-9a-f-]+$/);

      // Value ranges
      expect(item.strength).toBeGreaterThanOrEqual(0);
      expect(item.strength).toBeLessThanOrEqual(2.0);
      expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });
});
