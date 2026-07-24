/**
 * LocalBlobStore tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LocalBlobStore } from './blob-store.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

const TEST_DIR = resolve('/tmp/swarm-test-blobs');

describe('LocalBlobStore', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('stores and retrieves a blob', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    const key = 'avatars/test/image.png';
    const buffer = Buffer.from('fake-png-data');

    const url = store.put(key, buffer, 'image/png');
    expect(url).toContain('/blobs/avatars/test/image.png');

    const retrieved = store.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.toString()).toBe('fake-png-data');
  });

  it('returns null for missing blob', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    expect(store.get('nonexistent/file.txt')).toBeNull();
  });

  it('checks existence', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    store.put('test.txt', Buffer.from('hello'), 'text/plain');
    expect(store.exists('test.txt')).toBe(true);
    expect(store.exists('nope.txt')).toBe(false);
  });

  it('deletes a blob', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    store.put('temp.txt', Buffer.from('temp'), 'text/plain');
    expect(store.exists('temp.txt')).toBe(true);
    store.delete('temp.txt');
    expect(store.exists('temp.txt')).toBe(false);
  });

  it('delete is no-op on missing blob', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    store.delete('nonexistent');
    // Should not throw
  });

  it('generates correct URL', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR, baseUrl: 'https://cdn.example.com' });
    expect(store.getUrl('path/to/file.jpg')).toBe('https://cdn.example.com/path/to/file.jpg');
  });

  it('creates nested directories automatically', () => {
    const store = new LocalBlobStore({ rootDir: TEST_DIR });
    store.put('deep/nested/path/file.bin', Buffer.from('data'), 'application/octet-stream');
    expect(store.exists('deep/nested/path/file.bin')).toBe(true);
  });


  describe("createReadStream", () => {
    it("returns a readable stream for existing blob", () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      store.put("stream-test.txt", Buffer.from("streaming data"), "text/plain");
      const stream = store.createReadStream("stream-test.txt");
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      stream!.on("data", (chunk: string | Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream!.on("end", () => {
        expect(Buffer.concat(chunks).toString()).toBe("streaming data");
      });
    });

    it("returns null for missing blob", () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      expect(store.createReadStream("nonexistent")).toBeNull();
    });
  });

  describe('list', () => {
    it('lists all keys with no prefix', () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      store.put('a.txt', Buffer.from('a'), 'text/plain');
      store.put('sub/b.txt', Buffer.from('b'), 'text/plain');
      const keys = store.list().sort();
      expect(keys).toEqual(['a.txt', 'sub/b.txt']);
    });

    it('filters by prefix', () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      store.put('a.txt', Buffer.from('a'), 'text/plain');
      store.put('sub/b.txt', Buffer.from('b'), 'text/plain');
      expect(store.list('sub/')).toEqual(['sub/b.txt']);
    });

    it('returns empty array when no keys match', () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      expect(store.list()).toEqual([]);
    });

    it('returns empty array for prefix with no matches', () => {
      const store = new LocalBlobStore({ rootDir: TEST_DIR });
      store.put('a.txt', Buffer.from('a'), 'text/plain');
      expect(store.list('nonexistent/')).toEqual([]);
    });
  });
});
