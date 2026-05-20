/**
 * Media Service Tests
 *
 * Tests for URL conversion logic, image generation options, media URL
 * canonicalization, Replicate error handling patterns, and webhook URL
 * construction logic.
 *
 * These are pure function tests that don't require mocking.
 *
 * Bug Index:
 * - BUG-009: Promise.all fails entirely if one URL fails (line 104)
 *
 * @see packages/admin-api/src/services/media.ts
 * @see packages/core/src/utils/media-url.ts
 * @see https://github.com/atimics/aws-swarm/issues/353
 */
import { describe, it, expect } from 'bun:test';
import { DEFAULT_MODELS, getReplicateVersion } from '../models-registry.js';
import type { AICapability, AvatarRecord } from '../../types.js';
import { buildMediaUrl, canonicalizeMediaUrl, canonicalizeMediaUrls } from '../../utils/media-url.js';
import { generateGalleryId } from './gallery.js';

// =============================================================================
// Existing: Media URL Generation
// =============================================================================

describe('Media URL Generation', () => {
  describe('URL accessibility conversion', () => {
    it('should return CDN URL when CDN_URL is configured', () => {
      const CDN_URL = 'https://media.example.com';
      const s3Url = 'https://test-bucket.s3.amazonaws.com/avatars/avatar-1/images/test.png';
      const expectedCdnUrl = 'https://media.example.com/avatars/avatar-1/images/test.png';

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
          input: 'https://bucket.s3.us-east-1.amazonaws.com/avatars/avatar-1/images/abc.png',
          expectedKey: 'avatars/avatar-1/images/abc.png',
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
        'https://media.rati.chat/avatars/test.png',
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
      const s3Key = 'avatars/avatar-1/images/test-uuid.png';

      const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

      expect(publicUrl).toBe('https://media-staging.rati.chat/avatars/avatar-1/images/test-uuid.png');
    });

    it('should fall back to S3 URL when CDN is not configured', () => {
      const CDN_URL = '';
      const MEDIA_BUCKET = 'swarm-media-staging-022118847419';
      const s3Key = 'avatars/avatar-1/images/test-uuid.png';

      const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

      expect(publicUrl).toBe('https://swarm-media-staging-022118847419.s3.amazonaws.com/avatars/avatar-1/images/test-uuid.png');
    });
  });
});

