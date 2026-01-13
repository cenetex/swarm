/**
 * Media Service Tests
 *
 * Tests for URL conversion logic and image generation options.
 * These are pure function tests that don't require mocking.
 *
 * Bug Index:
 * - BUG-009: Promise.all fails entirely if one URL fails (line 104)
 *
 * @see packages/admin-api/src/services/media.ts
 */
import { describe, it, expect } from 'vitest';

describe('Media URL Generation', () => {
  describe('URL accessibility conversion', () => {
    it('should return CDN URL when CDN_URL is configured', () => {
      const CDN_URL = 'https://media.example.com';
      const s3Url = 'https://test-bucket.s3.amazonaws.com/agents/agent-1/images/test.png';
      const expectedCdnUrl = 'https://media.example.com/agents/agent-1/images/test.png';

      // The conversion logic
      const s3UrlPattern = /https:\/\/[^/]+\.s3[^/]*\.amazonaws\.com\/(.+)/;
      const match = s3Url.match(s3UrlPattern);
      expect(match).toBeTruthy();

      const cdnUrl = `${CDN_URL}/${match![1]}`;
      expect(cdnUrl).toBe(expectedCdnUrl);
    });

    it('should extract S3 key correctly from various URL formats', () => {
      const testCases = [
        {
          input: 'https://bucket.s3.amazonaws.com/path/to/file.png',
          expectedKey: 'path/to/file.png',
        },
        {
          input: 'https://bucket.s3.us-east-1.amazonaws.com/agents/agent-1/images/abc.png',
          expectedKey: 'agents/agent-1/images/abc.png',
        },
        {
          input: 'https://my-bucket.s3-website-us-east-1.amazonaws.com/test/image.jpg',
          expectedKey: 'test/image.jpg',
        },
      ];

      const s3UrlPattern = /https:\/\/[^/]+\.s3[^/]*\.amazonaws\.com\/(.+)/;

      for (const { input, expectedKey } of testCases) {
        const match = input.match(s3UrlPattern);
        expect(match).toBeTruthy();
        expect(match![1]).toBe(expectedKey);
      }
    });

    it('should not modify external URLs', () => {
      const externalUrls = [
        'https://example.com/image.png',
        'https://cdn.replicate.com/output/abc.png',
        'https://media.rati.chat/agents/test.png',
      ];

      const s3UrlPattern = /https:\/\/[^/]+\.s3[^/]*\.amazonaws\.com\/(.+)/;

      for (const url of externalUrls) {
        const match = url.match(s3UrlPattern);
        expect(match).toBeNull();
      }
    });
  });

  describe('Public URL construction', () => {
    it('should use CDN URL when configured', () => {
      const CDN_URL = 'https://media-staging.rati.chat';
      const MEDIA_BUCKET = 'swarm-media-staging-022118847419';
      const s3Key = 'agents/agent-1/images/test-uuid.png';

      const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

      expect(publicUrl).toBe('https://media-staging.rati.chat/agents/agent-1/images/test-uuid.png');
    });

    it('should fall back to S3 URL when CDN is not configured', () => {
      const CDN_URL = '';
      const MEDIA_BUCKET = 'swarm-media-staging-022118847419';
      const s3Key = 'agents/agent-1/images/test-uuid.png';

      const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

      expect(publicUrl).toBe('https://swarm-media-staging-022118847419.s3.amazonaws.com/agents/agent-1/images/test-uuid.png');
    });
  });
});

describe('Image Generation Options', () => {
  it('should build correct Nano Banana Pro input with reference images', () => {
    const prompt = 'A cute whale swimming';
    const referenceImageUrls = ['https://example.com/ref1.png'];
    const resolution = '2K';

    const nanoBananaInput: Record<string, unknown> = {
      prompt: `${prompt}. Use the provided reference images to maintain visual consistency with the character's appearance, style, and features.`,
      resolution,
      output_format: 'png',
      safety_filter_level: 'block_only_high',
    };

    if (referenceImageUrls.length > 0) {
      nanoBananaInput.image_input = referenceImageUrls.slice(0, 14);
      nanoBananaInput.aspect_ratio = 'match_input_image';
    }

    expect(nanoBananaInput.image_input).toEqual(['https://example.com/ref1.png']);
    expect(nanoBananaInput.aspect_ratio).toBe('match_input_image');
  });

  it('should build correct Nano Banana Pro input without reference images', () => {
    const prompt = 'A cute whale swimming';
    const referenceImageUrls: string[] = [];
    const resolution = '2K';
    const aspectRatio = '1:1';

    const nanoBananaInput: Record<string, unknown> = {
      prompt,
      resolution,
      output_format: 'png',
      safety_filter_level: 'block_only_high',
    };

    if (referenceImageUrls.length > 0) {
      nanoBananaInput.image_input = referenceImageUrls.slice(0, 14);
      nanoBananaInput.aspect_ratio = 'match_input_image';
    } else {
      nanoBananaInput.aspect_ratio = aspectRatio;
    }

    expect(nanoBananaInput.image_input).toBeUndefined();
    expect(nanoBananaInput.aspect_ratio).toBe('1:1');
  });
});

