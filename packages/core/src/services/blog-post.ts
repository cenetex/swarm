/**
 * Blog Posting Service
 *
 * Enables agents to publish blog posts to cenetex/agent-blogs repository
 * via GitHub API with markdown + YAML frontmatter support.
 * Posts are organized by agent ID with per-agent blogs at {agent-id}.rati.chat
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BlogPostContent {
  title: string;
  content: string;
  author: string;
  agentId: string;
  imageUrl?: string;
}

export interface BlogPostResult {
  success: boolean;
  url?: string;
  slug?: string;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_URL = 'https://api.github.com';
const TARGET_REPO = 'cenetex/agent-blogs';
const POSTS_PATH = 'posts';
const IMAGES_PATH = 'posts/{agentId}/images';
const GITHUB_TOKEN_SECRET = '/lab-cenetex/GITHUB_TOKEN';

// Token cache with TTL
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Utility Functions
// ============================================================================

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
 * Get GitHub token from Secrets Manager with caching
 */
async function getGitHubToken(): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(GITHUB_TOKEN_SECRET);

  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const secretsClient = new SecretsManagerClient({});

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: GITHUB_TOKEN_SECRET,
    }));

    const token = response.SecretString || '';
    if (!token) {
      throw new Error('GitHub token is empty');
    }

    tokenCache.set(GITHUB_TOKEN_SECRET, {
      token,
      expiresAt: now + TOKEN_CACHE_TTL,
    });

    return token;
  } catch (error) {
    logger.error('Failed to retrieve GitHub token', error, {
      subsystem: 'blog-post',
      secret: GITHUB_TOKEN_SECRET,
    });
    throw new Error('Unable to retrieve GitHub authentication token');
  }
}

/**
 * Generate markdown with YAML frontmatter
 */
function generateMarkdown(post: BlogPostContent & { date: string; image?: string }): string {
  let frontmatter = `---
title: "${post.title.replace(/"/g, '\\"')}"
date: "${post.date}"
author: "${post.author.replace(/"/g, '\\"')}"
agentId: "${post.agentId.replace(/"/g, '\\"')}"`;

  if (post.image) {
    frontmatter += `\nimage: "${post.image}"`;
  }

  frontmatter += '\n---\n\n';

  return frontmatter + post.content;
}

/**
 * Download image and convert to base64
 */
async function downloadImageAsBase64(imageUrl: string): Promise<{ data: string; filename: string }> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Extract filename from URL or generate one
    const urlObj = new URL(imageUrl);
    let filename = urlObj.pathname.split('/').pop() || 'image.jpg';

    // Ensure it has an appropriate extension
    if (!filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      filename += '.jpg';
    }

    return { data: base64, filename };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Unable to download image: ${errorMessage}`);
  }
}

/**
 * Commit a file to GitHub via API (PUT /repos/{owner}/{repo}/contents/{path})
 */
async function commitFileToGitHub(
  token: string,
  path: string,
  content: string | Buffer,
  message: string
): Promise<{ url: string; sha: string }> {
  const isBase64 = Buffer.isBuffer(content);
  const encodedContent = isBase64
    ? (content as Buffer).toString('base64')
    : Buffer.from(content as string).toString('base64');

  const url = `${GITHUB_API_URL}/repos/${TARGET_REPO}/contents/${path}`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: encodedContent,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    const data = await response.json() as { html_url?: string; content?: { sha?: string } };
    const htmlUrl = data.html_url || (data.content as any)?.html_url || '';
    const sha = (data.content as any)?.sha || '';

    return { url: htmlUrl, sha };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to commit to GitHub: ${errorMessage}`);
  }
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Publish a blog post to cenetex/agent-blogs
 *
 * @param post Blog post content (title, content, author, agentId, optional imageUrl)
 * @returns Result with post URL at {agentId}.rati.chat or error
 */
export async function publishBlogPost(post: BlogPostContent): Promise<BlogPostResult> {
  try {
    // Validate input
    if (!post.title || !post.content || !post.author || !post.agentId) {
      return {
        success: false,
        error: 'Missing required fields: title, content, author, agentId',
      };
    }

    // Generate slug and paths
    const slug = generateSlug(post.title);
    const postPath = `${POSTS_PATH}/${post.agentId}/${slug}.md`;
    const timestamp = getCurrentTimestamp();

    logger.debug('Publishing blog post', {
      subsystem: 'blog-post',
      title: post.title,
      slug,
      author: post.author,
      agentId: post.agentId,
      hasImage: !!post.imageUrl,
    });

    // Get GitHub token
    const token = await getGitHubToken();

    // Handle image upload if provided
    let imagePath: string | undefined;
    if (post.imageUrl) {
      try {
        const imageData = await downloadImageAsBase64(post.imageUrl);
        const agentImagesPath = IMAGES_PATH.replace('{agentId}', post.agentId);
        imagePath = `${agentImagesPath}/${imageData.filename}`;

        logger.debug('Uploading image', {
          subsystem: 'blog-post',
          path: imagePath,
        });

        await commitFileToGitHub(
          token,
          imagePath,
          Buffer.from(imageData.data, 'base64'),
          `Blog post image: ${slug}`
        );
      } catch (error) {
        logger.warn('Image upload failed (continuing without image)', {
          subsystem: 'blog-post',
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue without image rather than failing the entire post
      }
    }

    // Generate markdown content
    const markdownContent = generateMarkdown({
      ...post,
      date: timestamp,
      image: imagePath ? `/${imagePath}` : undefined,
    });

    // Commit post to GitHub
    await commitFileToGitHub(
      token,
      postPath,
      markdownContent,
      `feat(blog): publish "${post.title}" by ${post.author}`
    );

    // Generate per-agent blog URL
    const postUrl = `https://${post.agentId}.rati.chat/posts/${slug}`;

    logger.info('Blog post published successfully', {
      subsystem: 'blog-post',
      slug,
      url: postUrl,
      author: post.author,
      agentId: post.agentId,
    });

    return {
      success: true,
      url: postUrl,
      slug,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to publish blog post', {
      subsystem: 'blog-post',
      title: post.title,
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}