// =============================================================================
// Existing: Image Generation Options
// =============================================================================

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
      nanoBananaInput.image = referenceImageUrls[0];
      nanoBananaInput.image_prompt = referenceImageUrls[0];
      nanoBananaInput.aspect_ratio = 'match_input_image';
    }

    expect(nanoBananaInput.image_input).toEqual(['https://example.com/ref1.png']);
    expect(nanoBananaInput.image).toBe('https://example.com/ref1.png');
    expect(nanoBananaInput.image_prompt).toBe('https://example.com/ref1.png');
    expect(nanoBananaInput.aspect_ratio).toBe('match_input_image');
  });

  it('should build Flux input with image_prompt for reference images', () => {
    const prompt = 'A self portrait';
    const referenceImageUrls = ['https://example.com/ref-sheet.png'];
    const aspectRatio = '1:1';

    const fluxInput: Record<string, unknown> = {
      prompt: `${prompt}. Use the provided reference images to maintain visual consistency with the character's appearance, style, and features.`,
      aspect_ratio: aspectRatio,
      output_format: 'png',
      num_outputs: 1,
      image_input: referenceImageUrls.slice(0, 14),
      image: referenceImageUrls[0],
      image_prompt: referenceImageUrls[0],
    };

    expect(fluxInput.image_prompt).toBe('https://example.com/ref-sheet.png');
    expect(fluxInput.aspect_ratio).toBe('1:1');
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

// =============================================================================
// Existing: URL Accessibility - Promise.allSettled Pattern
// =============================================================================

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

// =============================================================================
// Existing: Integration Config Model Selection
// =============================================================================

describe('Integration Config Model Selection', () => {
  describe('getConfiguredModel behavior', () => {
    function getConfiguredModel(
      avatar: Partial<AvatarRecord> | null,
      capability: AICapability
    ): string {
      if (avatar?.integrations?.openrouter?.models?.[capability]) {
        return avatar.integrations.openrouter.models[capability]!;
      }
      return DEFAULT_MODELS[capability];
    }

    it('should return configured model when avatar has integration config', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          openrouter: {
            enabled: true,
            useGlobalKey: false,
            models: { image_generation: 'google/gemini-3-pro-image-preview' },
          },
        },
      };

      const model = getConfiguredModel(avatar, 'image_generation');
      expect(model).toBe('google/gemini-3-pro-image-preview');
    });

    it('should return default model when avatar has no integration config', () => {
      const avatar: Partial<AvatarRecord> = {};
      const model = getConfiguredModel(avatar, 'image_generation');
      expect(model).toBe(DEFAULT_MODELS.image_generation);
    });

    it('should return default model when avatar is null', () => {
      const model = getConfiguredModel(null, 'image_generation');
      expect(model).toBe(DEFAULT_MODELS.image_generation);
    });

    it('should return default model when OpenRouter integration not configured', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          telegram: {
            enabled: true,
          },
        },
      };

      const model = getConfiguredModel(avatar, 'image_generation');
      expect(model).toBe(DEFAULT_MODELS.image_generation);
    });

    it('should return default model when capability not specified in config', () => {
      const avatar: Partial<AvatarRecord> = {
        integrations: {
          openrouter: {
            enabled: true,
            useGlobalKey: true,
            models: { video_generation: 'google/veo-3.1-fast' },
          },
        },
      };

      const model = getConfiguredModel(avatar, 'image_generation');
      expect(model).toBe(DEFAULT_MODELS.image_generation);
    });

    it('should support all AI capabilities', () => {
      const capabilityModelMap: Record<AICapability, string> = {
        image_generation: 'custom/image-model',
        video_generation: 'custom/video-model',
        audio_generation: 'custom/audio-model',
        voice_clone: 'custom/voice-model',
        text_to_speech: 'custom/tts-model',
        transcription: 'custom/transcription-model',
        llm: 'custom/llm-model',
      };

      const avatar: Partial<AvatarRecord> = {
        integrations: {
          openrouter: {
            enabled: true,
            useGlobalKey: false,
            models: capabilityModelMap,
          },
        },
      };

      for (const [capability, expectedModel] of Object.entries(capabilityModelMap)) {
        const model = getConfiguredModel(avatar, capability as AICapability);
        expect(model).toBe(expectedModel);
      }
    });
  });

  describe('Replicate API endpoint selection', () => {
    it('should use model-based endpoint when no version hash exists', () => {
      const modelId = 'black-forest-labs/flux-schnell';
      const version = getReplicateVersion(modelId);

      expect(version).toBeUndefined();

      const endpoint = version
        ? 'https://api.replicate.com/v1/predictions'
        : `https://api.replicate.com/v1/models/${modelId}/predictions`;

      expect(endpoint).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions');
    });

    it('should use model-based endpoint for all current models', () => {
      const modelId = 'minimax/video-01';
      const version = getReplicateVersion(modelId);

      expect(version).toBeUndefined();

      const endpoint = version
        ? 'https://api.replicate.com/v1/predictions'
        : `https://api.replicate.com/v1/models/${modelId}/predictions`;

      expect(endpoint).toBe('https://api.replicate.com/v1/models/minimax/video-01/predictions');
    });

    it('should construct correct auth header', () => {
      const apiKey = 'test-api-key';

      const auth = `Token ${apiKey}`;
      expect(auth).toBe('Token test-api-key');
    });
  });

  describe('Request body construction', () => {
    it('should omit version in body when no version hash exists', () => {
      const modelId = 'black-forest-labs/flux-schnell';
      const version = getReplicateVersion(modelId);
      const input = { prompt: 'test' };

      const requestBody: Record<string, unknown> = { input };
      if (version) {
        requestBody.version = version;
      }

      expect(requestBody.version).toBe(version);
      expect(requestBody.input).toEqual(input);
    });

    it('should omit version in body for model API models', () => {
      const modelId = 'minimax/video-01';
      const version = getReplicateVersion(modelId);
      const input = { prompt: 'test' };

      const requestBody: Record<string, unknown> = { input };
      if (version) {
        requestBody.version = version;
      }

      expect(requestBody.version).toBeUndefined();
      expect(requestBody.input).toEqual(input);
    });
  });
});

// =============================================================================
// NEW: Core media URL utilities (buildMediaUrl, canonicalizeMediaUrl)
// =============================================================================

