/**
 * Substack Publisher Adapter
 *
 * Enables publishing blog posts to Substack with cross-posting support.
 * Handles session management, draft creation, scheduling, and publishing.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface SubstackCredentials {
  email: string;
  password: string;
  sessionCookie?: string;
  sessionExpiresAt?: number;
}

export interface SubstackPublishConfig {
  subdomain: string; // e.g., "myagent" for myagent.substack.com
  sendEmail?: boolean; // Whether to email subscribers (default: false)
  publishImmediately?: boolean; // Default: true
}

export interface SubstackPostContent {
  title: string;
  content: string; // HTML content
  subtitle?: string;
  imageUrl?: string; // Featured image URL
  scheduledFor?: Date; // Optional publish timestamp
}

export interface SubstackPublishResult {
  success: boolean;
  postId?: string;
  url?: string;
  status?: 'draft' | 'scheduled' | 'published';
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const SUBSTACK_API_BASE = 'https://substack.com/api/v1';
const SESSION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_DELAY_MS = 500; // Respect Cloudflare rate limiting

// Session cache: { subdomain: { credentials, expiresAt } }
const sessionCache = new Map<string, { credentials: SubstackCredentials; expiresAt: number }>();

// Request timing to avoid rate limits
let lastRequestTime = 0;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Respectful delay between API calls to avoid rate limiting
 */
async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < REQUEST_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

/**
 * Retry with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Don't retry on auth failures
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
        throw error;
      }

      if (attempt < RETRY_ATTEMPTS) {
        const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`${operationName} attempt ${attempt} failed, retrying in ${delayMs}ms`, {
          subsystem: 'substack-publisher',
          attempt,
          error: errorMsg,
        });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

/**
 * Get Substack credentials from AWS Secrets Manager
 */
async function getSubstackCredentials(subdomain: string): Promise<SubstackCredentials> {
  const secretName = `/aws-swarm/SUBSTACK_CREDENTIALS_${subdomain.toUpperCase()}`;
  const now = Date.now();

  // Check cache first
  const cached = sessionCache.get(subdomain);
  if (cached && cached.expiresAt > now) {
    logger.debug('Using cached Substack session', {
      subsystem: 'substack-publisher',
      subdomain,
    });
    return cached.credentials;
  }

  const secretsClient = new SecretsManagerClient({});

  try {
    logger.debug('Fetching Substack credentials from Secrets Manager', {
      subsystem: 'substack-publisher',
      secretName,
    });

    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretName,
    }));

    const secretString = response.SecretString;
    if (!secretString) {
      throw new Error('Substack credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as SubstackCredentials;

    // Validate required fields
    if (!credentials.email || !credentials.password) {
      throw new Error('Substack credentials must include email and password');
    }

    return credentials;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to retrieve Substack credentials', {
      subsystem: 'substack-publisher',
      secretName,
      error: errorMsg,
    });
    throw new Error(`Unable to retrieve Substack credentials for ${subdomain}: ${errorMsg}`);
  }
}

/**
 * Login to Substack and get session cookie
 */
async function loginToSubstack(credentials: SubstackCredentials): Promise<string> {
  await respectRateLimit();

  return withRetry(async () => {
    const response = await fetch(`${SUBSTACK_API_BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'aws-swarm-agent/1.0',
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Substack login failed: ${response.status} ${body.slice(0, 200)}`);
    }

    // Extract session cookie from Set-Cookie header
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('No session cookie returned from Substack login');
    }

    // Parse cookie value (format: session=value; Path=/; ...)
    const cookieMatch = setCookie.match(/session=([^;]+)/);
    if (!cookieMatch) {
      throw new Error('Could not parse session cookie from Substack response');
    }

    const sessionCookie = cookieMatch[1];
    logger.info('Successfully authenticated with Substack', {
      subsystem: 'substack-publisher',
      email: credentials.email,
    });

    return sessionCookie;
  }, 'Substack login');
}

/**
 * Get or refresh Substack session
 */
async function getSubstackSession(subdomain: string): Promise<string> {
  const credentials = await getSubstackCredentials(subdomain);
  const now = Date.now();

  // Check if cached session is still valid
  if (credentials.sessionCookie && credentials.sessionExpiresAt && credentials.sessionExpiresAt > now) {
    logger.debug('Using cached Substack session cookie', {
      subsystem: 'substack-publisher',
      subdomain,
    });
    return credentials.sessionCookie;
  }

  // Get new session
  const sessionCookie = await loginToSubstack(credentials);

  // Update cache with new session
  credentials.sessionCookie = sessionCookie;
  credentials.sessionExpiresAt = now + SESSION_CACHE_TTL;
  sessionCache.set(subdomain, {
    credentials,
    expiresAt: now + SESSION_CACHE_TTL,
  });

  return sessionCookie;
}

/**
 * Upload image to Substack
 */
