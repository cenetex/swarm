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
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  createSqsOffloadServiceFromEnv: () => null,
  createCircuitBreaker: () => ({ canExecute: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed' }),
  LLMError: class LLMError extends Error { constructor(message: string) { super(message); this.name = 'LLMError'; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_NOT_INITIALIZED: 'PLATFORM_NOT_INITIALIZED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_ERROR: 'PLATFORM_WEBHOOK_ERROR',
    PLATFORM_MEDIA_UPLOAD_ERROR: 'PLATFORM_MEDIA_UPLOAD_ERROR',
    PLATFORM_UNSUPPORTED_MEDIA: 'PLATFORM_UNSUPPORTED_MEDIA',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_VALIDATION_ERROR: 'CONFIG_VALIDATION_ERROR',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    STATE_READ_ERROR: 'STATE_READ_ERROR',
    STATE_WRITE_ERROR: 'STATE_WRITE_ERROR',
    MEDIA_GENERATION_ERROR: 'MEDIA_GENERATION_ERROR',
    MEDIA_FETCH_ERROR: 'MEDIA_FETCH_ERROR',
    MEDIA_LIMIT_REACHED: 'MEDIA_LIMIT_REACHED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
    AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
    QUEUE_SEND_ERROR: 'QUEUE_SEND_ERROR',
    QUEUE_PARSE_ERROR: 'QUEUE_PARSE_ERROR',
    NETWORK_FETCH_ERROR: 'NETWORK_FETCH_ERROR',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
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