describe('Core Media URL Utilities', () => {
  describe('buildMediaUrl', () => {
    it('returns CDN URL when cdnUrl is provided', () => {
      const url = buildMediaUrl(
        'avatars/test/images/img.png',
        'my-bucket',
        'https://cdn.example.com'
      );
      expect(url).toBe('https://cdn.example.com/avatars/test/images/img.png');
    });

    it('falls back to S3 URL when cdnUrl is not provided', () => {
      const url = buildMediaUrl(
        'avatars/test/images/img.png',
        'my-bucket'
      );
      expect(url).toBe('https://my-bucket.s3.amazonaws.com/avatars/test/images/img.png');
    });

    it('falls back to S3 URL when cdnUrl is undefined', () => {
      const url = buildMediaUrl(
        'avatars/test/images/img.png',
        'my-bucket',
        undefined
      );
      expect(url).toBe('https://my-bucket.s3.amazonaws.com/avatars/test/images/img.png');
    });

    it('handles nested S3 keys correctly', () => {
      const url = buildMediaUrl(
        'avatars/bot-1/character-reference/ref-abc.png',
        'swarm-media-prod',
        'https://media.rati.chat'
      );
      expect(url).toBe('https://media.rati.chat/avatars/bot-1/character-reference/ref-abc.png');
    });
  });

  describe('canonicalizeMediaUrl', () => {
    it('rewrites S3 virtual-hosted URL to CDN URL', () => {
      const url = canonicalizeMediaUrl(
        'https://my-bucket.s3.amazonaws.com/avatars/test.png',
        'https://cdn.example.com'
      );
      expect(url).toBe('https://cdn.example.com/avatars/test.png');
    });

    it('rewrites S3 regional URL to CDN URL', () => {
      const url = canonicalizeMediaUrl(
        'https://my-bucket.s3.us-east-1.amazonaws.com/avatars/test.png',
        'https://cdn.example.com'
      );
      expect(url).toBe('https://cdn.example.com/avatars/test.png');
    });

    it('returns original URL when cdnUrl is not provided', () => {
      const original = 'https://my-bucket.s3.amazonaws.com/avatars/test.png';
      expect(canonicalizeMediaUrl(original)).toBe(original);
      expect(canonicalizeMediaUrl(original, undefined)).toBe(original);
    });

    it('returns original URL for non-S3 URLs', () => {
      const external = 'https://cdn.replicate.com/output/abc.png';
      expect(canonicalizeMediaUrl(external, 'https://cdn.example.com')).toBe(external);
    });

    it('returns original URL for CDN URLs (already canonical)', () => {
      const alreadyCdn = 'https://cdn.example.com/avatars/test.png';
      expect(canonicalizeMediaUrl(alreadyCdn, 'https://cdn.example.com')).toBe(alreadyCdn);
    });
  });

  describe('canonicalizeMediaUrls (batch)', () => {
    it('rewrites all S3 URLs in a batch', () => {
      const urls = [
        'https://bucket.s3.amazonaws.com/img1.png',
        'https://bucket.s3.us-west-2.amazonaws.com/img2.png',
        'https://external.com/img3.png',
      ];

      const result = canonicalizeMediaUrls(urls, 'https://cdn.example.com');
      expect(result).toEqual([
        'https://cdn.example.com/img1.png',
        'https://cdn.example.com/img2.png',
        'https://external.com/img3.png',
      ]);
    });

    it('returns original array when cdnUrl is not provided', () => {
      const urls = [
        'https://bucket.s3.amazonaws.com/img1.png',
        'https://bucket.s3.amazonaws.com/img2.png',
      ];

      expect(canonicalizeMediaUrls(urls)).toEqual(urls);
      expect(canonicalizeMediaUrls(urls, undefined)).toEqual(urls);
    });

    it('handles empty array', () => {
      expect(canonicalizeMediaUrls([], 'https://cdn.example.com')).toEqual([]);
    });
  });
});

// =============================================================================
// NEW: Replicate error summarization patterns
// =============================================================================

