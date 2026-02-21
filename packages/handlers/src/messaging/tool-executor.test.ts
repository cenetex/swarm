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
});
