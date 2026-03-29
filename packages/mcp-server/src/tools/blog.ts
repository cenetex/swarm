/**
 * Blog Posting Tools
 *
 * Allows agents to publish blog posts to lab.cenetex.com
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';
import { publishBlogPost } from '@swarm/core';

// ============================================================================
// Service Interface
// ============================================================================

export interface BlogServices {
  // publishBlogPost is imported directly from core
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createBlogTools = (_services: BlogServices) => [
  defineTool({
    name: 'publish_blog_post',
    description: `Publish a blog post to lab.cenetex.com. The post will be committed to the cenetex/lab repository and published after Amplify rebuilds the site.`,
    toolset: 'github',
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Blog post title'),
      content: z.string().min(1).describe('Blog post content in markdown format'),
      author: z.string().min(1).max(100).describe('Author name for the blog post'),
      imageUrl: z.string().url().optional().describe('Optional image URL to include with the post'),
    }),
    execute: async (input): Promise<ToolResult> => {
      try {
        const result = await publishBlogPost({
          title: input.title,
          content: input.content,
          author: input.author,
          imageUrl: input.imageUrl,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to publish blog post',
          };
        }

        return {
          success: true,
          data: {
            message: `Blog post "${input.title}" published successfully`,
            url: result.url,
            slug: result.slug,
            author: input.author,
            hasImage: !!input.imageUrl,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to publish blog post',
        };
      }
    },
  }),
];

export default createBlogTools;