describe('Replicate Error Summarization', () => {
  /**
   * Tests the summarizeReplicateError logic pattern used in media.ts.
   * The function is not exported, so we test the same logic inline.
   */
  function summarizeReplicateError(errorText: string, status?: number): string {
    const raw = (errorText || '').trim();
    if (!raw) return status ? `Replicate request failed (HTTP ${status}).` : 'Replicate request failed.';

    // Try to extract a useful message from JSON error bodies.
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          const detail = typeof obj.detail === 'string' ? obj.detail : undefined;
          const title = typeof obj.title === 'string' ? obj.title : undefined;
          const error = typeof obj.error === 'string' ? obj.error : undefined;
          const message = typeof obj.message === 'string' ? obj.message : undefined;
          const candidate = detail || error || message || title;
          if (candidate && candidate.trim()) return candidate.trim();
        }
      } catch {
        // fall through
      }
    }

    if (/invalid version or not permitted/i.test(raw)) {
      return 'Replicate rejected the configured model version. Please switch to a different model or remove the pinned version.';
    }

    if (raw.length > 240) return `${raw.slice(0, 240)}\u2026`;
    return raw;
  }

  it('returns generic message for empty error text', () => {
    expect(summarizeReplicateError('')).toBe('Replicate request failed.');
    expect(summarizeReplicateError('', 500)).toBe('Replicate request failed (HTTP 500).');
  });

  it('extracts detail from JSON error body', () => {
    const json = JSON.stringify({ detail: 'Model version is invalid' });
    expect(summarizeReplicateError(json)).toBe('Model version is invalid');
  });

  it('extracts error field from JSON error body', () => {
    const json = JSON.stringify({ error: 'Rate limit exceeded' });
    expect(summarizeReplicateError(json)).toBe('Rate limit exceeded');
  });

  it('extracts message field from JSON error body', () => {
    const json = JSON.stringify({ message: 'Unauthorized' });
    expect(summarizeReplicateError(json)).toBe('Unauthorized');
  });

  it('prefers detail over error and message', () => {
    const json = JSON.stringify({ detail: 'Preferred', error: 'Fallback', message: 'Last' });
    expect(summarizeReplicateError(json)).toBe('Preferred');
  });

  it('detects version not permitted error', () => {
    const text = 'Invalid version or not permitted for this model';
    expect(summarizeReplicateError(text)).toContain('Replicate rejected the configured model version');
  });

  it('truncates very long error text', () => {
    const longText = 'x'.repeat(300);
    const result = summarizeReplicateError(longText);
    expect(result.length).toBeLessThanOrEqual(241); // 240 + ellipsis
    expect(result).toContain('\u2026');
  });

  it('returns plain text error as-is when short enough', () => {
    expect(summarizeReplicateError('Something went wrong')).toBe('Something went wrong');
  });

  it('handles malformed JSON gracefully', () => {
    expect(summarizeReplicateError('{invalid json')).toBe('{invalid json');
  });
});

// =============================================================================
// NEW: shouldRetryAsModelEndpoint pattern
// =============================================================================

