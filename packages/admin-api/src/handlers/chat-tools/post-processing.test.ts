import { describe, expect, it } from 'vitest';
import { cleanResponse, extractPendingJobs, shouldUseEmptyResponseFallback } from './post-processing.js';

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
});
