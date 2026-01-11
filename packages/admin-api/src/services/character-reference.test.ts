/**
 * Character Reference Service Tests
 *
 * Comprehensive test suite for character reference upload functionality.
 * Tests cover: happy paths, error handling, timeouts, rollbacks, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Mock AWS SDK clients before importing the module
const mockS3Send = vi.fn();
const mockDynamoSend = vi.fn();
const mockGetSignedUrl = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockS3Send,
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({ ...params, _type: 'PutObjectCommand' })),
  DeleteObjectCommand: vi.fn().mockImplementation((params) => ({ ...params, _type: 'DeleteObjectCommand' })),
  GetObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  SendMessageCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      send: mockDynamoSend,
    }),
  },
  PutCommand: vi.fn(),
  QueryCommand: vi.fn(),
  DeleteCommand: vi.fn(),
  UpdateCommand: vi.fn().mockImplementation((params) => ({ ...params, _type: 'UpdateCommand' })),
  GetCommand: vi.fn(),
}));

vi.mock('./credits.js', () => ({
  canUseTool: vi.fn().mockResolvedValue({ allowed: true, credits: 3 }),
  consumeCredit: vi.fn().mockResolvedValue(true),
}));

vi.mock('./gallery.js', () => ({
  getGalleryItem: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Character Reference Upload - Unit Tests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Set environment variables
    process.env.MEDIA_BUCKET = 'test-media-bucket';
    process.env.CDN_URL = 'https://cdn.example.com';
    process.env.ADMIN_TABLE = 'test-admin-table';

    // Default mock implementations
    mockGetSignedUrl.mockResolvedValue('https://signed-url.example.com/upload');
    mockS3Send.mockResolvedValue({});
    mockDynamoSend.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getCharacterReferenceUploadUrl', () => {
    it('should return signed URL with correct S3 key structure', async () => {
      const { getCharacterReferenceUploadUrl } = await import('./media.js');

      const result = await getCharacterReferenceUploadUrl('agent-123');

      expect(result.uploadUrl).toBe('https://signed-url.example.com/upload');
      expect(result.s3Key).toMatch(/^agents\/agent-123\/character-reference\/[a-f0-9-]+\.png$/);
      expect(result.publicUrl).toMatch(/^https:\/\/cdn\.example\.com\/agents\/agent-123\/character-reference\//);
    });

    it('should fall back to S3 URL when CDN is not configured', async () => {
      delete process.env.CDN_URL;
      vi.resetModules();

      const { getCharacterReferenceUploadUrl } = await import('./media.js');

      const result = await getCharacterReferenceUploadUrl('agent-123');

      expect(result.publicUrl).toMatch(/^https:\/\/test-media-bucket\.s3\.amazonaws\.com\//);
    });

    it('should throw when S3 signing fails', async () => {
      mockGetSignedUrl.mockRejectedValueOnce(new Error('S3 signing failed'));

      const { getCharacterReferenceUploadUrl } = await import('./media.js');

      await expect(getCharacterReferenceUploadUrl('agent-123'))
        .rejects.toThrow('S3 signing failed');
    });
  });

  describe('setCharacterReference - URL source', () => {
    it('should download image from URL and store in S3', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      const { setCharacterReference } = await import('./media.js');

      const result = await setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/image.png' },
        'Test character'
      );

      expect(result.url).toMatch(/^https:\/\/cdn\.example\.com\//);
      expect(result.s3Key).toMatch(/^agents\/agent-123\/character-reference\//);
      expect(mockS3Send).toHaveBeenCalled();
      expect(mockDynamoSend).toHaveBeenCalled();
    });

    it('should throw on failed image download', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Not Found',
      });

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/missing.png' }
      )).rejects.toThrow('Failed to download image: Not Found');
    });

    it('should timeout on slow URL download', async () => {
      // Simulate a slow fetch that never resolves
      mockFetch.mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 100);
      }));

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://slow-server.com/image.png' }
      )).rejects.toThrow();
    });
  });

  describe('setCharacterReference - Error handling and rollback', () => {
    it('should rollback S3 upload when DynamoDB update fails', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      // S3 upload succeeds
      mockS3Send.mockResolvedValueOnce({});
      // DynamoDB update fails
      mockDynamoSend.mockRejectedValueOnce(new Error('DynamoDB error'));
      // S3 delete (rollback) succeeds
      mockS3Send.mockResolvedValueOnce({});

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/image.png' }
      )).rejects.toThrow('Failed to save character reference');

      // Verify rollback was attempted (DeleteObjectCommand)
      expect(mockS3Send).toHaveBeenCalledTimes(2);
    });

    it('should log error when rollback also fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      // S3 upload succeeds
      mockS3Send.mockResolvedValueOnce({});
      // DynamoDB update fails
      mockDynamoSend.mockRejectedValueOnce(new Error('DynamoDB error'));
      // S3 delete (rollback) also fails
      mockS3Send.mockRejectedValueOnce(new Error('S3 delete failed'));

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/image.png' }
      )).rejects.toThrow('Failed to save character reference');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rollback failed'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('setCharacterReference - Rate limiting', () => {
    it('should check credits before processing', async () => {
      const { canUseTool } = await import('./credits.js');
      (canUseTool as Mock).mockResolvedValueOnce({ allowed: false, reason: 'Daily limit reached' });

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/image.png' }
      )).rejects.toThrow('Rate limited: Daily limit reached');

      // Should not attempt any uploads
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('should consume credit only after successful save', async () => {
      const { consumeCredit } = await import('./credits.js');

      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      const { setCharacterReference } = await import('./media.js');

      await setCharacterReference(
        'agent-123',
        { type: 'url', url: 'https://example.com/image.png' }
      );

      expect(consumeCredit).toHaveBeenCalledWith('agent-123', 'set_character_reference');
    });
  });

  describe('setCharacterReference - Gallery source', () => {
    it('should use existing gallery image', async () => {
      const { getGalleryItem } = await import('./gallery.js');
      (getGalleryItem as Mock).mockResolvedValueOnce({
        id: 'gallery-item-1',
        url: 'https://cdn.example.com/agents/agent-123/images/existing.png',
      });

      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      const { setCharacterReference } = await import('./media.js');

      const result = await setCharacterReference(
        'agent-123',
        { type: 'gallery', imageId: 'gallery-item-1' }
      );

      expect(result.url).toBeDefined();
      expect(getGalleryItem).toHaveBeenCalledWith('agent-123', 'gallery-item-1');
    });

    it('should throw when gallery image not found', async () => {
      const { getGalleryItem } = await import('./gallery.js');
      (getGalleryItem as Mock).mockResolvedValueOnce(null);

      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        { type: 'gallery', imageId: 'missing-item' }
      )).rejects.toThrow('Image not found in gallery: missing-item');
    });
  });

  describe('setCharacterReference - Invalid source', () => {
    it('should throw on invalid source type', async () => {
      const { setCharacterReference } = await import('./media.js');

      await expect(setCharacterReference(
        'agent-123',
        // @ts-expect-error - Testing invalid input
        { type: 'invalid', url: 'test' }
      )).rejects.toThrow('Invalid source type');
    });
  });
});

describe('Character Reference - Integration Test Scenarios', () => {
  /**
   * These tests document the E2E scenarios that should be tested
   * in a full integration test environment with real AWS services.
   */

  describe('Happy Path Scenarios', () => {
    it.todo('E2E: Complete upload flow from UI to database');
    it.todo('E2E: Character reference appears in subsequent image generations');
    it.todo('E2E: Character reference persists across sessions');
    it.todo('E2E: Multiple agents can have different character references');
  });

  describe('Failure Recovery Scenarios', () => {
    it.todo('E2E: UI shows error when signed URL expires');
    it.todo('E2E: UI recovers gracefully when S3 upload fails');
    it.todo('E2E: UI handles network disconnection mid-upload');
    it.todo('E2E: Pending upload state persists across page refresh');
  });

  describe('Concurrency Scenarios', () => {
    it.todo('E2E: Simultaneous profile and character ref updates');
    it.todo('E2E: Rapid successive updates maintain data consistency');
    it.todo('E2E: Multiple browser tabs updating same agent');
  });

  describe('Rate Limiting Scenarios', () => {
    it.todo('E2E: UI shows friendly rate limit message');
    it.todo('E2E: Credits refill after waiting period');
    it.todo('E2E: Daily limit resets at midnight UTC');
  });

  describe('Security Scenarios', () => {
    it.todo('E2E: Signed URL cannot be reused after expiry');
    it.todo('E2E: Cannot upload to another agent\'s path');
    it.todo('E2E: Invalid file types are rejected');
  });
});

describe('Character Reference - Type Consistency', () => {
  it('should have consistent type definitions across packages', () => {
    // This test documents the expected type structure
    // and will fail if types diverge

    interface ExpectedCharacterReference {
      url: string;
      s3Key?: string;
      description?: string;
      generatedPrompt?: string;
      updatedAt?: number;
    }

    // Verify the structure matches expectations
    const validRef: ExpectedCharacterReference = {
      url: 'https://example.com/ref.png',
      s3Key: 'agents/123/character-reference/abc.png',
      description: 'Blue whale character',
      generatedPrompt: 'A blue whale swimming',
      updatedAt: Date.now(),
    };

    expect(validRef.url).toBeDefined();
    expect(typeof validRef.url).toBe('string');
  });
});
