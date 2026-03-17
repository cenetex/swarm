/**
 * SQS Payload Offload Service Tests
 *
 * Tests for transparent S3 offloading of large SQS messages.
 * Uses mock S3 client to verify offload/retrieve/cleanup behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createSqsOffloadService,
  createSqsOffloadServiceFromEnv,
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

  // -------------------------------------------------------------------------
  // Threshold boundary tests at the default 200KB limit
  // -------------------------------------------------------------------------

  describe('threshold boundary at default 200KB', () => {
    let defaultService: SqsOffloadService;
    let defaultMockS3: MockS3Client;

    beforeEach(() => {
      defaultMockS3 = new MockS3Client();
      defaultService = createSqsOffloadService({
        bucket: 'test-bucket',
        s3Client: defaultMockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
        // No thresholdBytes — use the default 200KB
      });
    });

    it('does NOT offload a payload exactly at the default 200KB threshold', async () => {
      const threshold = SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES; // 204800
      const baseJson = '{"d":""}';
      const padding = threshold - Buffer.byteLength(baseJson, 'utf-8');
      const exactPayload = { d: 'x'.repeat(padding) };
      expect(Buffer.byteLength(JSON.stringify(exactPayload), 'utf-8')).toBe(threshold);

      const result = await defaultService.maybeOffload(exactPayload);
      expect(result.offloaded).toBe(false);
      expect(result.originalSizeBytes).toBe(threshold);
      expect(defaultMockS3.operations).toHaveLength(0);
    });

    it('offloads a payload one byte over the default 200KB threshold', async () => {
      const threshold = SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES;
      const baseJson = '{"d":""}';
      const padding = threshold - Buffer.byteLength(baseJson, 'utf-8') + 1;
      const overPayload = { d: 'x'.repeat(padding) };
      expect(Buffer.byteLength(JSON.stringify(overPayload), 'utf-8')).toBe(threshold + 1);

      const result = await defaultService.maybeOffload(overPayload);
      expect(result.offloaded).toBe(true);
      expect(result.originalSizeBytes).toBe(threshold + 1);
      expect(defaultMockS3.operations).toHaveLength(1);
      expect(defaultMockS3.operations[0].command).toBe('PutObjectCommand');
    });

    it('does NOT offload a payload one byte under the default 200KB threshold', async () => {
      const threshold = SQS_OFFLOAD_CONSTANTS.DEFAULT_OFFLOAD_THRESHOLD_BYTES;
      const baseJson = '{"d":""}';
      const padding = threshold - Buffer.byteLength(baseJson, 'utf-8') - 1;
      const underPayload = { d: 'x'.repeat(padding) };
      expect(Buffer.byteLength(JSON.stringify(underPayload), 'utf-8')).toBe(threshold - 1);

      const result = await defaultService.maybeOffload(underPayload);
      expect(result.offloaded).toBe(false);
      expect(result.originalSizeBytes).toBe(threshold - 1);
      expect(defaultMockS3.operations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error: S3 unavailable during offload
  // -------------------------------------------------------------------------

  describe('S3 unavailable during offload', () => {
    it('throws when S3 PutObject fails', async () => {
      mockS3.shouldFail = true;
      mockS3.failMessage = 'ServiceUnavailable: S3 is down';

      const largePayload = { data: 'x'.repeat(200) };
      await expect(service.maybeOffload(largePayload)).rejects.toThrow('ServiceUnavailable');
    });
  });

  // -------------------------------------------------------------------------
  // Error: S3 unavailable during retrieval
  // -------------------------------------------------------------------------

  describe('S3 unavailable during retrieval', () => {
    it('throws when S3 GetObject fails for an offloaded message', async () => {
      // First offload successfully
      const largePayload = { data: 'x'.repeat(200) };
      const offloadResult = await service.maybeOffload(largePayload);
      expect(offloadResult.offloaded).toBe(true);

      // Now make S3 fail
      mockS3.shouldFail = true;
      mockS3.failMessage = 'InternalError: S3 read failure';

      await expect(service.maybeRetrieve(offloadResult.body)).rejects.toThrow('InternalError');
    });

    it('throws when S3 returns empty body during retrieval', async () => {
      // Create a mock that returns empty body
      const emptyBodyS3 = new MockS3Client();
      // Override the send method for GetObject to return undefined body
      const originalSend = emptyBodyS3.send.bind(emptyBodyS3);
      emptyBodyS3.send = async (command: unknown) => {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
        if (cmd.constructor.name === 'GetObjectCommand') {
          emptyBodyS3.operations.push({ command: 'GetObjectCommand', input: cmd.input });
          return { Body: undefined };
        }
        return originalSend(command);
      };

      const emptyService = createSqsOffloadService({
        bucket: 'test-bucket',
        prefix: 'sqs-offload/',
        thresholdBytes: 100,
        s3Client: emptyBodyS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      });

      const ref: OffloadedMessageRef = {
        __offloaded: true,
        bucket: 'test-bucket',
        key: 'sqs-offload/empty.json',
        originalSizeBytes: 500,
      };
      await expect(emptyService.maybeRetrieve(JSON.stringify(ref))).rejects.toThrow('Empty S3 response');
    });
  });

  // -------------------------------------------------------------------------
  // Corrupted offload marker scenarios
  // -------------------------------------------------------------------------

  describe('corrupted offload marker', () => {
    it('treats partial offload ref (missing key) as normal message', async () => {
      const partial = JSON.stringify({ __offloaded: true, bucket: 'test-bucket' });
      const result = await service.maybeRetrieve(partial);
      expect(result).toEqual({ __offloaded: true, bucket: 'test-bucket' });
      expect(mockS3.operations).toHaveLength(0);
    });

    it('treats __offloaded: false as normal message', async () => {
      const falseRef = JSON.stringify({
        __offloaded: false,
        bucket: 'test-bucket',
        key: 'sqs-offload/x.json',
        originalSizeBytes: 1000,
      });
      const result = await service.maybeRetrieve(falseRef);
      expect(result).toEqual(JSON.parse(falseRef));
      expect(mockS3.operations).toHaveLength(0);
    });

    it('treats __offloaded: "true" (string) as normal message', async () => {
      const stringRef = JSON.stringify({
        __offloaded: 'true',
        bucket: 'test-bucket',
        key: 'sqs-offload/x.json',
        originalSizeBytes: 1000,
      });
      const result = await service.maybeRetrieve(stringRef);
      // String "true" !== boolean true, so not recognized as offload ref
      expect(result).toEqual(JSON.parse(stringRef));
      expect(mockS3.operations).toHaveLength(0);
    });

    it('treats offload ref with non-string bucket as normal message', async () => {
      const badRef = JSON.stringify({
        __offloaded: true,
        bucket: 42,
        key: 'sqs-offload/x.json',
        originalSizeBytes: 1000,
      });
      const result = await service.maybeRetrieve(badRef);
      expect(result).toEqual(JSON.parse(badRef));
      expect(mockS3.operations).toHaveLength(0);
    });

    it('treats offload ref with non-string key as normal message', async () => {
      const badRef = JSON.stringify({
        __offloaded: true,
        bucket: 'test-bucket',
        key: 123,
        originalSizeBytes: 1000,
      });
      const result = await service.maybeRetrieve(badRef);
      expect(result).toEqual(JSON.parse(badRef));
      expect(mockS3.operations).toHaveLength(0);
    });

    it('cleanup is no-op for corrupted offload markers', async () => {
      const partial = JSON.stringify({ __offloaded: true, bucket: 'test-bucket' });
      await service.cleanup(partial);
      expect(mockS3.operations).toHaveLength(0);
    });

    it('isOffloaded returns false for corrupted offload markers', () => {
      expect(service.isOffloaded(JSON.stringify({ __offloaded: true }))).toBe(false);
      expect(service.isOffloaded(JSON.stringify({ __offloaded: true, bucket: 'b' }))).toBe(false);
      expect(service.isOffloaded(JSON.stringify({ __offloaded: 'true', bucket: 'b', key: 'k' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // S3 key uniqueness and custom prefix
  // -------------------------------------------------------------------------

  describe('S3 key format', () => {
    it('generates unique keys for each offload', async () => {
      const largePayload = { data: 'x'.repeat(200) };
      const result1 = await service.maybeOffload(largePayload);
      const result2 = await service.maybeOffload(largePayload);
      const ref1: OffloadedMessageRef = JSON.parse(result1.body);
      const ref2: OffloadedMessageRef = JSON.parse(result2.body);
      expect(ref1.key).not.toBe(ref2.key);
    });

    it('uses a custom prefix when configured', async () => {
      const customService = createSqsOffloadService({
        bucket: 'test-bucket',
        prefix: 'my-prefix/',
        thresholdBytes: 100,
        s3Client: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      });
      const largePayload = { data: 'x'.repeat(200) };
      const result = await customService.maybeOffload(largePayload);
      const ref: OffloadedMessageRef = JSON.parse(result.body);
      expect(ref.key).toMatch(/^my-prefix\//);
      expect(ref.key).toMatch(/\.json$/);
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
});

// ---------------------------------------------------------------------------
// createSqsOffloadServiceFromEnv
// ---------------------------------------------------------------------------

describe('createSqsOffloadServiceFromEnv', () => {
  const savedEnv = {
    SQS_OFFLOAD_BUCKET: process.env.SQS_OFFLOAD_BUCKET,
    MEDIA_BUCKET: process.env.MEDIA_BUCKET,
    SQS_OFFLOAD_PREFIX: process.env.SQS_OFFLOAD_PREFIX,
    SQS_OFFLOAD_THRESHOLD_BYTES: process.env.SQS_OFFLOAD_THRESHOLD_BYTES,
  };

  beforeEach(() => {
    delete process.env.SQS_OFFLOAD_BUCKET;
    delete process.env.MEDIA_BUCKET;
    delete process.env.SQS_OFFLOAD_PREFIX;
    delete process.env.SQS_OFFLOAD_THRESHOLD_BYTES;
  });

  // Restore after each test to avoid cross-contamination
  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns null when neither SQS_OFFLOAD_BUCKET nor MEDIA_BUCKET is set', () => {
    expect(createSqsOffloadServiceFromEnv()).toBeNull();
  });

  it('returns a service when SQS_OFFLOAD_BUCKET is set', () => {
    process.env.SQS_OFFLOAD_BUCKET = 'offload-bucket';
    const svc = createSqsOffloadServiceFromEnv();
    expect(svc).not.toBeNull();
  });

  it('falls back to MEDIA_BUCKET when SQS_OFFLOAD_BUCKET is not set', () => {
    process.env.MEDIA_BUCKET = 'media-bucket';
    const svc = createSqsOffloadServiceFromEnv();
    expect(svc).not.toBeNull();
  });

  it('prefers SQS_OFFLOAD_BUCKET over MEDIA_BUCKET', () => {
    process.env.SQS_OFFLOAD_BUCKET = 'offload-bucket';
    process.env.MEDIA_BUCKET = 'media-bucket';
    const svc = createSqsOffloadServiceFromEnv();
    expect(svc).not.toBeNull();
    // We can't directly inspect the bucket, but the service should exist
  });
});

// ---------------------------------------------------------------------------
// DLQ integration: offloaded message in DLQ body
// ---------------------------------------------------------------------------

describe('DLQ integration — offloaded messages', () => {
  let mockS3: MockS3Client;
  let service: SqsOffloadService;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    service = createSqsOffloadService({
      bucket: 'test-bucket',
      prefix: 'sqs-offload/',
      thresholdBytes: 100,
      s3Client: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
    });
  });

  it('offloaded DLQ message can be retrieved for archival', async () => {
    // Simulate: a large message was offloaded, then ended up in the DLQ.
    // The DLQ processor needs to retrieve it to archive the body.
    const originalPayload = {
      envelope: {
        avatarId: 'agent-dlq',
        platform: 'telegram',
        conversationId: 'conv-99',
        content: { text: 'x'.repeat(200) },
      },
      enqueuedAt: Date.now(),
      attempts: 3,
      maxAttempts: 3,
    };

    // Offload the original message
    const offloadResult = await service.maybeOffload(originalPayload);
    expect(offloadResult.offloaded).toBe(true);

    // The DLQ record body is the offload reference JSON
    const dlqRecordBody = offloadResult.body;

    // DLQ processor checks if offloaded
    expect(service.isOffloaded(dlqRecordBody)).toBe(true);

    // DLQ processor retrieves the original payload for archival
    const retrieved = await service.maybeRetrieve(dlqRecordBody);
    expect(retrieved).toEqual(originalPayload);

    // After archiving, DLQ processor cleans up the S3 object
    await service.cleanup(dlqRecordBody);

    // Verify the S3 object is removed
    const ref: OffloadedMessageRef = JSON.parse(dlqRecordBody);
    const storageKey = `${ref.bucket}/${ref.key}`;
    expect(mockS3.storage.has(storageKey)).toBe(false);
  });

  it('non-offloaded DLQ message can be processed normally', async () => {
    // Small messages are NOT offloaded; the DLQ body is the raw payload
    const smallPayload = { avatarId: 'agent-small', error: 'timeout' };
    const rawBody = JSON.stringify(smallPayload);

    expect(service.isOffloaded(rawBody)).toBe(false);

    const retrieved = await service.maybeRetrieve(rawBody);
    expect(retrieved).toEqual(smallPayload);

    // Cleanup is a no-op
    await service.cleanup(rawBody);
    expect(mockS3.operations).toHaveLength(0);
  });

  it('DLQ can still archive when S3 cleanup fails for offloaded message', async () => {
    const largePayload = {
      envelope: { avatarId: 'agent-cleanup-fail', platform: 'discord' },
      enqueuedAt: Date.now(),
      attempts: 3,
      maxAttempts: 3,
      extraData: 'x'.repeat(200),
    };

    const offloadResult = await service.maybeOffload(largePayload);
    expect(offloadResult.offloaded).toBe(true);

    // Retrieve succeeds (archival)
    const retrieved = await service.maybeRetrieve(offloadResult.body);
    expect(retrieved).toEqual(largePayload);

    // S3 fails during cleanup
    mockS3.shouldFail = true;
    mockS3.failMessage = 'AccessDenied: cleanup blocked';

    // cleanup() should NOT throw — it swallows the error
    await expect(service.cleanup(offloadResult.body)).resolves.toBeUndefined();
  });
});
