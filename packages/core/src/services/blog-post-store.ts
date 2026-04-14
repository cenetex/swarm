/**
 * Blog Post Storage Service
 *
 * Stores and retrieves blog posts in DynamoDB as a native avatar capability.
 * Schema: PK=AVATAR#{avatarId}, SK=POST#{slug}
 * Posts include markdown content and metadata for live immediate publication.
 */

import { DynamoDBClient, QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { logger } from '../utils/logger.js';

export interface BlogPost {
  avatarId: string;
  slug: string;
  title: string;
  content: string;
  imageUrl?: string;
  publishedAt: string;
  updatedAt: string;
}

export interface BlogPostInput {
  title: string;
  content: string;
  slug?: string;
  imageUrl?: string;
}

export interface ListPostsResult {
  posts: BlogPost[];
  nextToken?: string;
}

const TABLE_NAME = process.env.STATE_TABLE || 'avatar-state';
const PARTITION_KEY = 'PK';
const SORT_KEY = 'SK';

/**
 * Generate kebab-case slug from title (max 60 chars)
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Create ISO 8601 timestamp
 */
function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * BlogPostStore service for DynamoDB operations
 */
export class BlogPostStore {
  private client: DynamoDBClient;
  private tableName: string;

  constructor(client?: DynamoDBClient, tableName?: string) {
    this.client = client || new DynamoDBClient({});
    this.tableName = tableName || TABLE_NAME;
  }

  /**
   * Create or update a blog post
   */
  async writeBlogPost(avatarId: string, input: BlogPostInput): Promise<BlogPost> {
    if (!avatarId || !input.title || !input.content) {
      throw new Error('avatarId, title, and content are required');
    }

    const slug = input.slug || generateSlug(input.title);
    const now = getCurrentTimestamp();

    const blogPost: BlogPost = {
      avatarId,
      slug,
      title: input.title,
      content: input.content,
      imageUrl: input.imageUrl,
      publishedAt: now,
      updatedAt: now,
    };

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: marshall({
            [PARTITION_KEY]: `AVATAR#${avatarId}`,
            [SORT_KEY]: `POST#${slug}`,
            title: blogPost.title,
            content: blogPost.content,
            imageUrl: blogPost.imageUrl,
            publishedAt: blogPost.publishedAt,
            updatedAt: blogPost.updatedAt,
            avatarId: blogPost.avatarId,
            slug: blogPost.slug,
            ttl: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60, // 10 year expiry
          }),
        })
      );

      logger.info('Blog post written', {
        avatarId,
        slug,
        title: blogPost.title,
      });

      return blogPost;
    } catch (error) {
      logger.error('Failed to write blog post', { error, avatarId, slug });
      throw error;
    }
  }

  /**
   * Get a single blog post by slug
   */
  async getBlogPost(avatarId: string, slug: string): Promise<BlogPost | null> {
    if (!avatarId || !slug) {
      throw new Error('avatarId and slug are required');
    }

    try {
      const response = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: marshall({
            [PARTITION_KEY]: `AVATAR#${avatarId}`,
            [SORT_KEY]: `POST#${slug}`,
          }),
        })
      );

      if (!response.Item) {
        return null;
      }

      const item = unmarshall(response.Item);
      return {
        avatarId: item.avatarId,
        slug: item.slug,
        title: item.title,
        content: item.content,
        imageUrl: item.imageUrl,
        publishedAt: item.publishedAt,
        updatedAt: item.updatedAt,
      };
    } catch (error) {
      logger.error('Failed to get blog post', { error, avatarId, slug });
      throw error;
    }
  }

  /**
   * List all posts for an avatar (most recent first), paginated
   */
  async listBlogPosts(
    avatarId: string,
    limit: number = 20,
    nextToken?: string
  ): Promise<ListPostsResult> {
    if (!avatarId) {
      throw new Error('avatarId is required');
    }

    if (limit < 1 || limit > 100) {
      throw new Error('limit must be between 1 and 100');
    }

    try {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: `${PARTITION_KEY} = :pk AND begins_with(${SORT_KEY}, :sk)`,
          ExpressionAttributeValues: marshall({
            ':pk': `AVATAR#${avatarId}`,
            ':sk': 'POST#',
          }),
          Limit: limit,
          ExclusiveStartKey: nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString()) : undefined,
          ScanIndexForward: false, // Most recent first
        })
      );

      const posts: BlogPost[] = (response.Items || []).map((item) => {
        const unmarshalled = unmarshall(item);
        return {
          avatarId: unmarshalled.avatarId,
          slug: unmarshalled.slug,
          title: unmarshalled.title,
          content: unmarshalled.content,
          imageUrl: unmarshalled.imageUrl,
          publishedAt: unmarshalled.publishedAt,
          updatedAt: unmarshalled.updatedAt,
        };
      });

      const result: ListPostsResult = { posts };

      if (response.LastEvaluatedKey) {
        result.nextToken = Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64');
      }

      return result;
    } catch (error) {
      logger.error('Failed to list blog posts', { error, avatarId });
      throw error;
    }
  }

  /**
   * Delete a blog post
   */
  async deleteBlogPost(avatarId: string, slug: string): Promise<void> {
    if (!avatarId || !slug) {
      throw new Error('avatarId and slug are required');
    }

    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: marshall({
            [PARTITION_KEY]: `AVATAR#${avatarId}`,
            [SORT_KEY]: `POST#${slug}`,
          }),
        })
      );

      logger.info('Blog post deleted', { avatarId, slug });
    } catch (error) {
      logger.error('Failed to delete blog post', { error, avatarId, slug });
      throw error;
    }
  }
}

/**
 * Factory function to create BlogPostStore
 */
export function createBlogPostStore(client?: DynamoDBClient, tableName?: string): BlogPostStore {
  return new BlogPostStore(client, tableName);
}
