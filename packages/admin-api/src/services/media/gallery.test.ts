/**
 * Gallery Service Tests
 *
 * Tests for gallery pagination and type filtering across full result sets.
 *
 * @see packages/admin-api/src/services/media/gallery.ts
 * @see https://github.com/cenetex/aws-swarm/issues/822
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@swarm/core';
import { _setDynamoClient } from '../dynamo-client.js';

// Ensure env is set before importing module under test.
process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

import { getGallery, findByDescription } from './gallery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake gallery item with the given type and index. */
function fakeItem(index: number, type: 'image' | 'video' | 'sticker' = 'image') {
  const ts = Date.now() - index * 1000;
  return {
    pk: 'AVATAR#test-avatar',
    sk: `GALLERY#${ts}#item-${index}`,
    avatarId: 'test-avatar',
    id: `item-${index}`,
    url: `https://cdn.example.com/${type}-${index}.png`,
    s3Key: `avatars/test-avatar/${type}-${index}.png`,
    type,
    prompt: `A ${type} number ${index}`,
    platform: 'admin-ui',
    createdAt: ts,
    postedToTwitter: false,
    convertedToSticker: false,
  };
}

// ---------------------------------------------------------------------------
// Mock DynamoDB client
// ---------------------------------------------------------------------------
const mockSend = mock(() => Promise.resolve({ Items: [] } as any));

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockImplementation(() => Promise.resolve({ Items: [] } as any));
  _setDynamoClient({ send: mockSend } as unknown as DynamoDBDocumentClient);
});

afterEach(() => {
  _setDynamoClient(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getGallery — pagination and filtering', () => {
  it('returns items without filtering when no type is specified', async () => {
    const items = Array.from({ length: 5 }, (_, i) => fakeItem(i, 'image'));
    mockSend.mockImplementation(() => Promise.resolve({ Items: items }));

    const result = await getGallery('test-avatar', { limit: 5 });
    expect(result).toHaveLength(5);
  });

  it('paginates through DynamoDB to find enough matching items when type filter is applied', async () => {
    // Simulate: first page has 100 videos, second page has 5 images.
    // With limit=5 and type='image', old code would return 0 results.
    const videosPage = Array.from({ length: 100 }, (_, i) => fakeItem(i, 'video'));
    const imagesPage = Array.from({ length: 5 }, (_, i) => fakeItem(100 + i, 'image'));

    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ Items: videosPage, LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      }
      return Promise.resolve({ Items: imagesPage });
    });

    const result = await getGallery('test-avatar', { limit: 5, type: 'image' });
    expect(result).toHaveLength(5);
    expect(result.every((item: any) => item.type === 'image')).toBe(true);
    // Must have made at least 2 DynamoDB calls to paginate
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('returns fewer items than limit when all pages are exhausted', async () => {
    const mixed = [
      fakeItem(0, 'video'),
      fakeItem(1, 'image'),
      fakeItem(2, 'video'),
    ];
    mockSend.mockImplementation(() => Promise.resolve({ Items: mixed }));

    const result = await getGallery('test-avatar', { limit: 10, type: 'image' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
  });

  it('respects notPostedToTwitter filter across pages', async () => {
    const posted = { ...fakeItem(0, 'image'), postedToTwitter: true };
    const notPosted = { ...fakeItem(1, 'image'), postedToTwitter: false };

    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ Items: [posted], LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      }
      return Promise.resolve({ Items: [notPosted] });
    });

    const result = await getGallery('test-avatar', {
      limit: 1,
      type: 'image',
      notPostedToTwitter: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('item-1');
    expect(callCount).toBe(2);
  });

  it('stops at hard cap to prevent runaway queries', async () => {
    // Every page returns 100 videos, never any images.
    // Should stop after MAX_ROWS_SCANNED (2000) / 100 = 20 pages.
    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      const items = Array.from({ length: 100 }, (_, i) =>
        fakeItem(callCount * 100 + i, 'video'),
      );
      return Promise.resolve({ Items: items, LastEvaluatedKey: { pk: 'x', sk: 'y' } });
    });

    const result = await getGallery('test-avatar', { limit: 5, type: 'image' });
    expect(result).toHaveLength(0);
    // 2000 rows / 100 per page = 20 pages max
    expect(callCount).toBe(20);
  });
});

describe('findByDescription — uses paginated getGallery', () => {
  it('finds items matching search terms beyond the first page', async () => {
    // Page 1: 100 videos with unrelated prompts
    // Page 2: 1 image whose prompt matches the search
    const videosPage = Array.from({ length: 100 }, (_, i) => ({
      ...fakeItem(i, 'video'),
      prompt: 'unrelated content',
    }));
    const matchPage = [
      { ...fakeItem(100, 'image'), prompt: 'sunset over mountains' },
    ];

    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ Items: videosPage, LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      }
      return Promise.resolve({ Items: matchPage });
    });

    const result = await findByDescription('test-avatar', 'sunset', 'image');
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe('sunset over mountains');
  });

  it('keeps scanning beyond the first 100 type-matched items', async () => {
    const firstHundredImages = Array.from({ length: 100 }, (_, i) => ({
      ...fakeItem(i, 'image'),
      prompt: 'ordinary portrait',
    }));
    const lateMatch = [
      { ...fakeItem(100, 'image'), prompt: 'sunset over mountains' },
    ];

    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ Items: firstHundredImages, LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      }
      return Promise.resolve({ Items: lateMatch });
    });

    const result = await findByDescription('test-avatar', 'sunset', 'image');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('item-100');
    expect(callCount).toBe(2);
  });
});
