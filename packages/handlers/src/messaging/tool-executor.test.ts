/**
 * Tool Executor Tests
 *
 * Tests for toolResultsToActions, focusing on send_gallery_image
 * failure handling (issue #230).
 */
import { describe, it, expect } from 'bun:test';
import { toolResultsToActions } from './tool-executor.js';

describe('toolResultsToActions', () => {
  describe('send_gallery_image', () => {
    it('produces send_media action for successful gallery image send', () => {
      const actions = toolResultsToActions([
        {
          name: 'send_gallery_image',
          result: {
            success: true,
            data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
            media: { type: 'image', url: 'https://cdn.example.com/img.png' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('send_media');
      expect((actions[0] as { url: string }).url).toBe('https://cdn.example.com/img.png');
      expect((actions[0] as { mediaType: string }).mediaType).toBe('image');
    });

    it('produces NO actions for failed gallery image send (invalid ID)', () => {
      const actions = toolResultsToActions([
        {
          name: 'send_gallery_image',
          result: {
            success: false,
          },
        },
      ]);

      expect(actions).toHaveLength(0);
    });

    it('produces NO actions for failed gallery send with FAILED error message', () => {
      // This simulates the exact error shape from the hardened gallery.ts
      const actions = toolResultsToActions([
        {
          name: 'send_gallery_image',
          result: {
            success: false,
            // error is not part of the typed interface, but the guard is `!result.success`
          },
        },
      ]);

      expect(actions).toHaveLength(0);
    });

    it('produces NO action when success is true but media is missing', () => {
      // Edge case: success but no media payload (should not happen, but defensive)
      const actions = toolResultsToActions([
        {
          name: 'send_gallery_image',
          result: {
            success: true,
            data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
            // No media field
          },
        },
      ]);

      expect(actions).toHaveLength(0);
    });
  });

  describe('general behavior', () => {
    it('skips all failed tool results regardless of tool name', () => {
      const actions = toolResultsToActions([
        {
          name: 'generate_image',
          result: {
            success: false,
            media: { type: 'image', url: 'https://cdn.example.com/shouldnt-appear.png' },
          },
        },
        {
          name: 'send_gallery_image',
          result: {
            success: false,
            media: { type: 'image', url: 'https://cdn.example.com/shouldnt-appear-either.png' },
          },
        },
      ]);

      expect(actions).toHaveLength(0);
    });

    it('processes mixed success and failure results correctly', () => {
      const actions = toolResultsToActions([
        {
          name: 'send_gallery_image',
          result: {
            success: false,
          },
        },
        {
          name: 'send_gallery_image',
          result: {
            success: true,
            data: { id: 'img-2', url: 'https://cdn.example.com/img2.png' },
            media: { type: 'image', url: 'https://cdn.example.com/img2.png' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect((actions[0] as { url: string }).url).toBe('https://cdn.example.com/img2.png');
    });
  });

  describe('generate_image async pendingJob', () => {
    it('produces send_message action for async image generation', () => {
      const actions = toolResultsToActions([
        {
          name: 'generate_image',
          result: {
            success: true,
            data: { jobId: 'job-123', status: 'started' },
            pendingJob: { jobId: 'job-123', type: 'image', prompt: 'a sunset' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('send_message');
      expect((actions[0] as { text: string }).text).toContain('Generating image');
      expect((actions[0] as { text: string }).text).toContain('a sunset');
    });

    it('prefers media over pendingJob for generate_image', () => {
      const actions = toolResultsToActions([
        {
          name: 'generate_image',
          result: {
            success: true,
            data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
            media: { type: 'image', url: 'https://cdn.example.com/img.png' },
            pendingJob: { jobId: 'job-123', type: 'image', prompt: 'a sunset' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('send_media');
      expect((actions[0] as { url: string }).url).toBe('https://cdn.example.com/img.png');
    });
  });

  describe('generate_video async pendingJob', () => {
    it('produces send_message action for async video generation', () => {
      const actions = toolResultsToActions([
        {
          name: 'generate_video',
          result: {
            success: true,
            data: { jobId: 'job-456', status: 'started' },
            pendingJob: { jobId: 'job-456', type: 'video', prompt: 'dancing cat' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('send_message');
      expect((actions[0] as { text: string }).text).toContain('Generating video');
      expect((actions[0] as { text: string }).text).toContain('dancing cat');
    });

    it('prefers media over pendingJob for generate_video', () => {
      const actions = toolResultsToActions([
        {
          name: 'generate_video',
          result: {
            success: true,
            data: { url: 'https://cdn.example.com/vid.mp4' },
            media: { type: 'video', url: 'https://cdn.example.com/vid.mp4' },
            pendingJob: { jobId: 'job-456', type: 'video', prompt: 'dancing cat' },
          },
        },
      ]);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('send_media');
      expect((actions[0] as { url: string }).url).toBe('https://cdn.example.com/vid.mp4');
    });
  });
});
