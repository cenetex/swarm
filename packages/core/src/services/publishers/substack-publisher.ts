/**
 * Substack Publisher Adapter
 *
 * Enables publishing blog posts to Substack with cross-posting support.
 * Handles session management, draft creation, scheduling, and publishing.
 *
 * Authentication uses cookie-based auth (substack.sid, connect.sid) stored in Secrets Manager
 * instead of unreliable email/password login endpoint.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Substack credentials stored in Secrets Manager.
 * Uses cookie-based auth (substack.sid, connect.sid) instead of email/password.
 */
export interface SubstackCredentials {
  substack_sid?: string; // Required: Substack session ID cookie
  connect_sid?: string; // Required: Express connect.sid cookie
  email?: string; // Optional: for logging/reference only
  sessionCookie?: string; // Deprecated: use substack_sid instead
  sessionExpiresAt?: number;
}

export interface SubstackPublishConfig {
  subdomain: string; // e.g., "myagent" for myagent.substack.com
  sendEmail?: boolean; // Whether to email subscribers (default: false)
  publishImmediately?: boolean; // Default: true
}

export interface SubstackPostContent {
  title: string;
  content: string; // Markdown content (will be converted to ProseMirror JSON)
  subtitle?: string;
  imageUrl?: string; // Featured image URL
  scheduledFor?: Date; // Optional publish timestamp
}

export interface SubstackPublishResult {
  success: boolean;
  postId?: string;
  slug?: string; // Post slug for URL construction
  url?: string;
  status?: 'draft' | 'scheduled' | 'published';
  error?: string;
}

/**
 * ProseMirror JSON format for Substack content
 */
export interface ProseMirrorDoc {
  type: 'doc';
  content: ProseMirrorNode[];
  attrs: {
    schemaVersion: 'v1';
  };
}

