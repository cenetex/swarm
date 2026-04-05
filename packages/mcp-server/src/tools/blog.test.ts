/**
 * Blog Tools Tests
 */
import { describe, it, expect, vi } from 'vitest';
import { createBlogTools } from './blog.js';

// Mock the blog posting service
vi.mock('@swarm/core', () => ({
  publishBlogPost: vi.fn(async (post) => {
    if (!post.title || !post.content || !post.author || !post.agentId) {
      return { success: false, error: 'Missing fields' };
    }
    return {
      success: true,
      url: `https://${post.agentId}.rati.chat/posts/test-post`,
      slug: 'test-post',
    };
  }),
  // Transitive exports needed when tools import services that depend on @swarm/core
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  createSqsOffloadServiceFromEnv: () => null,
  createGallerySaver: () => ({ save: () => Promise.resolve() }),
  LLMError: class LLMError extends Error { code: string; constructor(msg: string, opts?: any) { super(msg); this.code = opts?.code ?? ''; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_ADAPTER_NOT_FOUND: 'PLATFORM_ADAPTER_NOT_FOUND',
    PLATFORM_CONFIG_INVALID: 'PLATFORM_CONFIG_INVALID',
    PLATFORM_AUTH_FAILED: 'PLATFORM_AUTH_FAILED',
    PLATFORM_CONNECTION_FAILED: 'PLATFORM_CONNECTION_FAILED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_INVALID: 'PLATFORM_WEBHOOK_INVALID',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_INVALID_SCHEMA: 'LLM_INVALID_SCHEMA',
    CONFIG_MISSING_REQUIRED_FIELD: 'CONFIG_MISSING_REQUIRED_FIELD',
    CONFIG_INVALID_ENUM_VALUE: 'CONFIG_INVALID_ENUM_VALUE',
    CONFIG_NESTED_OBJECT_INVALID: 'CONFIG_NESTED_OBJECT_INVALID',
    STATE_SERIALIZATION_FAILED: 'STATE_SERIALIZATION_FAILED',
    STATE_DESERIALIZATION_FAILED: 'STATE_DESERIALIZATION_FAILED',
    MEDIA_PROVIDER_ERROR: 'MEDIA_PROVIDER_ERROR',
    MEDIA_UPLOAD_FAILED: 'MEDIA_UPLOAD_FAILED',
    MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_EXPIRED_TOKEN: 'AUTH_EXPIRED_TOKEN',
    AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_INSUFFICIENT_PERMISSIONS',
    QUEUE_SEND_FAILED: 'QUEUE_SEND_FAILED',
    QUEUE_RECEIVE_FAILED: 'QUEUE_RECEIVE_FAILED',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
    NETWORK_CONNECTION_ERROR: 'NETWORK_CONNECTION_ERROR',
  },
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

    expect(tool.description).toContain('rati.chat');
    expect(tool.toolset).toBe('github');
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
      agentId: 'test-agent',
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
      agentId: 'test-agent',
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
      agentId: 'test-agent',
      imageUrl: 'https://example.com/image.jpg',
    });

    expect(parsed.success).toBe(true);
  });
});
