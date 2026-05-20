import { describe, expect, it } from 'vitest';
import { extractOpenRouterVideoUrl } from './media-jobs.js';

describe('extractOpenRouterVideoUrl', () => {
  it('extracts completed OpenRouter video unsigned_urls payloads', () => {
    const url = 'https://openrouter.ai/api/v1/videos/job-id/content';
    const payload = {
      id: 'job-id',
      generation_id: 'gen-vid-123',
      status: 'completed',
      unsigned_urls: [url],
      usage: {
        cost: 0.6048,
        is_byok: false,
      },
    };

    expect(extractOpenRouterVideoUrl(payload)).toBe(url);
  });

  it('extracts nested signed URL arrays', () => {
    const url = 'https://openrouter.ai/api/v1/videos/job-id/content?signed=1';

    expect(extractOpenRouterVideoUrl({
      data: {
        status: 'completed',
        signed_urls: [{ url }],
      },
    })).toBe(url);
  });
});
