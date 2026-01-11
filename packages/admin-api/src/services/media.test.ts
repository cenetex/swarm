/**
 * Media Service Tests
 *
 * Tests for URL conversion logic and image generation options.
 * These are pure function tests that don't require mocking.
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
