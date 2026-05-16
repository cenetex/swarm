import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnpostedGalleryImages,
  markGalleryImagePosted,
  getRecentGalleryMetadata,
} from './gallery-query.js';
import { _setDynamoClient } from './dynamo-client.js';

// Mock the dynamo client
function createMockClient(sendFn: (...args: unknown[]) => Promise<unknown>) {
  return { send: sendFn } as any;
}

describe('gallery-query', () => {
  const originalAdminTable = process.env.ADMIN_TABLE;

  beforeEach(() => {
    delete process.env.ADMIN_TABLE;
    _setDynamoClient(null);
  });

  afterEach(() => {
    if (originalAdminTable === undefined) {
      delete process.env.ADMIN_TABLE;
    } else {
      process.env.ADMIN_TABLE = originalAdminTable;
    }
    _setDynamoClient(null);
  });

  describe('getUnpostedGalleryImages', () => {
    it('returns empty array when ADMIN_TABLE is not configured', async () => {
      const result = await getUnpostedGalleryImages('avatar-1', { adminTable: undefined });
      expect(result).toEqual([]);
    });

    it('returns unposted images filtered by type and posted status', async () => {
      const send = vi.fn().mockResolvedValueOnce({
        Items: [
          {
            id: 'img-1',
            sk: 'GALLERY#123#img-1',
            type: 'image',
            url: 'https://cdn.example.com/img-1.png',
            s3Key: 'media/img-1.png',
            prompt: 'A sunset over the ocean',
            caption: 'Beautiful sunset',
            model: 'sdxl',
            platform: 'telegram',
            postedToTwitter: false,
            createdAt: 1000,
          },
          {
            id: 'img-2',
            sk: 'GALLERY#124#img-2',
            type: 'image',
            url: 'https://cdn.example.com/img-2.png',
            s3Key: 'media/img-2.png',
            prompt: 'A cat on a couch',
            model: 'sdxl',
            postedToTwitter: true, // Already posted
            createdAt: 900,
          },
          {
            id: 'vid-1',
            sk: 'GALLERY#125#vid-1',
            type: 'video', // Not an image
            url: 'https://cdn.example.com/vid-1.mp4',
            s3Key: 'media/vid-1.mp4',
            prompt: 'Dancing cat',
            model: 'minimax',
            postedToTwitter: false,
            createdAt: 800,
          },
        ],
        LastEvaluatedKey: undefined,
      });

      _setDynamoClient(createMockClient(send));

      const result = await getUnpostedGalleryImages('avatar-1', {
        adminTable: 'test-admin-table',
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-1');
      expect(result[0].url).toBe('https://cdn.example.com/img-1.png');
      expect(result[0].sk).toBe('GALLERY#123#img-1');
    });

    it('respects the limit option', async () => {
      const items = Array.from({ length: 5 }, (_, i) => ({
        id: `img-${i}`,
        sk: `GALLERY#${100 + i}#img-${i}`,
        type: 'image',
        url: `https://cdn.example.com/img-${i}.png`,
        s3Key: `media/img-${i}.png`,
        prompt: `Image ${i}`,
        model: 'sdxl',
        postedToTwitter: false,
        createdAt: 1000 - i,
      }));

      const send = vi.fn().mockResolvedValueOnce({
        Items: items,
        LastEvaluatedKey: undefined,
      });

      _setDynamoClient(createMockClient(send));

      const result = await getUnpostedGalleryImages('avatar-1', {
        adminTable: 'test-table',
        limit: 2,
      });

      expect(result).toHaveLength(2);
    });

    it('handles DynamoDB errors gracefully', async () => {
      const send = vi.fn().mockRejectedValueOnce(new Error('DynamoDB timeout'));
      _setDynamoClient(createMockClient(send));

      const result = await getUnpostedGalleryImages('avatar-1', {
        adminTable: 'test-table',
      });

      expect(result).toEqual([]);
    });
  });

  describe('markGalleryImagePosted', () => {
    it('no-ops when adminTable option is not provided and env is unset', async () => {
      const send = vi.fn();
      _setDynamoClient(createMockClient(send));

      await markGalleryImagePosted('avatar-1', 'GALLERY#123#img-1');
      expect(send).not.toHaveBeenCalled();
    });

    it('sends UpdateCommand to mark image as posted', async () => {
      const send = vi.fn().mockResolvedValueOnce({});
      _setDynamoClient(createMockClient(send));

      await markGalleryImagePosted('avatar-1', 'GALLERY#123#img-1', {
        adminTable: 'test-table',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0][0];
      expect(command.input.TableName).toBe('test-table');
      expect(command.input.Key).toEqual({
        pk: 'AVATAR#avatar-1',
        sk: 'GALLERY#123#img-1',
      });
      expect(command.input.ExpressionAttributeValues[':val']).toBe(true);
    });

    it('handles errors gracefully without throwing', async () => {
      const send = vi.fn().mockRejectedValueOnce(new Error('DynamoDB error'));
      _setDynamoClient(createMockClient(send));

      // Should not throw
      await markGalleryImagePosted('avatar-1', 'GALLERY#123#img-1', {
        adminTable: 'test-table',
      });
    });
  });

  describe('getRecentGalleryMetadata', () => {
    it('returns empty array when ADMIN_TABLE is not configured', async () => {
      const result = await getRecentGalleryMetadata('avatar-1');
      expect(result).toEqual([]);
    });

    it('returns prompts and captions from recent gallery images', async () => {
      const send = vi.fn().mockResolvedValueOnce({
        Items: [
          {
            type: 'image',
            prompt: 'A mystical forest',
            caption: 'In the enchanted woods',
            createdAt: 1000,
          },
          {
            type: 'image',
            prompt: 'Neon cityscape',
            createdAt: 900,
          },
          {
            type: 'video', // Not an image — should be filtered
            prompt: 'Dancing animation',
            createdAt: 800,
          },
        ],
      });

      _setDynamoClient(createMockClient(send));

      const result = await getRecentGalleryMetadata('avatar-1', {
        adminTable: 'test-table',
        limit: 5,
      });

      expect(result).toHaveLength(2);
      expect(result[0].prompt).toBe('A mystical forest');
      expect(result[0].caption).toBe('In the enchanted woods');
      expect(result[1].prompt).toBe('Neon cityscape');
      expect(result[1].caption).toBeUndefined();
    });

    it('handles errors gracefully', async () => {
      const send = vi.fn().mockRejectedValueOnce(new Error('timeout'));
      _setDynamoClient(createMockClient(send));

      const result = await getRecentGalleryMetadata('avatar-1', {
        adminTable: 'test-table',
      });

      expect(result).toEqual([]);
    });
  });
});