export interface ProseMirrorNode {
  type: string;
  content?: ProseMirrorNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const SUBSTACK_API_BASE = 'https://substack.com/api/v1';
const SESSION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_VALIDATION_INTERVAL = 60 * 60 * 1000; // Validate session every hour
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_DELAY_MS = 500; // Respect Cloudflare rate limiting

// Browser-like User-Agent to reduce Cloudflare friction
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Session cache: { subdomain: { credentials, expiresAt, lastValidatedAt } }
const sessionCache = new Map<string, {
  credentials: SubstackCredentials;
  expiresAt: number;
  lastValidatedAt: number;
}>();

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
 * Detect Cloudflare WAF challenge response
 */
function isCloudflareChallenge(html: string): boolean {
  return (
    html.includes('Cloudflare') ||
    html.includes('cf_challenge') ||
    html.includes('ray=') ||
    html.includes('jschl_')
  );
}

/**
 * Retry with exponential backoff, with re-auth on 401/403
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  subdomainForReauth?: string
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for auth errors (401/403)
      const isAuth401Or403 = errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('Unauthorized');
      if (isAuth401Or403) {
        // On first 401/403, clear cache and retry once
        if (attempt === 1 && subdomainForReauth) {
          logger.warn(`Session expired (${errorMsg}), clearing cache and retrying`, {
            subsystem: 'substack-publisher',
            subdomain: subdomainForReauth,
            attempt,
          });
          sessionCache.delete(subdomainForReauth);

          // Continue to next attempt to retry with fresh auth
          const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }

        // On second auth failure, give up
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
 * Credentials should include cookie-based auth (substack_sid, connect_sid)
 */
async function getSubstackCredentials(subdomain: string): Promise<SubstackCredentials> {
  const secretName = `/aws-swarm/SUBSTACK_CREDENTIALS_${subdomain.toUpperCase()}`;
  const now = Date.now();

  // Check cache first
  const cached = sessionCache.get(subdomain);
  if (cached && cached.expiresAt > now) {
    logger.debug('Using cached Substack credentials', {
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

    // Validate required cookie-based auth fields
    if (!credentials.substack_sid && !credentials.connect_sid) {
      throw new Error('Substack credentials must include substack_sid and/or connect_sid cookies');
    }

    // Cache credentials
    sessionCache.set(subdomain, {
      credentials,
      expiresAt: now + SESSION_CACHE_TTL,
      lastValidatedAt: now,
    });

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
 * Validate that cached session cookies are still alive by making a lightweight read request
 */
async function validateSubstackSession(
  credentials: SubstackCredentials,
  subdomain: string
): Promise<boolean> {
  await respectRateLimit();

  try {
    const cookieHeader = buildCookieHeader(credentials);
    const response = await fetch(`${SUBSTACK_API_BASE}/publication?subdomain=${subdomain}`, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Cookie': cookieHeader,
        'Accept': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      logger.warn('Session validation failed: auth error', {
        subsystem: 'substack-publisher',
        subdomain,
        status: response.status,
      });
      return false;
    }

    if (!response.ok) {
      logger.warn('Session validation failed: unexpected status', {
        subsystem: 'substack-publisher',
        subdomain,
        status: response.status,
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.warn('Session validation error', {
      subsystem: 'substack-publisher',
      subdomain,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Build cookie header from credentials
 */
function buildCookieHeader(credentials: SubstackCredentials): string {
  const cookies: string[] = [];
  if (credentials.substack_sid) {
    cookies.push(`substack.sid=${credentials.substack_sid}`);
  }
  if (credentials.connect_sid) {
    cookies.push(`connect.sid=${credentials.connect_sid}`);
  }
  return cookies.join('; ');
}

/**
 * Get Substack cookies from credentials, validating if necessary
 */
async function getSubstackCookies(subdomain: string): Promise<string> {
  const credentials = await getSubstackCredentials(subdomain);
  const now = Date.now();

  // Check if we need to validate the cached session
  const cached = sessionCache.get(subdomain);
  if (cached && now - cached.lastValidatedAt < SESSION_VALIDATION_INTERVAL) {
    logger.debug('Using cached Substack cookies', {
      subsystem: 'substack-publisher',
      subdomain,
    });
    return buildCookieHeader(credentials);
  }

  // Validate session is still alive
  const isValid = await validateSubstackSession(credentials, subdomain);
  if (!isValid) {
    logger.warn('Substack session validation failed, clearing cache', {
      subsystem: 'substack-publisher',
      subdomain,
    });
    sessionCache.delete(subdomain);
    throw new Error('Session validation failed');
  }

  // Update last validation time
  if (cached) {
    cached.lastValidatedAt = now;
  }

  logger.debug('Substack session validated', {
    subsystem: 'substack-publisher',
    subdomain,
  });

  return buildCookieHeader(credentials);
}

/**
 * Convert markdown to ProseMirror JSON format
 * ProseMirror is the rich-text editor format Substack expects
 */
function markdownToProseMirror(markdown: string): ProseMirrorDoc {
  const lines = markdown.split('\n');
  const content: ProseMirrorNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Headings
    const h1Match = line.match(/^# (.*?)$/);
    if (h1Match) {
      content.push({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: h1Match[1] }],
      });
      i++;
      continue;
    }

    const h2Match = line.match(/^## (.*?)$/);
    if (h2Match) {
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: h2Match[1] }],
      });
      i++;
      continue;
    }

    const h3Match = line.match(/^### (.*?)$/);
    if (h3Match) {
      content.push({
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: h3Match[1] }],
      });
      i++;
      continue;
    }

    // Bullet lists
    if (line.match(/^[-*] /)) {
      const listItems: ProseMirrorNode[] = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        const itemText = lines[i].replace(/^[-*] /, '');
        listItems.push({
          type: 'list_item',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: itemText }] }],
        });
        i++;
      }
      content.push({
        type: 'bullet_list',
        content: listItems,
      });
      continue;
    }

    // Regular paragraphs
    content.push({
      type: 'paragraph',
      content: parseInlineFormats(line),
    });
    i++;
  }

  return {
    type: 'doc',
    content,
    attrs: { schemaVersion: 'v1' },
  };
}

/**
 * Parse inline formatting (bold, italic, links) in text
 */
function parseInlineFormats(text: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];

  // Pattern: **bold**, *italic*, [link](url)
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\)/g;
  let match;
  let lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      nodes.push({
        type: 'text',
        text: text.slice(lastIndex, match.index),
      });
    }

    if (match[1]) {
      // Bold: **text**
      nodes.push({
        type: 'text',
        text: match[1],
        marks: [{ type: 'strong' }],
      });
    } else if (match[2]) {
      // Italic: *text*
      nodes.push({
        type: 'text',
        text: match[2],
        marks: [{ type: 'em' }],
      });
    } else if (match[3] && match[4]) {
      // Link: [text](url)
      nodes.push({
        type: 'text',
        text: match[3],
        marks: [{ type: 'link', attrs: { href: match[4] } }],
      });
    }

    lastIndex = pattern.lastIndex;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    nodes.push({
      type: 'text',
      text: text.slice(lastIndex),
    });
  }

  // If no nodes were created, just return plain text
  if (nodes.length === 0) {
    nodes.push({ type: 'text', text });
  }

  return nodes;
}

