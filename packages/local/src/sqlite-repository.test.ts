/**
 * SqliteRepository tests — comprehensive coverage of all KeyValueStore operations.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SqliteRepository } from './sqlite-repository.js';

describe('SqliteRepository', () => {
  let repo: SqliteRepository;

  beforeEach(() => {
    repo = new SqliteRepository({ dbPath: ':memory:', tableName: 'test_items' });
  });

  // -------------------------------------------------------------------
  // Basic CRUD
  // -------------------------------------------------------------------

  describe('get / put / delete', () => {
    it('returns null for a missing key', async () => {
      expect(await repo.get({ pk: 'USER#1', sk: 'META' })).toBeNull();
    });

    it('stores and retrieves an item', async () => {
      await repo.put({ pk: 'USER#1', sk: 'META', name: 'Alice', age: 30 });
      const item = await repo.get<Record<string, unknown>>({ pk: 'USER#1', sk: 'META' });
      expect(item).not.toBeNull();
      expect(item!.name).toBe('Alice');
      expect(item!.age).toBe(30);
      expect(item!.pk).toBe('USER#1');
      expect(item!.sk).toBe('META');
    });

    it('upserts on repeated put', async () => {
      await repo.put({ pk: 'USER#1', sk: 'META', name: 'Alice' });
      await repo.put({ pk: 'USER#1', sk: 'META', name: 'Bob' });
      const item = await repo.get<Record<string, unknown>>({ pk: 'USER#1', sk: 'META' });
      expect(item!.name).toBe('Bob');
    });

    it('deletes an item', async () => {
      await repo.put({ pk: 'USER#1', sk: 'META', name: 'Alice' });
      await repo.delete({ pk: 'USER#1', sk: 'META' });
      expect(await repo.get({ pk: 'USER#1', sk: 'META' })).toBeNull();
    });

    it('delete is a no-op on missing key', async () => {
      await repo.delete({ pk: 'NOPE', sk: 'NOPE' });
      // Should not throw
    });
  });

  // -------------------------------------------------------------------
  // Conditional put
  // -------------------------------------------------------------------

  describe('conditional put', () => {
    it('onlyIfNotExists succeeds when item is absent', async () => {
      const ok = await repo.put(
        { pk: 'U#1', sk: 'META', val: 1 },
        { onlyIfNotExists: true },
      );
      expect(ok).toBe(true);
      expect(await repo.get({ pk: 'U#1', sk: 'META' })).not.toBeNull();
    });

    it('onlyIfNotExists returns false when item exists', async () => {
      await repo.put({ pk: 'U#1', sk: 'META', val: 1 });
      const ok = await repo.put(
        { pk: 'U#1', sk: 'META', val: 2 },
        { onlyIfNotExists: true },
      );
      expect(ok).toBe(false);
      // Original value preserved
      const item = await repo.get<Record<string, unknown>>({ pk: 'U#1', sk: 'META' });
      expect(item!.val).toBe(1);
    });

    it('supports attribute_not_exists(pk) condition', async () => {
      const ok = await repo.put(
        { pk: 'U#2', sk: 'META', val: 1 },
        { conditionExpression: 'attribute_not_exists(pk)' },
      );
      expect(ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------

  describe('query', () => {
    beforeEach(async () => {
      await repo.put({ pk: 'AVATAR#a1', sk: 'CHANNEL#telegram#1', platform: 'telegram' });
      await repo.put({ pk: 'AVATAR#a1', sk: 'CHANNEL#discord#1', platform: 'discord' });
      await repo.put({ pk: 'AVATAR#a1', sk: 'CHANNEL#telegram#2', platform: 'telegram' });
      await repo.put({ pk: 'AVATAR#a2', sk: 'CHANNEL#telegram#1', platform: 'telegram' });
    });

    it('queries all items for a pk', async () => {
      const items = await repo.query('AVATAR#a1');
      expect(items).toHaveLength(3);
    });

    it('filters by sk prefix', async () => {
      const items = await repo.query('AVATAR#a1', {
        skCondition: { type: 'begins_with', value: 'CHANNEL#telegram' },
      });
      expect(items).toHaveLength(2);
    });

    it('filters by exact sk', async () => {
      const items = await repo.query('AVATAR#a1', {
        skCondition: { type: 'eq', value: 'CHANNEL#discord#1' },
      });
      expect(items).toHaveLength(1);
      expect(items[0].platform).toBe('discord');
    });

    it('respects limit', async () => {
      const items = await repo.query('AVATAR#a1', { limit: 2 });
      expect(items).toHaveLength(2);
    });

    it('returns empty for unknown pk', async () => {
      expect(await repo.query('NOPE')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Paginated query
  // -------------------------------------------------------------------

  describe('queryPage', () => {
    beforeEach(async () => {
      for (let i = 0; i < 10; i++) {
        await repo.put({ pk: 'PK#1', sk: `ITEM#${String(i).padStart(3, '0')}`, idx: i });
      }
    });

    it('returns a page with lastEvaluatedKey', async () => {
      const page = await repo.queryPage('PK#1', { limit: 4 });
      expect(page.items).toHaveLength(4);
      expect(page.lastEvaluatedKey).toBeDefined();
      expect(page.lastEvaluatedKey!.pk).toBe('PK#1');
    });

    it('paginates through all items', async () => {
      const page1 = await repo.queryPage('PK#1', { limit: 4 });
      const page2 = await repo.queryPage('PK#1', { limit: 4 }, page1.lastEvaluatedKey);
      expect(page2.items.length).toBeGreaterThan(0);
      // No overlap
      const ids1 = new Set(page1.items.map((i: any) => i.idx));
      for (const item of page2.items as any[]) {
        expect(ids1.has(item.idx)).toBe(false);
      }
    });

    it('queryAll collects all pages', async () => {
      const items = await repo.queryAll('PK#1');
      expect(items).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------

  describe('update', () => {
    beforeEach(async () => {
      await repo.put({ pk: 'U#1', sk: 'META', name: 'Alice', count: 0 });
    });

    it('sets a field', async () => {
      await repo.update({ pk: 'U#1', sk: 'META' }, {
        updateExpression: 'SET #name = :name',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'Bob' },
      });
      const item = await repo.get<Record<string, unknown>>({ pk: 'U#1', sk: 'META' });
      expect(item!.name).toBe('Bob');
    });

    it('increments with if_not_exists', async () => {
      await repo.update({ pk: 'U#1', sk: 'META' }, {
        updateExpression: 'SET #count = if_not_exists(#count, :zero) + :one',
        expressionAttributeNames: { '#count': 'count' },
        expressionAttributeValues: { ':zero': 0, ':one': 5 },
      });
      const item = await repo.get<Record<string, unknown>>({ pk: 'U#1', sk: 'META' });
      expect(item!.count).toBe(5);
    });

    it('returns updated values with ALL_NEW', async () => {
      const result = await repo.update<{ name: string }>({ pk: 'U#1', sk: 'META' }, {
        updateExpression: 'SET #name = :name',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'Charlie' },
        returnValues: 'ALL_NEW',
      });
      expect(result!.name).toBe('Charlie');
    });

    it('returns null with NONE returnValues', async () => {
      const result = await repo.update({ pk: 'U#1', sk: 'META' }, {
        updateExpression: 'SET #name = :name',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'Dave' },
        returnValues: 'NONE',
      });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // Batch write
  // -------------------------------------------------------------------

  describe('batchWrite', () => {
    it('writes multiple items', async () => {
      await repo.batchWrite([
        { type: 'put', item: { pk: 'B#1', sk: 'A', val: 1 } },
        { type: 'put', item: { pk: 'B#1', sk: 'B', val: 2 } },
      ]);
      expect(await repo.query('B#1')).toHaveLength(2);
    });

    it('handles mixed put and delete', async () => {
      await repo.put({ pk: 'B#1', sk: 'A', val: 1 });
      await repo.put({ pk: 'B#1', sk: 'B', val: 2 });
      await repo.batchWrite([
        { type: 'put', item: { pk: 'B#1', sk: 'C', val: 3 } },
        { type: 'delete', key: { pk: 'B#1', sk: 'A' } },
      ]);
      const items = await repo.query('B#1');
      expect(items).toHaveLength(2);
      const sks = items.map((i: any) => i.sk).sort();
      expect(sks).toEqual(['B', 'C']);
    });

    it('no-ops on empty array', async () => {
      await repo.batchWrite([]);
      // Should not throw
    });

    it('rejects > 25 operations', async () => {
      const ops = Array.from({ length: 26 }, (_, i) => ({
        type: 'put' as const,
        item: { pk: 'B#1', sk: `SK#${i}`, val: i },
      }));
      await expect(repo.batchWrite(ops)).rejects.toThrow('max 25');
    });
  });

  // -------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------

  describe('scan', () => {
    beforeEach(async () => {
      await repo.put({ pk: 'S#1', sk: 'A', type: 'image' });
      await repo.put({ pk: 'S#1', sk: 'B', type: 'video' });
      await repo.put({ pk: 'S#1', sk: 'C', type: 'image' });
    });

    it('filters with equality', async () => {
      const items = await repo.scan({
        filterExpression: '#type = :type',
        expressionAttributeValues: { ':type': 'image' },
        expressionAttributeNames: { '#type': 'type' },
      });
      expect(items).toHaveLength(2);
    });

    it('respects limit', async () => {
      const items = await repo.scan({
        filterExpression: '#type = :type',
        expressionAttributeValues: { ':type': 'image' },
        expressionAttributeNames: { '#type': 'type' },
        limit: 1,
      });
      expect(items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // TTL
  // -------------------------------------------------------------------

  describe('TTL', () => {
    it('returns null for expired items on get', async () => {
      const pastTtl = Math.floor(Date.now() / 1000) - 10;
      await repo.put({ pk: 'T#1', sk: 'EXPIRED', ttl: pastTtl });
      expect(await repo.get({ pk: 'T#1', sk: 'EXPIRED' })).toBeNull();
    });

    it('returns active items within TTL', async () => {
      const futureTtl = Math.floor(Date.now() / 1000) + 3600;
      await repo.put({ pk: 'T#1', sk: 'ACTIVE', ttl: futureTtl });
      expect(await repo.get({ pk: 'T#1', sk: 'ACTIVE' })).not.toBeNull();
    });

    it('excludes expired items from queries', async () => {
      const pastTtl = Math.floor(Date.now() / 1000) - 10;
      const futureTtl = Math.floor(Date.now() / 1000) + 3600;
      await repo.put({ pk: 'T#1', sk: 'EXPIRED', ttl: pastTtl });
      await repo.put({ pk: 'T#1', sk: 'ACTIVE', ttl: futureTtl });
      const items = await repo.query('T#1');
      expect(items).toHaveLength(1);
      expect(items[0].sk).toBe('ACTIVE');
    });

    it('cleanupExpired removes expired rows', async () => {
      const pastTtl = Math.floor(Date.now() / 1000) - 10;
      await repo.put({ pk: 'T#1', sk: 'OLD', ttl: pastTtl });
      expect(repo.cleanupExpired()).toBe(1);
      expect(await repo.get({ pk: 'T#1', sk: 'OLD' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------

  describe('projection', () => {
    it('returns only projected fields', async () => {
      await repo.put({ pk: 'P#1', sk: 'META', name: 'Alice', age: 30, email: 'a@b.com' });
      const item = await repo.get<Record<string, unknown>>({ pk: 'P#1', sk: 'META' }, {
        projectionExpression: '#name',
        expressionAttributeNames: { '#name': 'name' },
      });
      expect(item!.name).toBe('Alice');
      expect((item as any).age).toBeUndefined();
      expect((item as any).email).toBeUndefined();
      // pk and sk always present
      expect(item!.pk).toBe('P#1');
      expect(item!.sk).toBe('META');
    });
  });
});
