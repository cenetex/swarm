/**
 * LocalS3Adapter tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalBlobStore } from './blob-store.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

const TEST_DIR = resolve('/tmp/swarm-test-s3');

function makeCmd(name: string, input: Record<string, unknown>) {
  return {
    constructor: { name },
    input,
  };
}

describe('LocalS3Adapter', () => {
  let store: LocalBlobStore;
  let s3: LocalS3Adapter;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new LocalBlobStore({ rootDir: TEST_DIR });
    s3 = new LocalS3Adapter(store);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('PutObjectCommand', () => {
    it('stores a buffer and returns success', async () => {
      const buf = Buffer.from('hello world');
      const result = await s3.send(makeCmd('PutObjectCommand', { Key: 'test.txt', Body: buf }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(store.exists('test.txt')).toBe(true);
      expect(store.get('test.txt')!.toString()).toBe('hello world');
    });

    it('stores a string body', async () => {
      const result = await s3.send(makeCmd('PutObjectCommand', { Key: 'string.txt', Body: 'plain text' }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(store.get('string.txt')!.toString()).toBe('plain text');
    });
  });

  describe('GetObjectCommand', () => {
    it('retrieves a stored object', async () => {
      store.put('data.bin', Buffer.from('binary'), 'application/octet-stream');
      const result = await s3.send(makeCmd('GetObjectCommand', { Key: 'data.bin' }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect((result.Body as Buffer).toString()).toBe('binary');
    });

    it('throws NoSuchKey for missing object', async () => {
      try {
        await s3.send(makeCmd('GetObjectCommand', { Key: 'nope' }));
        expect.unreachable();
      } catch (e: any) {
        expect(e.name).toBe('NoSuchKey');
        expect(e.$metadata.httpStatusCode).toBe(404);
      }
    });
  });

  describe('DeleteObjectCommand', () => {
    it('deletes an existing object', async () => {
      store.put('tmp.txt', Buffer.from('bye'), 'text/plain');
      const result = await s3.send(makeCmd('DeleteObjectCommand', { Key: 'tmp.txt' }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(store.exists('tmp.txt')).toBe(false);
    });

    it('is no-op for missing object', async () => {
      const result = await s3.send(makeCmd('DeleteObjectCommand', { Key: 'nonexistent' }));
      expect(result.$metadata.httpStatusCode).toBe(200);
    });
  });

  describe('ListObjectsV2Command', () => {
    it('lists all keys', async () => {
      store.put('a.txt', Buffer.from('a'), 'text/plain');
      store.put('sub/b.txt', Buffer.from('b'), 'text/plain');
      const result = await s3.send(makeCmd('ListObjectsV2Command', {}));
      expect(result.$metadata.httpStatusCode).toBe(200);
      const keys = (result.Contents as Array<{ Key: string }>).map(c => c.Key).sort();
      expect(keys).toEqual(['a.txt', 'sub/b.txt']);
    });

    it('filters by prefix', async () => {
      store.put('a.txt', Buffer.from('a'), 'text/plain');
      store.put('sub/b.txt', Buffer.from('b'), 'text/plain');
      const result = await s3.send(makeCmd('ListObjectsV2Command', { Prefix: 'sub/' }));
      const keys = (result.Contents as Array<{ Key: string }>).map(c => c.Key);
      expect(keys).toEqual(['sub/b.txt']);
    });

    it('returns empty list for no matching keys', async () => {
      const result = await s3.send(makeCmd('ListObjectsV2Command', {}));
      expect(result.Contents).toEqual([]);
    });
  });

  describe('unsupported command', () => {
    it('throws for unknown commands', async () => {
      try {
        await s3.send(makeCmd('CopyObjectCommand', {}));
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported command/);
      }
    });
  });

  describe('name matching edge cases', () => {
    it('matches prefixed command names like Bun-compiled variants', async () => {
      store.put('edge.txt', Buffer.from('edge'), 'text/plain');
      const result = await s3.send(makeCmd('GetObjectCommand_Bun', { Key: 'edge.txt' }));
      expect(result.$metadata.httpStatusCode).toBe(200);
    });

    it('empty constructor name throws unsupported', async () => {
      try {
        await s3.send({ input: {} } as any);
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported/);
      }
    });
  });
});

