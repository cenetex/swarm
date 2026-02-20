import { describe, test, expect, spyOn } from 'bun:test';
import { buildMediaUrl, canonicalizeMediaUrl, canonicalizeMediaUrls } from './media-url.js';

describe('buildMediaUrl', () => {
  test('returns CDN URL when cdnUrl is provided', () => {
    const result = buildMediaUrl(
      'avatars/abc/images/123.png',
      'swarm-media-staging-022118847419',
      'https://dodxbiygmi95j.cloudfront.net',
    );
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/images/123.png');
  });

  test('falls back to raw S3 URL when cdnUrl is undefined', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildMediaUrl(
      'avatars/abc/images/123.png',
      'swarm-media-staging-022118847419',
      undefined,
    );
    expect(result).toBe('https://swarm-media-staging-022118847419.s3.amazonaws.com/avatars/abc/images/123.png');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('falls back to raw S3 URL when cdnUrl is empty string', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildMediaUrl(
      'avatars/abc/images/123.png',
      'swarm-media-prod-332730082708',
      '', // empty string is falsy
    );
    expect(result).toBe('https://swarm-media-prod-332730082708.s3.amazonaws.com/avatars/abc/images/123.png');
    warnSpy.mockRestore();
  });
});

describe('canonicalizeMediaUrl', () => {
  const CDN = 'https://dodxbiygmi95j.cloudfront.net';

  test('rewrites virtual-hosted S3 URL to CDN URL', () => {
    const input = 'https://swarm-media-staging-022118847419.s3.amazonaws.com/avatars/abc/images/123.png';
    const result = canonicalizeMediaUrl(input, CDN);
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/images/123.png');
  });

  test('rewrites S3 URL with region to CDN URL', () => {
    const input = 'https://swarm-media-prod-332730082708.s3.us-east-1.amazonaws.com/avatars/abc/images/123.png';
    const result = canonicalizeMediaUrl(input, CDN);
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/images/123.png');
  });

  test('returns external URL unchanged', () => {
    const input = 'https://replicate.delivery/pbxt/123/output.png';
    expect(canonicalizeMediaUrl(input, CDN)).toBe(input);
  });

  test('returns CDN URL unchanged (no double-rewrite)', () => {
    const input = 'https://dodxbiygmi95j.cloudfront.net/avatars/abc/images/123.png';
    expect(canonicalizeMediaUrl(input, CDN)).toBe(input);
  });

  test('returns original URL when cdnUrl is undefined', () => {
    const input = 'https://swarm-media-staging-022118847419.s3.amazonaws.com/avatars/abc/images/123.png';
    expect(canonicalizeMediaUrl(input, undefined)).toBe(input);
  });

  test('preserves URL-encoded keys', () => {
    const input = 'https://bucket.s3.amazonaws.com/avatars/abc/images/my%20image.png';
    const result = canonicalizeMediaUrl(input, CDN);
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/images/my%20image.png');
  });

  test('handles sticker paths', () => {
    const input = 'https://bucket.s3.amazonaws.com/avatars/abc/stickers/xyz.webp';
    const result = canonicalizeMediaUrl(input, CDN);
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/stickers/xyz.webp');
  });

  test('handles audio paths', () => {
    const input = 'https://bucket.s3.amazonaws.com/avatars/abc/audio/voice.ogg';
    const result = canonicalizeMediaUrl(input, CDN);
    expect(result).toBe('https://dodxbiygmi95j.cloudfront.net/avatars/abc/audio/voice.ogg');
  });
});

describe('canonicalizeMediaUrls (batch)', () => {
  const CDN = 'https://d1234.cloudfront.net';

  test('rewrites all S3 URLs in array', () => {
    const urls = [
      'https://bucket.s3.amazonaws.com/a.png',
      'https://bucket.s3.amazonaws.com/b.png',
      'https://external.com/c.png',
    ];
    const result = canonicalizeMediaUrls(urls, CDN);
    expect(result).toEqual([
      'https://d1234.cloudfront.net/a.png',
      'https://d1234.cloudfront.net/b.png',
      'https://external.com/c.png',
    ]);
  });

  test('returns original array when cdnUrl is undefined', () => {
    const urls = [
      'https://bucket.s3.amazonaws.com/a.png',
      'https://bucket.s3.amazonaws.com/b.png',
    ];
    expect(canonicalizeMediaUrls(urls, undefined)).toEqual(urls);
  });

  test('handles empty array', () => {
    expect(canonicalizeMediaUrls([], CDN)).toEqual([]);
  });
});
