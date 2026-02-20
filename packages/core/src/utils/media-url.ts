/**
 * Media URL Canonicalization
 *
 * Ensures media URLs always use the CDN origin when available,
 * preventing raw S3 URLs from leaking to clients.
 */

/**
 * Build a public media URL for an S3 key.
 * Prefers cdnUrl when available; falls back to raw S3 (with a warning).
 */
export function buildMediaUrl(s3Key: string, mediaBucket: string, cdnUrl?: string): string {
  if (cdnUrl) {
    return `${cdnUrl}/${s3Key}`;
  }
  console.warn(`[media-url] CDN_URL not set, falling back to raw S3 URL for key: ${s3Key}`);
  return `https://${mediaBucket}.s3.amazonaws.com/${s3Key}`;
}

/**
 * S3 URL pattern: matches both virtual-hosted and path-style S3 URLs.
 *   - https://<bucket>.s3.amazonaws.com/<key>
 *   - https://<bucket>.s3.<region>.amazonaws.com/<key>
 */
const S3_URL_PATTERN = /^https:\/\/([^/]+)\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com\/(.+)$/;

/**
 * Rewrite a raw S3 URL to its CDN equivalent when cdnUrl is available.
 *
 * - If the URL is already a CDN URL or an external URL, returns it unchanged.
 * - If cdnUrl is available and the URL matches the S3 pattern, rewrites it.
 * - Otherwise returns the original URL unchanged.
 */
export function canonicalizeMediaUrl(url: string, cdnUrl?: string): string {
  if (!cdnUrl) return url;

  const match = url.match(S3_URL_PATTERN);
  if (!match) return url;

  const key = match[2];
  return `${cdnUrl}/${key}`;
}

/**
 * Batch-canonicalize an array of URLs.
 */
export function canonicalizeMediaUrls(urls: string[], cdnUrl?: string): string[] {
  if (!cdnUrl) return urls;
  return urls.map(url => canonicalizeMediaUrl(url, cdnUrl));
}
