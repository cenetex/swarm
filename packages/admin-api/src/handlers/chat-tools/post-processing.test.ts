import { beforeAll, describe, expect, it } from 'vitest';
import { injectTestClients } from '../__test-helpers__/inject-clients.js';

let cleanResponse: typeof import('./post-processing.js').cleanResponse;
let detectAvatarUpdates: typeof import('./post-processing.js').detectAvatarUpdates;
let extractPendingJobs: typeof import('./post-processing.js').extractPendingJobs;
let shouldUseEmptyResponseFallback: typeof import('./post-processing.js').shouldUseEmptyResponseFallback;

beforeAll(async () => {
  await injectTestClients();
  const mod = await import('./post-processing.js');
  cleanResponse = mod.cleanResponse;
  detectAvatarUpdates = mod.detectAvatarUpdates;
  extractPendingJobs = mod.extractPendingJobs;
  shouldUseEmptyResponseFallback = mod.shouldUseEmptyResponseFallback;
});

describe('chat post-processing', () => {
  it('strips malformed leading thought lines from assistant responses', () => {
    const result = cleanResponse(
      '<thought The video failed to generate and should stay hidden.\nThe transaction failed, and the video got rugged.'
    );

    expect(result.response).toBe('The transaction failed, and the video got rugged.');
    expect(result.extractedThinking).toEqual(['The video failed to generate and should stay hidden.']);
  });

  it('does not use the generic empty-response fallback when a media job is pending', () => {
    expect(shouldUseEmptyResponseFallback('', [{
      jobId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'video',
      prompt: 'make a video',
    }])).toBe(false);
  });

  it('uses the generic empty-response fallback when no async work was started', () => {
    expect(shouldUseEmptyResponseFallback('', [])).toBe(true);
  });

  it('extracts pending video jobs from generate_video tool results', () => {
    const pendingJobs = extractPendingJobs(
      [{ id: 'call-video', name: 'generate_video' }],
      [{
        tool_call_id: 'call-video',
        role: 'tool',
        content: JSON.stringify({
          jobId: '123e4567-e89b-12d3-a456-426614174000',
          status: 'pending',
          prompt: 'make a video',
        }),
      }],
    );

    expect(pendingJobs).toEqual([{
      jobId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'video',
      prompt: 'make a video',
    }]);
  });

  it('surfaces update_my_profile name changes from tool arguments when backend refetch is unavailable', async () => {
    const updates = await detectAvatarUpdates(
      [{ id: 'call-profile', name: 'update_my_profile', arguments: { name: 'Mika' } }],
      [{
        tool_call_id: 'call-profile',
        role: 'tool',
        content: JSON.stringify({ success: true, data: { updated: ['name'] } }),
      }],
      undefined,
    );

    expect(updates).toEqual({ name: 'Mika' });
  });
});
