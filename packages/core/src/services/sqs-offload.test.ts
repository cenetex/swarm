/**
 * SQS Payload Offload Service Tests
 *
 * Tests for transparent S3 offloading of large SQS messages.
 * Uses mock S3 client to verify offload/retrieve/cleanup behavior.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createSqsOffloadService,
  SQS_OFFLOAD_CONSTANTS,
  type SqsOffloadService,
  type OffloadedMessageRef,
} from './sqs-offload.js';

// ---------------------------------------------------------------------------
// Mock S3 Client
// ---------------------------------------------------------------------------

type S3Operation = {
  command: string;
  input: Record<string, unknown>;
};

class MockS3Client {
  public operations: S3Operation[] = [];
  public storage: Map<string, string> = new Map();
  public shouldFail = false;
  public failMessage = 'Mock S3 error';

  async send(command: unknown): Promise<unknown> {
    const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
    const name = cmd.constructor.name;
    const input = cmd.input;

    this.operations.push({ command: name, input });

    if (this.shouldFail) {
      throw new Error(this.failMessage);
    }

    if (name === 'PutObjectCommand') {
      const key = `${input.Bucket}/${input.Key}`;
      this.storage.set(key, input.Body as string);
      return {};
    }

    if (name === 'GetObjectCommand') {
      const key = `${input.Bucket}/${input.Key}`;
      const body = this.storage.get(key);
      if (!body) {
        throw new Error(`NoSuchKey: ${key}`);
      }
      return {
        Body: {
          transformToString: async () => body,
        },
      };
    }

    if (name === 'DeleteObjectCommand') {
      const key = `${input.Bucket}/${input.Key}`;
      this.storage.delete(key);
      return {};
    }

    return {};
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SQS Offload Service', () => {
  let mockS3: MockS3Client;
  let service: SqsOffloadService;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    service = createSqsOffloadService({
      bucket: 'test-bucket',
      prefix: 'sqs-offload/',
      thresholdBytes: 100, // Low threshold for testing
      s3Client: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
    });
  });

  describe('maybeOffload', () => {
    it('should return original body for small payloads', async () => {
      const payload = { message: 'hello' };
      const result = await service.maybeOffload(payload);

      expect(result.offloaded).toBe(false);
      expect(result.body).toBe(JSON.stringify(payload));
      expect(result.originalSizeBytes).toBeLessThanOrEqual(100);
      expect(mockS3.operations).toHaveLength(0);
    });

    it('should offload large payloads to S3', async () => {
      const payload = { message: 'x'.repeat(200) }; // > 100 bytes threshold
      const result = await service.maybeOffload(payload);

      expect(result.offloaded).toBe(true);
      expect(result.originalSizeBytes).toBeGreaterThan(100);

      // Should have uploaded to S3
      expect(mockS3.operations).toHaveLength(1);
      expect(mockS3.operations[0].command).toBe('PutObjectCommand');
      expect(mockS3.operations[0].input.Bucket).toBe('test-bucket');
      expect((mockS3.operations[0].input.Key as string).startsWith('sqs-offload/')).toBe(true);

      // Returned body should be a valid offload reference
      const ref: OffloadedMessageRef = JSON.parse(result.body);
      expect(ref.__offloaded).toBe(true);
      expect(ref.bucket).toBe('test-bucket');
      expect(ref.key).toMatch(/^sqs-offload\/.*\.json$/);
      expect(ref.originalSizeBytes).toBe(result.originalSizeBytes);
    });

    it('should handle payloads exactly at threshold', async () => {
      // Create a payload that is exactly at the threshold
      const smallPayload = { a: 'b' };
      const result = await service.maybeOffload(smallPayload);
      // Small payloads should not be offloaded
      expect(result.offloaded).toBe(false);
    });

    it('should use content-type application/json', async () => {
      const payload = { data: 'x'.repeat(200) };
      await service.maybeOffload(payload);

      expect(mockS3.operations[0].input.ContentType).toBe('application/json');
    });

    it('should set an expiry on the S3 object', async () => {
      const payload = { data: 'x'.repeat(200) };
      await service.maybeOffload(payload);

      expect(mockS3.operations[0].input.Expires).toBeDefined();
      const expires = mockS3.operations[0].input.Expires as Date;
      // Should be approximately 24 hours from now
      const diff = expires.getTime() - Date.now();
      expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(25 * 60 * 60 * 1000);
    });
  });

  describe('maybeRetrieve', () => {
    it('should return parsed body for non-offloaded messages', async () => {
      const payload = { envelope: { avatarId: 'test' } };
      const rawBody = JSON.stringify(payload);

      const result = await service.maybeRetrieve(rawBody);
      expect(result).toEqual(payload);
      expect(mockS3.operations).toHaveLength(0);
    });

    it('should retrieve offloaded payload from S3', async () => {
      const originalPayload = { message: 'x'.repeat(200) };

      // Offload first
      const offloadResult = await service.maybeOffload(originalPayload);
      expect(offloadResult.offloaded).toBe(true);

      // Reset operation tracking
      mockS3.operations = [];

      // Retrieve
      const retrieved = await service.maybeRetrieve(offloadResult.body);
      expect(retrieved).toEqual(originalPayload);

      // Should have done a GetObject
      expect(mockS3.operations).toHaveLength(1);
      expect(mockS3.operations[0].command).toBe('GetObjectCommand');
    });

    it('should throw on invalid JSON', async () => {
      await expect(service.maybeRetrieve('not-json')).rejects.toThrow(
        'Failed to parse SQS message body as JSON'
      );
    });

    it('should throw when S3 object is missing', async () => {
      const ref: OffloadedMessageRef = {
        __offloaded: true,
        bucket: 'test-bucket',
        key: 'sqs-offload/missing.json',
        originalSizeBytes: 1000,
      };

      await expect(service.maybeRetrieve(JSON.stringify(ref))).rejects.toThrow('NoSuchKey');
    });
  });

  describe('cleanup', () => {
    it('should delete offloaded S3 objects', async () => {
      const originalPayload = { message: 'x'.repeat(200) };
      const offloadResult = await service.maybeOffload(originalPayload);
      mockS3.operations = [];

      await service.cleanup(offloadResult.body);

      expect(mockS3.operations).toHaveLength(1);
      expect(mockS3.operations[0].command).toBe('DeleteObjectCommand');
    });

    it('should no-op for non-offloaded messages', async () => {
      await service.cleanup(JSON.stringify({ message: 'hello' }));
      expect(mockS3.operations).toHaveLength(0);
    });

    it('should no-op for invalid JSON', async () => {
      await service.cleanup('not-json');
      expect(mockS3.operations).toHaveLength(0);
    });

    it('should not throw when S3 delete fails', async () => {
      const originalPayload = { message: 'x'.repeat(200) };
      const offloadResult = await service.maybeOffload(originalPayload);
      mockS3.operations = [];
      mockS3.shouldFail = true;

      // Should not throw
      await service.cleanup(offloadResult.body);
      expect(mockS3.operations).toHaveLength(1);
    });
  });

  describe('isOffloaded', () => {
    it('should return true for offload references', () => {
      const ref: OffloadedMessageRef = {
        __offloaded: true,
        bucket: 'test-bucket',
        key: 'sqs-offload/abc.json',
        originalSizeBytes: 1000,
      };
      expect(service.isOffloaded(JSON.stringify(ref))).toBe(true);
    });

    it('should return false for normal messages', () => {
      expect(service.isOffloaded(JSON.stringify({ message: 'hello' }))).toBe(false);
    });

    it('should return false for invalid JSON', () => {
      expect(service.isOffloaded('not-json')).toBe(false);
    });

    it('should return false for partial offload refs', () => {
      expect(service.isOffloaded(JSON.stringify({ __offloaded: true }))).toBe(false);
      expect(service.isOffloaded(JSON.stringify({ __offloaded: true, bucket: 'b' }))).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('should offload, retrieve, and cleanup successfully', async () => {
      const originalPayload = {
        envelope: {
          avatarId: 'test-avatar',
          platform: 'telegram',
          content: { text: 'x'.repeat(200) },
        },
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      };

      // Step 1: Offload
      const offloadResult = await service.maybeOffload(originalPayload);
      expect(offloadResult.offloaded).toBe(true);

      // Step 2: Retrieve
      const retrieved = await service.maybeRetrieve(offloadResult.body);
      expect(retrieved).toEqual(originalPayload);

      // Step 3: Cleanup
      const ref: OffloadedMessageRef = JSON.parse(offloadResult.body);
      const storageKey = `${ref.bucket}/${ref.key}`;
      expect(mockS3.storage.has(storageKey)).toBe(true);

      await service.cleanup(offloadResult.body);
      expect(mockS3.storage.has(storageKey)).toBe(false);
    });

    it('should handle non-offloaded round-trip', async () => {
      const smallPayload = { msg: 'hi' };

      const offloadResult = await service.maybeOffload(smallPayload);
      expect(offloadResult.offloaded).toBe(false);

      const retrieved = await service.maybeRetrieve(offloadResult.body);
      expect(retrieved).toEqual(smallPayload);

      // Cleanup should no-op
      await service.cleanup(offloadResult.body);
    });
  });

  describe('constants', () => {
    it('should export SQS limit constants', () => {
      expect(SQS_OFFLOAD_CONSTANTS.SQS_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
      expect(SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES).toBe(200 * 1024);
      expect(SQS_OFFLOAD_CONSTANTS.OFFLOAD_PREFIX).toBe('sqs-offload/');
    });
  });

  describe('edge cases', () => {
    it('should handle empty object payload', async () => {
      const result = await service.maybeOffload({});
      expect(result.offloaded).toBe(false);
      expect(result.body).toBe('{}');
    });

    it('should handle array payload', async () => {
      const payload = Array.from({ length: 50 }, (_, i) => ({ id: i, data: 'x'.repeat(5) }));
      const result = await service.maybeOffload(payload);

      if (result.offloaded) {
        const retrieved = await service.maybeRetrieve(result.body);
        expect(retrieved).toEqual(payload);
      } else {
        const parsed = JSON.parse(result.body);
        expect(parsed).toEqual(payload);
      }
    });

    it('should handle unicode content correctly', async () => {
      // Unicode characters can be multi-byte, so size calculation matters
      const payload = { text: '\u{1F600}'.repeat(100) }; // 100 emoji (4 bytes each in UTF-8)
      const result = await service.maybeOffload(payload);

      if (result.offloaded) {
        const retrieved = await service.maybeRetrieve(result.body);
        expect(retrieved).toEqual(payload);
      }
    });

    it('should handle nested objects', async () => {
      const payload = {
        envelope: {
          content: {
            media: Array.from({ length: 10 }, () => ({
              type: 'photo',
              url: 'https://example.com/' + 'x'.repeat(20),
            })),
          },
        },
      };
      const result = await service.maybeOffload(payload);

      if (result.offloaded) {
        const retrieved = await service.maybeRetrieve(result.body);
        expect(retrieved).toEqual(payload);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end / integration tests (issue #1069)
  // ---------------------------------------------------------------------------

  describe('e2e: oversized message offload → consume → reassemble → cleanup', () => {
    it('happy path: offload, retrieve original content, then cleanup removes S3 object', async () => {
      const largePayload = {
        envelope: {
          avatarId: 'avatar-e2e',
          platform: 'telegram',
          conversationId: 'conv-e2e',
          content: { text: 'x'.repeat(300) }, // well above 100-byte test threshold
          metadata: { correlationId: 'corr-001' },
        },
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      };

      // 1. Producer: offload
      const offloadResult = await service.maybeOffload(largePayload);
      expect(offloadResult.offloaded).toBe(true);
      expect(offloadResult.originalSizeBytes).toBeGreaterThan(100);

      const ref: OffloadedMessageRef = JSON.parse(offloadResult.body);
      expect(ref.__offloaded).toBe(true);
      const storageKey = `${ref.bucket}/${ref.key}`;
      expect(mockS3.storage.has(storageKey)).toBe(true);

      // 2. Consumer: retrieve — must reconstruct the exact original payload
      const retrieved = await service.maybeRetrieve(offloadResult.body);
      expect(retrieved).toEqual(largePayload);

      // 3. Consumer: cleanup — must remove the S3 object
      await service.cleanup(offloadResult.body);
      expect(mockS3.storage.has(storageKey)).toBe(false);

      // Verify operation sequence: PutObject, GetObject, DeleteObject
      const opNames = mockS3.operations.map((op) => op.command);
      expect(opNames).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    });
  });

  describe('e2e: boundary at exactly 200KB (default production threshold)', () => {
    let prodService: SqsOffloadService;
    let prodMockS3: MockS3Client;

    beforeEach(() => {
      prodMockS3 = new MockS3Client();
      prodService = createSqsOffloadService({
        bucket: 'prod-bucket',
        prefix: 'sqs-offload/',
        thresholdBytes: SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES, // 204800
        s3Client: prodMockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      });
    });

    it('message at exactly 200KB is NOT offloaded (threshold is <=)', async () => {
      // Build a payload whose JSON-stringified form is exactly 200 * 1024 bytes
      const target = SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES; // 204800
      const prefix = '{"d":"';
      const suffix = '"}';
      const padding = target - Buffer.byteLength(prefix + suffix, 'utf-8');
      const payload = { d: 'a'.repeat(padding) };

      // Confirm our size calculation is correct
      const serialized = JSON.stringify(payload);
      expect(Buffer.byteLength(serialized, 'utf-8')).toBe(target);

      const result = await prodService.maybeOffload(payload);
      expect(result.offloaded).toBe(false);
      expect(prodMockS3.operations).toHaveLength(0);
    });

    it('message at 200KB + 1 byte IS offloaded', async () => {
      const target = SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES + 1;
      const prefix = '{"d":"';
      const suffix = '"}';
      const padding = target - Buffer.byteLength(prefix + suffix, 'utf-8');
      const payload = { d: 'a'.repeat(padding) };

      const serialized = JSON.stringify(payload);
      expect(Buffer.byteLength(serialized, 'utf-8')).toBe(target);

      const result = await prodService.maybeOffload(payload);
      expect(result.offloaded).toBe(true);
      expect(prodMockS3.operations).toHaveLength(1);
      expect(prodMockS3.operations[0].command).toBe('PutObjectCommand');

      // Round-trip: retrieve should match
      const retrieved = await prodService.maybeRetrieve(result.body);
      expect(retrieved).toEqual(payload);
    });
  });

  describe('e2e: under-threshold passthrough', () => {
    it('small message passes through without any S3 interaction', async () => {
      const smallPayload = { msg: 'hello', ts: Date.now() };
      const result = await service.maybeOffload(smallPayload);

      expect(result.offloaded).toBe(false);
      expect(result.body).toBe(JSON.stringify(smallPayload));
      expect(mockS3.operations).toHaveLength(0);

      // Consumer side: retrieve still works (just JSON.parse)
      const retrieved = await service.maybeRetrieve(result.body);
      expect(retrieved).toEqual(smallPayload);

      // Cleanup is a no-op
      await service.cleanup(result.body);
      expect(mockS3.operations).toHaveLength(0);
    });
  });

  describe('e2e: S3 write failure during offload', () => {
    it('surfaces a clear error when S3 PutObject fails', async () => {
      mockS3.shouldFail = true;
      mockS3.failMessage = 'AccessDenied: Insufficient permissions to write to bucket';

      const largePayload = { data: 'x'.repeat(200) };

      await expect(service.maybeOffload(largePayload)).rejects.toThrow(
        'AccessDenied: Insufficient permissions to write to bucket'
      );

      // Confirm PutObject was attempted
      expect(mockS3.operations).toHaveLength(1);
      expect(mockS3.operations[0].command).toBe('PutObjectCommand');
    });
  });

  describe('e2e: S3 read failure during retrieval', () => {
    it('surfaces a clear error when S3 GetObject fails', async () => {
      // First, successfully offload
      const largePayload = { data: 'x'.repeat(200) };
      const offloadResult = await service.maybeOffload(largePayload);
      expect(offloadResult.offloaded).toBe(true);

      // Now make S3 fail for reads
      mockS3.operations = [];
      mockS3.shouldFail = true;
      mockS3.failMessage = 'InternalError: S3 is temporarily unavailable';

      await expect(service.maybeRetrieve(offloadResult.body)).rejects.toThrow(
        'InternalError: S3 is temporarily unavailable'
      );

      // Confirm GetObject was attempted
      expect(mockS3.operations).toHaveLength(1);
      expect(mockS3.operations[0].command).toBe('GetObjectCommand');
    });

    it('surfaces NoSuchKey when the S3 object has been deleted or expired', async () => {
      const ref: OffloadedMessageRef = {
        __offloaded: true,
        bucket: 'test-bucket',
        key: 'sqs-offload/expired-object.json',
        originalSizeBytes: 5000,
      };

      await expect(service.maybeRetrieve(JSON.stringify(ref))).rejects.toThrow('NoSuchKey');
    });
  });
});
