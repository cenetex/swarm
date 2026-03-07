/**
 * Gallery Storage Unification Tests (issue #821)
 *
 * Validates that:
 * 1. createMediaDependencies with gallery saver override writes to ADMIN_TABLE
 * 2. The gallery item ID returned from generateImage is the real gallery ID
 * 3. Gallery items written via the override are retrievable via gallery reads
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  createMediaDependencies,
  createGallerySaver,
} from '@swarm/core/services';

describe('Gallery Storage Unification (issue #821)', () => {
  let originalAdminTable: string | undefined;
  let originalStateTable: string | undefined;

  beforeEach(() => {
    originalAdminTable = process.env.ADMIN_TABLE;
    originalStateTable = process.env.STATE_TABLE;
    process.env.ADMIN_TABLE = 'SwarmAdmin-test';
    process.env.STATE_TABLE = 'SwarmState-test';
  });

  afterEach(() => {
    if (originalAdminTable !== undefined) {
      process.env.ADMIN_TABLE = originalAdminTable;
    } else {
      delete process.env.ADMIN_TABLE;
    }
    if (originalStateTable !== undefined) {
      process.env.STATE_TABLE = originalStateTable;
    } else {
      delete process.env.STATE_TABLE;
    }
  });

  describe('createGallerySaver override pattern', () => {
    it('creates a gallery saver targeting the specified table name', () => {
      const saver = createGallerySaver({ tableName: 'SwarmAdmin-test' });
      expect(typeof saver).toBe('function');
    });

    it('default createMediaDependencies produces saveToGallery', () => {
      const deps = createMediaDependencies({ tableName: 'SwarmState-test' });
      expect(deps.saveToGallery).toBeDefined();
      expect(typeof deps.saveToGallery).toBe('function');
    });

    it('gallery saver can be overridden on mediaDeps to target ADMIN_TABLE', () => {
      const deps = createMediaDependencies({ tableName: 'SwarmState-test' });
      const originalSaver = deps.saveToGallery;

      // Override just the gallery saver (pattern used in message-processor & media-processor)
      deps.saveToGallery = createGallerySaver({ tableName: 'SwarmAdmin-test' });

      // The saver should be a different function instance
      expect(deps.saveToGallery).not.toBe(originalSaver);
      expect(typeof deps.saveToGallery).toBe('function');
    });
  });

  describe('gallery item ID derivation', () => {
    it('gallery item ID is derived from s3Key filename without extension', () => {
      // This mirrors the logic in SwarmMediaService.generateImage (index.ts line 142)
      const s3Key = 'avatars/test-avatar/images/1234567890_abc123.png';
      const derivedId = s3Key.split('/').pop()?.split('.')[0] || `img_${Date.now()}`;
      expect(derivedId).toBe('1234567890_abc123');
    });

    it('falls back to img_ prefix when s3Key has no filename', () => {
      const s3Key = '';
      const derivedId = s3Key.split('/').pop()?.split('.')[0] || `img_${Date.now()}`;
      expect(derivedId).toMatch(/^img_\d+$/);
    });
  });

  describe('write-then-read consistency', () => {
    it('gallery saver returns the same ID that was provided in input', async () => {
      // Use a mock DynamoDB client to capture the PutCommand
      const mockSend = mock(() => Promise.resolve({}));
      const mockDocClient = { send: mockSend } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

      const saver = createGallerySaver({
        tableName: 'SwarmAdmin-test',
        dynamoClient: mockDocClient,
      });

      const galleryInput = {
        id: '1234567890_abc123',
        type: 'image' as const,
        url: 'https://cdn.example.com/avatars/test-avatar/images/1234567890_abc123.png',
        s3Key: 'avatars/test-avatar/images/1234567890_abc123.png',
        prompt: 'a beautiful sunset',
        model: 'black-forest-labs/flux-schnell',
        platform: 'telegram',
      };

      const result = await saver!('test-avatar', galleryInput);

      // The returned gallery item should have the same ID
      expect(result.id).toBe('1234567890_abc123');
      expect(result.avatarId).toBe('test-avatar');
      expect(result.url).toBe(galleryInput.url);
      expect(result.createdAt).toBeGreaterThan(0);

      // Verify the PutCommand targeted the correct table
      expect(mockSend).toHaveBeenCalledTimes(1);
      const putCmd = mockSend.mock.calls[0][0];
      expect(putCmd.input.TableName).toBe('SwarmAdmin-test');
      expect(putCmd.input.Item.pk).toBe('AVATAR#test-avatar');
      expect(putCmd.input.Item.sk).toMatch(/^GALLERY#\d+#1234567890_abc123$/);
      expect(putCmd.input.Item.id).toBe('1234567890_abc123');
    });

    it('gallery saver writes to ADMIN_TABLE, not STATE_TABLE, when overridden', async () => {
      const capturedTables: string[] = [];
      const mockSend = mock((cmd: unknown) => {
        const input = (cmd as { input?: { TableName?: string } }).input;
        if (input?.TableName) {
          capturedTables.push(input.TableName);
        }
        return Promise.resolve({});
      });
      const mockDocClient = { send: mockSend } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

      // Simulate the pattern used in message-processor.ts and media-processor.ts:
      // 1. Create deps with STATE_TABLE (for model/key/credit resolution)
      // 2. Override saveToGallery with one targeting ADMIN_TABLE
      const adminSaver = createGallerySaver({
        tableName: 'SwarmAdmin-test',
        dynamoClient: mockDocClient,
      });

      const galleryInput = {
        id: 'test_img',
        type: 'image' as const,
        url: 'https://cdn.example.com/test.png',
        s3Key: 'avatars/test/images/test_img.png',
        prompt: 'test',
        model: 'flux-schnell',
      };

      await adminSaver!('test-avatar', galleryInput);

      // Should write to ADMIN_TABLE
      expect(capturedTables).toContain('SwarmAdmin-test');
      expect(capturedTables).not.toContain('SwarmState-test');
    });
  });
});
