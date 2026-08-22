import { LocalAdapter } from './adapter-base.js';
import type { LocalBlobStore } from './blob-store.js';

export class LocalS3Adapter extends LocalAdapter {
  constructor(private blobs: LocalBlobStore) { super(); }

  protected async dispatch(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name.startsWith('PutObjectCommand')) {
      const key = input.Key as string;
      const body = input.Body as Buffer | string;
      const contentType = (input.ContentType as string) || 'application/octet-stream';
      this.blobs.put(key, Buffer.isBuffer(body) ? body : Buffer.from(body), contentType);
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (name.startsWith('GetObjectCommand')) {
      const key = input.Key as string;
      const blob = this.blobs.get(key);
      if (!blob) {
        const err = new Error('NoSuchKey') as Error & { $metadata: Record<string, unknown>; name: string };
        err.$metadata = { httpStatusCode: 404 };
        err.name = 'NoSuchKey';
        throw err;
      }
      return {
        Body: blob,
        ContentType: 'application/octet-stream',
        ContentLength: blob.length,
        $metadata: { httpStatusCode: 200 },
      };
    }
    if (name.startsWith('DeleteObjectCommand')) {
      this.blobs.delete(input.Key as string);
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (name.startsWith('ListObjectsV2Command')) {
      const prefix = (input.Prefix as string) ?? '';
      return {
        Contents: this.blobs.list(prefix).map((k) => ({ Key: k })),
        $metadata: { httpStatusCode: 200 },
      };
    }
    throw new Error(`LocalS3Adapter: unsupported command "${name}"`);
  }
}