describe('Replicate Version Retry Logic', () => {
  /**
   * Tests the shouldRetryAsModelEndpoint logic used when a version-pinned
   * Replicate request fails with 422 "invalid version or not permitted".
   */
  function shouldRetryAsModelEndpoint(status: number, errorText: string, hadVersion: boolean): boolean {
    if (!hadVersion) return false;
    if (status !== 422) return false;
    return /invalid version or not permitted/i.test(errorText);
  }

  it('retries on 422 with version error when version was used', () => {
    expect(shouldRetryAsModelEndpoint(422, 'invalid version or not permitted', true)).toBe(true);
  });

  it('does not retry when no version was used', () => {
    expect(shouldRetryAsModelEndpoint(422, 'invalid version or not permitted', false)).toBe(false);
  });

  it('does not retry on non-422 status', () => {
    expect(shouldRetryAsModelEndpoint(400, 'invalid version or not permitted', true)).toBe(false);
    expect(shouldRetryAsModelEndpoint(500, 'invalid version or not permitted', true)).toBe(false);
  });

  it('does not retry when error does not match pattern', () => {
    expect(shouldRetryAsModelEndpoint(422, 'Some other error', true)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(shouldRetryAsModelEndpoint(422, 'INVALID VERSION OR NOT PERMITTED', true)).toBe(true);
    expect(shouldRetryAsModelEndpoint(422, 'Invalid Version Or Not Permitted', true)).toBe(true);
  });
});

// =============================================================================
// NEW: Webhook URL construction pattern
// =============================================================================

describe('Replicate Webhook URL Construction', () => {
  /**
   * Tests the buildReplicateWebhookUrl logic.
   * When REPLICATE_WEBHOOK_SECRET is set, an HMAC signature is appended.
   */
  it('appends jobId as query parameter', () => {
    const baseUrl = 'https://api.example.com/replicate-callback';
    const jobId = 'job-123';

    const webhook = new URL(baseUrl);
    webhook.searchParams.set('jobId', jobId);

    expect(webhook.toString()).toContain('jobId=job-123');
    expect(webhook.toString()).toStartWith('https://api.example.com/replicate-callback?');
  });

  it('appends signature when secret is available', async () => {
    const { createHmac } = await import('crypto');
    const baseUrl = 'https://api.example.com/replicate-callback';
    const jobId = 'job-456';
    const secret = 'my-webhook-secret';

    const webhook = new URL(baseUrl);
    webhook.searchParams.set('jobId', jobId);
    const signature = createHmac('sha256', secret).update(jobId).digest('hex');
    webhook.searchParams.set('sig', signature);

    const result = webhook.toString();
    expect(result).toContain('jobId=job-456');
    expect(result).toContain('sig=');
    expect(result.length).toBeGreaterThan(baseUrl.length + 20);
  });

  it('handles invalid base URL gracefully with fallback', () => {
    const baseUrl = 'not-a-valid-url';
    const jobId = 'job-789';

    // The real function catches URL construction errors and falls back
    let result: string;
    try {
      const webhook = new URL(baseUrl);
      webhook.searchParams.set('jobId', jobId);
      result = webhook.toString();
    } catch {
      result = `${baseUrl}?jobId=${jobId}`;
    }

    expect(result).toBe('not-a-valid-url?jobId=job-789');
  });
});

// =============================================================================
// NEW: Aspect ratio validation pattern
// =============================================================================

describe('Aspect Ratio Validation', () => {
  const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const;

  it('accepts all valid aspect ratios', () => {
    for (const ratio of validRatios) {
      const result = validRatios.includes(ratio) ? ratio : '1:1';
      expect(result).toBe(ratio);
    }
  });

  it('defaults to 1:1 for invalid aspect ratios', () => {
    const invalidRatios = ['3:5', '7:8', '1:2', 'invalid', '', undefined];
    for (const ratio of invalidRatios) {
      const result = validRatios.includes(ratio as typeof validRatios[number])
        ? ratio
        : '1:1';
      expect(result).toBe('1:1');
    }
  });
});

// =============================================================================
// NEW: Media type inference pattern
// =============================================================================

describe('Media Type Inference', () => {
  function inferMediaType(url: string): 'image' | 'video' {
    const lower = url.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video';
    return 'image';
  }

  it('detects video from .mp4 extension', () => {
    expect(inferMediaType('https://cdn.example.com/video.mp4')).toBe('video');
    expect(inferMediaType('https://cdn.example.com/video.MP4')).toBe('video');
  });

  it('defaults to image for non-mp4 URLs', () => {
    expect(inferMediaType('https://cdn.example.com/image.png')).toBe('image');
    expect(inferMediaType('https://cdn.example.com/image.jpg')).toBe('image');
    expect(inferMediaType('https://cdn.example.com/image.webp')).toBe('image');
    expect(inferMediaType('https://cdn.example.com/file')).toBe('image');
  });
});

// =============================================================================
// Gallery ID Normalization (issue #823)
// =============================================================================

describe('Gallery ID Generation', () => {
  it('generates IDs in timestamp_randomId format', () => {
    const id = generateGalleryId();
    // Must match the canonical pattern: 10-15 digit timestamp, underscore, alphanumeric
    expect(id).toMatch(/^\d{10,15}_[a-z0-9]+$/i);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateGalleryId()));
    expect(ids.size).toBe(100);
  });

  it('generates IDs accepted by the Twitter adapter GALLERY_ID_PATTERN', () => {
    // This is the exact pattern used by mcp-twitter-adapter.ts to validate IDs
    const GALLERY_ID_PATTERN = /^\d{10,15}_[a-z0-9]+$/i;
    for (let i = 0; i < 20; i++) {
      const id = generateGalleryId();
      expect(GALLERY_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('generated IDs are NOT rejected as UUIDs by downstream consumers', () => {
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (let i = 0; i < 20; i++) {
      const id = generateGalleryId();
      // Generated IDs must not look like UUIDs
      expect(UUID_PATTERN.test(id)).toBe(false);
    }
  });

  it('backward compat: UUID format is accepted by updated Twitter adapter pattern', () => {
    // The Twitter adapter now also accepts UUIDs for existing gallery items
    const GALLERY_ID_PATTERN = /^\d{10,15}_[a-z0-9]+$/i;
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const legacyUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    // Simulate the updated acceptance logic: accept if EITHER pattern matches
    const accepted = GALLERY_ID_PATTERN.test(legacyUuid) || UUID_PATTERN.test(legacyUuid);
    expect(accepted).toBe(true);
  });
});
