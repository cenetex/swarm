/**
 * Blog Posts API Handlers
 * Routes for listing and retrieving published blog posts from DynamoDB
 * Public endpoints, no authentication required
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createBlogPostStore } from '@cenetex/core/services';
import { logger } from '@cenetex/core/utils/logger';

// CORS headers for public API
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

/**
 * List all blog posts for an avatar
 * GET /api/profile/{avatarId}/posts
 * Query params: limit (1-100, default 20), nextToken (pagination)
 */
export const listBlogPosts = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  logger.info('Received request to list blog posts', {
    path: event.rawPath,
    method: event.requestContext.http.method,
  });

  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
    };
  }

  try {
    // Extract avatar ID from path: /api/profile/{avatarId}/posts
    const pathParts = event.rawPath.split('/');
    const avatarIdIndex = pathParts.indexOf('profile') + 1;
    const avatarId = pathParts[avatarIdIndex];

    if (!avatarId || !avatarId.match(/^[a-zA-Z0-9_-]+$/)) {
      logger.warn('Invalid avatar ID', { avatarId });
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid avatar ID' }),
      };
    }

    // Parse query parameters
    const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit || '20') || 20, 1), 100);
    const nextToken = event.queryStringParameters?.nextToken;

    // Retrieve posts from DynamoDB
    const store = createBlogPostStore();
    const result = await store.listBlogPosts(avatarId, limit, nextToken);

    logger.info('Successfully listed blog posts', {
      avatarId,
      count: result.posts.length,
      hasMore: !!result.nextToken,
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        posts: result.posts,
        nextToken: result.nextToken,
      }),
    };
  } catch (error) {
    logger.error('Failed to list blog posts', { error });
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

/**
 * Get a single blog post by slug
 * GET /api/profile/{avatarId}/posts/{slug}
 */
export const getBlogPost = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  logger.info('Received request to get blog post', {
    path: event.rawPath,
    method: event.requestContext.http.method,
  });

  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
    };
  }

  try {
    // Extract avatar ID and slug from path: /api/profile/{avatarId}/posts/{slug}
    const pathParts = event.rawPath.split('/');
    const avatarIdIndex = pathParts.indexOf('profile') + 1;
    const avatarId = pathParts[avatarIdIndex];
    const slug = pathParts[avatarIdIndex + 2]; // posts is at +2

    if (!avatarId || !slug) {
      logger.warn('Missing avatar ID or slug', { avatarId, slug });
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing avatar ID or slug' }),
      };
    }

    if (!avatarId.match(/^[a-zA-Z0-9_-]+/) || !slug.match(/^[a-z0-9-]+$/)) {
      logger.warn('Invalid avatar ID or slug format', { avatarId, slug });
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid avatar ID or slug format' }),
      };
    }

    // Retrieve post from DynamoDB
    const store = createBlogPostStore();
    const post = await store.getBlogPost(avatarId, slug);

    if (!post) {
      logger.info('Blog post not found', { avatarId, slug });
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Post not found' }),
      };
    }

    logger.info('Successfully retrieved blog post', {
      avatarId,
      slug,
      title: post.title,
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(post),
    };
  } catch (error) {
    logger.error('Failed to get blog post', { error });
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