/**
 * Upload image to Substack
 */
async function uploadImageToSubstack(
  imageUrl: string,
  cookieHeader: string,
  subdomain: string
): Promise<string> {
  await respectRateLimit();

  return withRetry(async () => {
    logger.debug('Downloading image for upload', {
      subsystem: 'substack-publisher',
      subdomain,
      imageUrl: imageUrl.slice(0, 100),
    });

    // Download image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image: ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageBlob = new Blob([imageBuffer], {
      type: imageResponse.headers.get('content-type') || 'image/jpeg',
    });

    // Validate image size (Substack typically limits to 10MB)
    if (imageBlob.size > 10 * 1024 * 1024) {
      throw new Error(`Image too large: ${(imageBlob.size / 1024 / 1024).toFixed(2)}MB (max 10MB)`);
    }

    // Create form data
    const formData = new FormData();
    formData.append('file', imageBlob, 'image.jpg');

    const uploadResponse = await fetch(`${SUBSTACK_API_BASE}/images`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': BROWSER_USER_AGENT,
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const bodyText = await uploadResponse.text();
      if (uploadResponse.status === 401 || uploadResponse.status === 403) {
        throw new Error(`401/403: Session expired, need re-authentication (${uploadResponse.status})`);
      }
      throw new Error(`Image upload failed: ${uploadResponse.status} ${bodyText.slice(0, 200)}`);
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
  }, `Image upload for ${subdomain}`, subdomain);
}

/**
 * Validate post content
 */
export function validatePostContent(post: SubstackPostContent): string | null {
  // Check title length (Substack typically limits to 300 chars)
  if (!post.title || post.title.trim().length === 0) {
    return 'Title is required';
  }
  if (post.title.length > 300) {
    return `Title too long: ${post.title.length} chars (max 300)`;
  }

  // Check content is not empty
  if (!post.content || post.content.trim().length === 0) {
    return 'Content is required';
  }

  // Check image format if provided
  if (post.imageUrl) {
    const validFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const hasValidFormat = validFormats.some(fmt => post.imageUrl!.toLowerCase().includes(fmt));
    if (!hasValidFormat) {
      return `Image format not supported: ${post.imageUrl}`;
    }
  }

  return null;
}

/**
 * Create a draft post on Substack
 */
async function createDraftPost(
  post: SubstackPostContent,
  cookieHeader: string,
  subdomain: string
): Promise<{ id: string; slug: string; url: string }> {
  await respectRateLimit();

  return withRetry(async () => {
    // Validate content
    const validationError = validatePostContent(post);
    if (validationError) {
      throw new Error(`Content validation failed: ${validationError}`);
    }

    logger.debug('Creating draft post', {
      subsystem: 'substack-publisher',
      subdomain,
      title: post.title.slice(0, 50),
      hasImage: !!post.imageUrl,
    });

    const draftPayload: Record<string, unknown> = {
      title: post.title,
      subtitle: post.subtitle || '',
      // Use body_json (ProseMirror) instead of body_html
      body_json: markdownToProseMirror(post.content),
    };

    // Upload and add featured image if provided
    if (post.imageUrl) {
      try {
        const uploadedImageUrl = await uploadImageToSubstack(post.imageUrl, cookieHeader, subdomain);
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
        'Cookie': cookieHeader,
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json',
      },
      body: JSON.stringify(draftPayload),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      // Check for Cloudflare challenge
      if (isCloudflareChallenge(bodyText)) {
        logger.error('Cloudflare WAF challenge detected', {
          subsystem: 'substack-publisher',
          subdomain,
          status: response.status,
        });
        throw new Error('Cloudflare WAF challenge detected - please verify User-Agent and headers');
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`401/403: Session expired, need re-authentication (${response.status})`);
      }

      logger.error('Draft creation failed', {
        subsystem: 'substack-publisher',
        subdomain,
        status: response.status,
        response: bodyText.slice(0, 300),
      });

      throw new Error(`Draft creation failed: ${response.status} ${bodyText.slice(0, 200)}`);
    }

    const data = await response.json() as { id?: string; slug?: string };
    if (!data.id) {
      throw new Error('No post ID returned from Substack');
    }

    // Use slug if available, otherwise use ID for URL
    const slug = data.slug || data.id;
    const postUrl = `https://${subdomain}.substack.com/p/${slug}`;

    logger.debug('Draft post created', {
      subsystem: 'substack-publisher',
      subdomain,
      postId: data.id,
      slug,
    });

    return { id: data.id, slug, url: postUrl };
  }, `Draft creation for ${subdomain}`, subdomain);
}

