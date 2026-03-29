/**
 * Blog Tools Tests
 */
import { describe, it, expect, vi } from 'vitest';
import { createBlogTools } from './blog.js';

// Mock the blog posting service
vi.mock('@swarm/core', () => ({
  publishBlogPost: vi.fn(async (post) => {
    if (!post.title || !post.content || !post.author) {
      return { success: false, error: 'Missing fields' };
    }
    return {
      success: true,
      url: 'https://github.com/cenetex/lab/commit/abc123',
      slug: 'test-post',
    };
  }),
}));

describe('Blog Tools', () => {
  it('should create blog tools', () => {
    const tools = createBlogTools({});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('publish_blog_post');
  });

  it('should have proper tool metadata', () => {
    const tools = createBlogTools({});
    const tool = tools[0];

    expect(tool.description).toContain('lab.cenetex.com');
    expect(tool.toolset).toBe('content');
    expect(tool.inputSchema).toBeDefined();
  });

  it('should validate input schema', () => {
    const tools = createBlogTools({});
    const tool = tools[0];

    // Verify schema has required fields
    const parsed = tool.inputSchema.safeParse({
      title: 'Test Post',
      content: 'This is test content',
      author: 'Test Author',
    });

    expect(parsed.success).toBe(true);
  });

  it('should reject invalid input', () => {
    const tools = createBlogTools({});
    const tool = tools[0];

    const parsed = tool.inputSchema.safeParse({
      title: '',
      content: 'Content',
      author: 'Author',
    });

    expect(parsed.success).toBe(false);
  });

  it('should handle optional image URL', () => {
    const tools = createBlogTools({});
    const tool = tools[0];

    const parsed = tool.inputSchema.safeParse({
      title: 'Test',
      content: 'Content',
      author: 'Author',
      imageUrl: 'https://example.com/image.jpg',
    });

    expect(parsed.success).toBe(true);
  });
});
