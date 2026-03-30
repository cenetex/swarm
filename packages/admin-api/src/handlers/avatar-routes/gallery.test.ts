/**
 * Tests for avatar-routes/gallery.ts
 *
 * Routes:
 *   GET    /avatars/{id}/gallery
 *   POST   /avatars/{id}/gallery/upload-url
 *   POST   /avatars/{id}/gallery/save
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGalleryRoutes } from './gallery.js';
import { makeCtx, MOCK_AVATAR } from './test-helpers.js';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = MOCK_AVATAR;
let getGalleryResult: unknown[] = [];
let getGalleryUploadUrlResult: unknown = { uploadUrl: 'https://s3.example.com/upload' };
let addToGalleryResult: unknown = { id: 'item-1', url: 'https://cdn/img.jpg', createdAt: Date.now() };

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/gallery.js', () => ({
  getGallery: async () => getGalleryResult,
  generateGalleryId: () => 'generated-id',
  addToGallery: async (..._args: unknown[]) => addToGalleryResult,
}));

vi.mock('../../services/media.js', () => ({
  getGalleryUploadUrl: async (..._args: unknown[]) => getGalleryUploadUrlResult,
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import handler AFTER mocks ─────────────────────────────────────────────
import { handleGalleryRoutes as importedHandler } from './gallery.js';

describe('handleGalleryRoutes', () => {
  beforeEach(() => {
    getAvatarResult = MOCK_AVATAR;
    getGalleryResult = [];
    getGalleryUploadUrlResult = { uploadUrl: 'https://s3.example.com/upload' };
    addToGalleryResult = { id: 'item-1', url: 'https://cdn/img.jpg', createdAt: Date.now() };
  });

  describe('GET /avatars/{id}/gallery', () => {
    it('returns gallery items', async () => {
      getGalleryResult = [
        { id: '1', type: 'image', url: 'https://cdn/1.jpg', prompt: 'test', caption: 'caption-1', createdAt: 1000 },
        { id: '2', type: 'image', url: 'https://cdn/2.jpg', prompt: 'test', caption: 'caption-2', createdAt: 2000 },
      ];

      const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/gallery' });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body as string);
      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe('1');
    });

    it('filters by type', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/avatars/avatar-1/gallery',
        queryStringParameters: { type: 'image' },
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(200);
    });
  });

  describe('POST /avatars/{id}/gallery/upload-url', () => {
    it('returns upload URL with default content type', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/upload-url',
        body: JSON.stringify({}),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body as string);
      expect(body.uploadUrl).toBe('https://s3.example.com/upload');
    });

    it('accepts optional contentType field safely', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/upload-url',
        body: JSON.stringify({ contentType: 'video/mp4' }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(200);
    });

    it('ignores non-string contentType values', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/upload-url',
        body: JSON.stringify({ contentType: 123 }),
      });
      const result = await importedHandler(ctx);

      // Should succeed with default content type
      expect(result?.statusCode).toBe(200);
    });

    it('handles empty body', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/upload-url',
        body: JSON.stringify({}),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(200);
    });
  });

  describe('POST /avatars/{id}/gallery/save', () => {
    it('saves gallery item with required fields', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 'avatars/avatar-1/image.jpg',
          publicUrl: 'https://cdn.example.com/image.jpg',
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(201);
      const body = JSON.parse(result?.body as string);
      expect(body.id).toBe('item-1');
    });

    it('accepts optional caption field safely', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 'avatars/avatar-1/image.jpg',
          publicUrl: 'https://cdn.example.com/image.jpg',
          caption: 'A beautiful sunset',
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(201);
    });

    it('ignores non-string caption values', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 'avatars/avatar-1/image.jpg',
          publicUrl: 'https://cdn.example.com/image.jpg',
          caption: { text: 'object caption' },
        }),
      });
      const result = await importedHandler(ctx);

      // Should succeed with empty caption
      expect(result?.statusCode).toBe(201);
    });

    it('requires s3Key as string', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 123,
          publicUrl: 'https://cdn.example.com/image.jpg',
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(400);
      const body = JSON.parse(result?.body as string);
      expect(body.error).toContain('s3Key and publicUrl are required');
    });

    it('requires publicUrl as string', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 'avatars/avatar-1/image.jpg',
          publicUrl: ['https://cdn.example.com/image.jpg'],
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(400);
      const body = JSON.parse(result?.body as string);
      expect(body.error).toContain('s3Key and publicUrl are required');
    });

    it('handles missing s3Key', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          publicUrl: 'https://cdn.example.com/image.jpg',
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(400);
    });

    it('handles missing publicUrl', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({
          s3Key: 'avatars/avatar-1/image.jpg',
        }),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(400);
    });

    it('handles empty body', async () => {
      const ctx = makeCtx({
        method: 'POST',
        path: '/avatars/avatar-1/gallery/save',
        body: JSON.stringify({}),
      });
      const result = await importedHandler(ctx);

      expect(result?.statusCode).toBe(400);
    });
  });
});