/**
 * Publish a draft on Substack
 */
async function publishSubstackDraft(
  postIdOrSlug: string,
  cookieHeader: string,
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
    if (!config.publishImmediately && config.publishImmediately !== undefined) {
      publishPayload.publish_now = false;
      // publish_at would be set by caller if scheduling is needed
    }

    logger.debug('Publishing draft', {
      subsystem: 'substack-publisher',
      subdomain,
      postId: postIdOrSlug,
      publishNow: publishPayload.publish_now,
      sendEmail: publishPayload.send_email,
    });

    const response = await fetch(`${SUBSTACK_API_BASE}/drafts/${postIdOrSlug}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json',
      },
      body: JSON.stringify(publishPayload),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      // Check for Cloudflare challenge
      if (isCloudflareChallenge(bodyText)) {
        logger.error('Cloudflare WAF challenge detected', {
          subsystem: 'substack-publisher',
          subdomain,
          status: response.status,
        });
        throw new Error('Cloudflare WAF challenge detected - please verify User-Agent and headers');
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`401/403: Session expired, need re-authentication (${response.status})`);
      }

      logger.error('Publish failed', {
        subsystem: 'substack-publisher',
        subdomain,
        postId: postIdOrSlug,
        status: response.status,
        response: bodyText.slice(0, 300),
      });

      throw new Error(`Publish failed: ${response.status} ${bodyText.slice(0, 200)}`);
    }

    const postUrl = `https://${subdomain}.substack.com/p/${postIdOrSlug}`;
    const status = config.publishImmediately !== false ? 'published' : 'scheduled';

    logger.info('Post published to Substack', {
      subsystem: 'substack-publisher',
      subdomain,
      postId: postIdOrSlug,
      status,
    });

    return { url: postUrl, status };
  }, `Publish for ${subdomain}`, subdomain);
}

// ============================================================================
// Main Publisher Interface
// ============================================================================

/**
 * Publish a blog post to Substack using cookie-based auth
 */
export async function publishToSubstack(
  post: SubstackPostContent,
  config: SubstackPublishConfig
): Promise<SubstackPublishResult> {
  try {
    logger.debug('Starting Substack publication', {
      subsystem: 'substack-publisher',
      subdomain: config.subdomain,
      title: post.title.slice(0, 50),
      hasImage: !!post.imageUrl,
    });

    // Get or refresh credentials and validate session
    const cookieHeader = await getSubstackCookies(config.subdomain);

    // Create draft
    const draft = await createDraftPost(post, cookieHeader, config.subdomain);

    // Publish
    const published = await publishSubstackDraft(
      draft.slug || draft.id,
      cookieHeader,
      config.subdomain,
      config
    );

    logger.info('Substack publication successful', {
      subsystem: 'substack-publisher',
      subdomain: config.subdomain,
      postId: draft.id,
      slug: draft.slug,
      status: published.status,
    });

    return {
      success: true,
      postId: draft.id,
      slug: draft.slug,
      url: published.url,
      status: published.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Special handling for auth errors - clear cache
    if (
      errorMessage.includes('401') ||
      errorMessage.includes('403') ||
      errorMessage.includes('Session validation failed') ||
      errorMessage.includes('Unauthorized')
    ) {
      sessionCache.delete(config.subdomain);
      logger.warn('Cleared Substack session cache due to auth error', {
        subsystem: 'substack-publisher',
        subdomain: config.subdomain,
        error: errorMessage.slice(0, 100),
      });
    }

    logger.error('Failed to publish to Substack', {
      subsystem: 'substack-publisher',
      subdomain: config.subdomain,
      title: post.title.slice(0, 50),
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Convert markdown to ProseMirror JSON for Substack
 * (exported for testing and potential external use)
 */
export function markdownToSubstackProseMirror(markdown: string): ProseMirrorDoc {
  return markdownToProseMirror(markdown);
}

/**
 * @deprecated Use markdownToSubstackProseMirror instead
 * Convert markdown content to HTML (legacy, kept for backwards compatibility)
 */
export function markdownToSubstackHtml(markdown: string): string {
  // Simple markdown to HTML conversion
  // DEPRECATED: Substack expects ProseMirror JSON, not HTML
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
  markdownToSubstackProseMirror,
  markdownToSubstackHtml,
  validatePostContent,
  markdownToProseMirror,
};