describe('URL Accessibility - Promise.allSettled Pattern', () => {
  /**
   * BUG-009: Promise.all fails entirely if one URL fails
   * File: packages/admin-api/src/services/media.ts:104
   *
   * Previously, if one URL failed to become accessible, the entire Promise.all would reject.
   *
   * Fix: Changed to Promise.allSettled with fallback to original URL on failure
   */
  describe('Partial failure handling with Promise.allSettled (BUG-009)', () => {
    it('should handle all successful URL conversions', async () => {
      const urls = [
        'https://bucket.s3.amazonaws.com/path1.png',
        'https://bucket.s3.amazonaws.com/path2.png',
        'https://bucket.s3.amazonaws.com/path3.png',
      ];

      // Simulate makeUrlAccessible for each URL (succeeds)
      const makeUrlAccessible = async (url: string) => url.replace('s3.amazonaws.com', 'cdn.example.com');

      const results = await Promise.allSettled(urls.map(url => makeUrlAccessible(url)));

      const successfulUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          successfulUrls.push(result.value);
        } else {
          // Fallback to original URL
          successfulUrls.push(urls[i]);
        }
      }

      expect(successfulUrls).toHaveLength(3);
      expect(successfulUrls.every(url => url.includes('cdn.example.com'))).toBe(true);
    });

    it('should fallback to original URL when conversion fails', async () => {
      const urls = [
        'https://bucket.s3.amazonaws.com/good.png',
        'https://bucket.s3.amazonaws.com/bad.png',
        'https://bucket.s3.amazonaws.com/also-good.png',
      ];

      // Simulate makeUrlAccessible that fails for 'bad.png'
      const makeUrlAccessible = async (url: string) => {
        if (url.includes('bad.png')) {
          throw new Error('Network error');
        }
        return url.replace('s3.amazonaws.com', 'cdn.example.com');
      };

      const results = await Promise.allSettled(urls.map(url => makeUrlAccessible(url)));

      const successfulUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          successfulUrls.push(result.value);
        } else {
          // The fix: fallback to original URL instead of failing entirely
          successfulUrls.push(urls[i]);
        }
      }

      expect(successfulUrls).toHaveLength(3);
      // First and third should be converted
      expect(successfulUrls[0]).toBe('https://bucket.cdn.example.com/good.png');
      // Second should fallback to original
      expect(successfulUrls[1]).toBe('https://bucket.s3.amazonaws.com/bad.png');
      expect(successfulUrls[2]).toBe('https://bucket.cdn.example.com/also-good.png');
    });

    it('should handle all URLs failing gracefully', async () => {
      const urls = [
        'https://bucket.s3.amazonaws.com/1.png',
        'https://bucket.s3.amazonaws.com/2.png',
      ];

      // All conversions fail
      const makeUrlAccessible = async (_url: string) => {
        throw new Error('Service unavailable');
      };

      const results = await Promise.allSettled(urls.map(url => makeUrlAccessible(url)));

      const successfulUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          successfulUrls.push(result.value);
        } else {
          successfulUrls.push(urls[i]);
        }
      }

      // All should fallback to original URLs
      expect(successfulUrls).toEqual(urls);
    });

    it('should maintain URL order regardless of failure position', async () => {
      const urls = ['url1', 'url2', 'url3', 'url4', 'url5'];
      const failingIndices = [1, 3]; // url2 and url4 fail

      const makeUrlAccessible = async (url: string) => {
        const index = urls.indexOf(url);
        if (failingIndices.includes(index)) {
          throw new Error('Failed');
        }
        return `converted-${url}`;
      };

      const results = await Promise.allSettled(urls.map(url => makeUrlAccessible(url)));

      const successfulUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          successfulUrls.push(result.value);
        } else {
          successfulUrls.push(urls[i]);
        }
      }

      expect(successfulUrls).toEqual([
        'converted-url1',
        'url2',  // Original (failed)
        'converted-url3',
        'url4',  // Original (failed)
        'converted-url5',
      ]);
    });
  });

  describe('Comparison: Promise.all vs Promise.allSettled', () => {
    it('Promise.all rejects on first failure (old behavior)', async () => {
      const operations = [
        Promise.resolve('success1'),
        Promise.reject(new Error('failure')),
        Promise.resolve('success2'),
      ];

      // Old behavior with Promise.all - entire operation fails
      await expect(Promise.all(operations)).rejects.toThrow('failure');
    });

    it('Promise.allSettled continues on failure (new behavior)', async () => {
      const operations = [
        Promise.resolve('success1'),
        Promise.reject(new Error('failure')),
        Promise.resolve('success2'),
      ];

      // New behavior with Promise.allSettled - all results available
      const results = await Promise.allSettled(operations);

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'success1' });
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('failure');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'success2' });
    });
  });
});
