/**
 * LocalBlobStore — filesystem-backed blob storage.
 *
 * Replaces S3 for local/containerized deployments.
 * Files are stored under a configurable root directory with the same
 * key-based path structure used by S3.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, createReadStream, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';

export interface LocalBlobStoreOptions {
  /** Root directory for blob storage. Defaults to './data/blobs'. */
  rootDir?: string;
  /** Base URL for constructing public URLs. Defaults to 'http://localhost:3000/blobs'. */
  baseUrl?: string;
}

export class LocalBlobStore {
  private rootDir: string;
  private baseUrl: string;

  constructor(options: LocalBlobStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? './data/blobs');
    this.baseUrl = options.baseUrl ?? 'http://localhost:3000/blobs';
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** Store a blob and return its public URL. */
  put(key: string, buffer: Buffer, _contentType: string): string {
    const filePath = resolve(this.rootDir, key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buffer);
    return `${this.baseUrl}/${key}`;
  }

  /** Retrieve a blob as a Buffer. Returns null if not found. */
  get(key: string): Buffer | null {
    const filePath = resolve(this.rootDir, key);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath);
  }

  /** Delete a blob. */
  delete(key: string): void {
    const filePath = resolve(this.rootDir, key);
    if (existsSync(filePath)) unlinkSync(filePath);
  }

  /** Check if a blob exists. */
  exists(key: string): boolean {
    return existsSync(resolve(this.rootDir, key));
  }

  /** Create a read stream for a blob. */
  createReadStream(key: string): ReturnType<typeof createReadStream> | null {
    const filePath = resolve(this.rootDir, key);
    if (!existsSync(filePath)) return null;
    return createReadStream(filePath);
  }

  /** Get the public URL for a blob. */
  getUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }

  /** List keys with optional prefix. */
  list(prefix?: string): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else {
          const relative = full.slice(this.rootDir.length + 1);
          if (!prefix || relative.startsWith(prefix)) results.push(relative);
        }
      }
    };
    walk(this.rootDir);
    return results;
  }
}