async function uploadImageToSubstack(
  imageUrl: string,
  sessionCookie: string,
  subdomain: string
): Promise<string> {
  await respectRateLimit();

  return withRetry(async () => {
    // Download image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image: ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageBlob = new Blob([imageBuffer], {
      type: imageResponse.headers.get('content-type') || 'image/jpeg',
    });

    // Create form data
    const formData = new FormData();
    formData.append('file', imageBlob, 'image.jpg');

    const uploadResponse = await fetch(`${SUBSTACK_API_BASE}/images`, {
      method: 'POST',
      headers: {
        'Cookie': `session=${sessionCookie}`,
        'User-Agent': 'aws-swarm-agent/1.0',
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      if (uploadResponse.status === 401 || uploadResponse.status === 403) {
        throw new Error('Session expired, need re-authentication');
      }
      const body = await uploadResponse.text();
      throw new Error(`Image upload failed: ${uploadResponse.status} ${body.slice(0, 200)}`);
    }

    const data = await uploadResponse.json() as { url?: string };
    if (!data.url) {
      throw new Error('No image URL returned from Substack');
    }

    logger.debug('Image uploaded to Substack', {
      subsystem: 'substack-publisher',
      subdomain,
      imageUrl: data.url,
    });

    return data.url;
  }, `Image upload for ${subdomain}`);
}

/**
 * Create a draft post on Substack
 */
async function createDraftPost(
  post: SubstackPostContent,
  sessionCookie: string,
  subdomain: string
): Promise<{ id: string; url: string }> {
  await respectRateLimit();

  return withRetry(async () => {
    const draftPayload: Record<string, unknown> = {
      title: post.title,
      subtitle: post.subtitle || '',
      body_html: post.content,
    };

    if (post.imageUrl) {
      try {
        const uploadedImageUrl = await uploadImageToSubstack(post.imageUrl, sessionCookie, subdomain);
        draftPayload.image_url = uploadedImageUrl;
      } catch (error) {
        logger.warn('Failed to upload featured image, continuing without it', {
          subsystem: 'substack-publisher',
          subdomain,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue without image
      }
    }

    const response = await fetch(`${SUBSTACK_API_BASE}/drafts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${sessionCookie}`,
        'User-Agent': 'aws-swarm-agent/1.0',
      },
      body: JSON.stringify(draftPayload),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Session expired, need re-authentication');
      }
      const body = await response.text();
      throw new Error(`Draft creation failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json() as { id?: string };
    if (!data.id) {
      throw new Error('No post ID returned from Substack');
    }

    const postUrl = `https://${subdomain}.substack.com/p/${data.id}`;
    logger.debug('Draft post created', {
      subsystem: 'substack-publisher',
      subdomain,
      postId: data.id,
    });

    return { id: data.id, url: postUrl };
  }, `Draft creation for ${subdomain}`);
}

/**
 * Publish a draft on Substack
 */
async function publishSubstackDraft(
  postId: string,
  sessionCookie: string,
  subdomain: string,
  config: SubstackPublishConfig
): Promise<{ url: string; status: 'draft' | 'scheduled' | 'published' }> {
  await respectRateLimit();

  return withRetry(async () => {
    const publishPayload: Record<string, unknown> = {
      publish_now: config.publishImmediately !== false,
      send_email: config.sendEmail || false,
    };

    // Add scheduled publish time if provided
    if (!config.publishImmediately) {
      publishPayload.publish_now = false;
      // publish_at would be set by caller if scheduling is needed
    }

    const response = await fetch(`${SUBSTACK_API_BASE}/drafts/${postId}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${sessionCookie}`,
        'User-Agent': 'aws-swarm-agent/1.0',
      },
      body: JSON.stringify(publishPayload),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Session expired, need re-authentication');
      }
      const body = await response.text();
      throw new Error(`Publish failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const postUrl = `https://${subdomain}.substack.com/p/${postId}`;
    const status = config.publishImmediately !== false ? 'published' : 'scheduled';

    logger.info('Post published to Substack', {
      subsystem: 'substack-publisher',
      subdomain,
      postId,
      status,
    });

    return { url: postUrl, status };
  }, `Publish for ${subdomain}`);
}

// ============================================================================
// Main Publisher Interface
// ============================================================================

/**
 * Publish a blog post to Substack
 */
export async function publishToSubstack(
  post: SubstackPostContent,
  config: SubstackPublishConfig
): Promise<SubstackPublishResult> {
  try {
    logger.debug('Starting Substack publication', {
      subsystem: 'substack-publisher',
      subdomain: config.subdomain,
      title: post.title,
      hasImage: !!post.imageUrl,
    });

    // Get or refresh session
    const sessionCookie = await getSubstackSession(config.subdomain);

    // Create draft
    const draft = await createDraftPost(post, sessionCookie, config.subdomain);

    // Publish
    const published = await publishSubstackDraft(
      draft.id,
      sessionCookie,
      config.subdomain,
      config
    );

    return {
      success: true,
      postId: draft.id,
      url: published.url,
      status: published.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Special handling for auth errors - clear cache
    if (errorMessage.includes('Session expired') || errorMessage.includes('Unauthorized')) {
      sessionCache.delete(config.subdomain);
      logger.warn('Cleared Substack session cache due to auth error', {
        subsystem: 'substack-publisher',
        subdomain: config.subdomain,
      });
    }

    logger.error('Failed to publish to Substack', {
      subsystem: 'substack-publisher',
      subdomain: config.subdomain,
      title: post.title,
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Convert markdown content to HTML for Substack
 */
export function markdownToSubstackHtml(markdown: string): string {
  // Simple markdown to HTML conversion
  // In production, use a proper markdown parser like 'marked' or 'markdown-it'
  let html = markdown
    // Headings
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Links
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap in paragraphs
  if (!html.includes('<p>')) {
    html = `<p>${html}</p>`;
  }

  return html;
}

export default {
  publishToSubstack,
  markdownToSubstackHtml,
};
