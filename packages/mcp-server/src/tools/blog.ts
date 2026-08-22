import { publishBlogPost, type PublishBlogPostOptions } from '@swarm/core';
/**
 * Blog Posting Tools
 *
 * Allows agents to publish blog posts to {agent-id}.rati.chat and cross-post to Substack
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export type BlogServices = Record<string, never>;

// ============================================================================
// Tool Definitions
// ============================================================================

export const createBlogTools = (_services: BlogServices) => [
  defineTool({
    name: 'publish_blog_post',
    description: `Publish a blog post to {agent-id}.rati.chat. The post will be committed to the cenetex/agent-blogs repository with the agent's ID in the post path, and published after the site rebuilds. Optionally cross-post to Substack.`,
    toolset: 'github',
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Blog post title'),
      content: z.string().min(1).describe('Blog post content in markdown format'),
      author: z.string().min(1).max(100).describe('Author name for the blog post'),
      agentId: z.string().min(1).max(100).describe('Agent ID for organizing posts (e.g., "chamuel")'),
      imageUrl: z.string().url().optional().describe('Optional image URL to include with the post'),
      publishToSubstack: z.boolean().optional().describe('If true, also publish to Substack (requires agent config)'),
      substackSendEmail: z.boolean().optional().describe('If publishing to Substack, whether to email subscribers (default: false)'),
    }),
    execute: async (input): Promise<ToolResult> => {
      try {
        // Build publish options
        const options: PublishBlogPostOptions | undefined = input.publishToSubstack ? {
          targets: ['github', 'substack'],
          substackConfig: {
            subdomain: input.agentId, // Use agent ID as Substack subdomain
            sendEmail: input.substackSendEmail || false,
            publishImmediately: true,
          },
        } : undefined;

        const result = await publishBlogPost({
          title: input.title,
          content: input.content,
          author: input.author,
          agentId: input.agentId,
          imageUrl: input.imageUrl,
        }, options);

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to publish blog post',
          };
        }

        // Format response with target results
        const responseData: Record<string, unknown> = {
          message: `Blog post "${input.title}" published successfully`,
          url: result.url,
          slug: result.slug,
          author: input.author,
          agentId: input.agentId,
          hasImage: !!input.imageUrl,
        };

        if (result.targets) {
          responseData.targets = result.targets.map(t => ({
            platform: t.target,
            success: t.success,
            url: t.url,
            error: t.error,
          }));
        }

        return {
          success: true,
          data: responseData,
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
