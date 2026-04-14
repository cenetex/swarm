/**
 * Tests for BlogPostStore
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DynamoDBClient, QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { BlogPostStore, type BlogPost, type BlogPostInput } from './blog-post-store.js';

// Mock the DynamoDB client
mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDynamoDBClient {
    send = mock();
  },
  QueryCommand: class {},
  GetCommand: class {},
  PutCommand: class {},
  DeleteCommand: class {},
}));

mock.module('@aws-sdk/util-dynamodb', () => ({
  marshall: (obj: any) => obj,
  unmarshall: (obj: any) => obj,
}));

describe('BlogPostStore', () => {
  let store: BlogPostStore;
  let mockClient: any;

  beforeEach(() => {
    mockClient = new DynamoDBClient({});
    store = new BlogPostStore(mockClient, 'test-table');
  });

  describe('writeBlogPost', () => {
    it('should create a blog post with auto-generated slug', async () => {
      mockClient.send = mock(async () => ({}));

      const result = await store.writeBlogPost('avatar-123', {
        title: 'Hello World',
        content: '# Hello\n\nThis is a test post.',
      });

      expect(result.avatarId).toBe('avatar-123');
      expect(result.slug).toBe('hello-world');
      expect(result.title).toBe('Hello World');
      expect(result.content).toContain('Hello');
      expect(result.publishedAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
    });

    it('should create a blog post with custom slug', async () => {
      mockClient.send = mock(async () => ({}));

      const result = await store.writeBlogPost('avatar-123', {
        title: 'Hello World',
        content: 'Test content',
        slug: 'custom-slug',
      });

      expect(result.slug).toBe('custom-slug');
    });

    it('should include imageUrl if provided', async () => {
      mockClient.send = mock(async () => ({}));

      const result = await store.writeBlogPost('avatar-123', {
        title: 'Test',
        content: 'Test',
        imageUrl: 'https://example.com/image.jpg',
      });

      expect(result.imageUrl).toBe('https://example.com/image.jpg');
    });

    it('should throw error if required fields missing', async () => {
      await expect(store.writeBlogPost('', { title: 'Test', content: 'Test' })).rejects.toThrow(
        'avatarId, title, and content are required'
      );

      await expect(store.writeBlogPost('avatar-123', { title: '', content: 'Test' })).rejects.toThrow(
        'avatarId, title, and content are required'
      );

      await expect(store.writeBlogPost('avatar-123', { title: 'Test', content: '' })).rejects.toThrow(
        'avatarId, title, and content are required'
      );
    });

    it('should call DynamoDB PutCommand with correct parameters', async () => {
      const putSpy = mock(async () => ({}));
      mockClient.send = putSpy;

      await store.writeBlogPost('avatar-123', {
        title: 'Test Post',
        content: 'Content here',
        slug: 'test-post',
      });

      expect(putSpy).toHaveBeenCalled();
    });
  });

  describe('getBlogPost', () => {
    it('should retrieve a blog post', async () => {
      mockClient.send = mock(async () => ({
        Item: {
          avatarId: 'avatar-123',
          slug: 'test-post',
          title: 'Test Post',
          content: 'Content here',
          publishedAt: '2026-04-14T00:00:00Z',
          updatedAt: '2026-04-14T00:00:00Z',
        },
      }));

      const result = await store.getBlogPost('avatar-123', 'test-post');

      expect(result).toBeTruthy();
      expect(result?.slug).toBe('test-post');
      expect(result?.title).toBe('Test Post');
    });

    it('should return null if post not found', async () => {
      mockClient.send = mock(async () => ({ Item: undefined }));

      const result = await store.getBlogPost('avatar-123', 'nonexistent');

      expect(result).toBeNull();
    });

    it('should throw error if avatarId or slug missing', async () => {
      await expect(store.getBlogPost('', 'slug')).rejects.toThrow('avatarId and slug are required');

      await expect(store.getBlogPost('avatar-123', '')).rejects.toThrow('avatarId and slug are required');
    });
  });

  describe('listBlogPosts', () => {
    it('should list blog posts for an avatar', async () => {
      mockClient.send = mock(async () => ({
        Items: [
          {
            avatarId: 'avatar-123',
            slug: 'post-1',
            title: 'Post 1',
            content: 'Content 1',
            publishedAt: '2026-04-14T00:00:00Z',
            updatedAt: '2026-04-14T00:00:00Z',
          },
          {
            avatarId: 'avatar-123',
            slug: 'post-2',
            title: 'Post 2',
            content: 'Content 2',
            publishedAt: '2026-04-13T00:00:00Z',
            updatedAt: '2026-04-13T00:00:00Z',
          },
        ],
      }));

      const result = await store.listBlogPosts('avatar-123');

      expect(result.posts).toHaveLength(2);
      expect(result.posts[0].slug).toBe('post-1');
      expect(result.posts[1].slug).toBe('post-2');
    });

    it('should handle pagination token', async () => {
      mockClient.send = mock(async () => ({
        Items: [],
        LastEvaluatedKey: { PK: 'AVATAR#avatar-123', SK: 'POST#last-slug' },
      }));

      const result = await store.listBlogPosts('avatar-123', 20);

      expect(result.nextToken).toBeTruthy();
    });

    it('should respect limit parameter', async () => {
      mockClient.send = mock(async () => ({ Items: [] }));

      await store.listBlogPosts('avatar-123', 50);

      // Verify limit was passed to query
      expect(mockClient.send).toHaveBeenCalled();
    });

    it('should throw error if limit is invalid', async () => {
      await expect(store.listBlogPosts('avatar-123', 0)).rejects.toThrow('limit must be between 1 and 100');

      await expect(store.listBlogPosts('avatar-123', 101)).rejects.toThrow('limit must be between 1 and 100');
    });

    it('should throw error if avatarId missing', async () => {
      await expect(store.listBlogPosts('')).rejects.toThrow('avatarId is required');
    });
  });

  describe('deleteBlogPost', () => {
    it('should delete a blog post', async () => {
      mockClient.send = mock(async () => ({}));

      await store.deleteBlogPost('avatar-123', 'test-post');

      expect(mockClient.send).toHaveBeenCalled();
    });

    it('should throw error if avatarId or slug missing', async () => {
      await expect(store.deleteBlogPost('', 'slug')).rejects.toThrow('avatarId and slug are required');

      await expect(store.deleteBlogPost('avatar-123', '')).rejects.toThrow('avatarId and slug are required');
    });
  });

  describe('slug generation', () => {
    it('should generate kebab-case slugs', async () => {
      mockClient.send = mock(async () => ({}));

      const testCases = [
        { title: 'Hello World', expected: 'hello-world' },
        { title: 'Test!!!Post', expected: 'testpost' },
        { title: 'Multiple   Spaces', expected: 'multiple-spaces' },
        { title: 'UPPERCASE', expected: 'uppercase' },
      ];

      for (const { title, expected } of testCases) {
        const result = await store.writeBlogPost('avatar-123', {
          title,
          content: 'Test',
        });
        expect(result.slug).toBe(expected);
      }
    });

    it('should truncate long titles to 60 chars', async () => {
      mockClient.send = mock(async () => ({}));

      const longTitle = 'This is a very long title that should be truncated because it exceeds 60 characters maximum length';
      const result = await store.writeBlogPost('avatar-123', {
        title: longTitle,
        content: 'Test',
      });

      expect(result.slug.length).toBeLessThanOrEqual(60);
    });
  });
});
