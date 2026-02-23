/**
 * Tests for ChatMessage interactive tool call filtering logic.
 *
 * Validates that:
 * - send_gallery_image and search_gallery are auto-executed (non-interactive)
 * - Completed/failed tool calls never appear as interactive prompts
 * - Only pending, non-auto-executed tools show interactive prompts
 *
 * Covers regression for issue #229: completed send_gallery_image rendering
 * as "Unknown tool" prompt in admin UI.
 */
import { describe, it, expect } from 'vitest';
import { getInteractiveToolCalls, AUTO_EXECUTED_TOOLS } from './ChatMessage';
import type { ToolCall } from '../types';

describe('getInteractiveToolCalls', () => {
  it('excludes send_gallery_image from interactive prompts', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-1',
        name: 'send_gallery_image',
        arguments: { imageId: 'img-123', chatId: '456' },
        status: 'pending',
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('excludes search_gallery from interactive prompts', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-2',
        name: 'search_gallery',
        arguments: { query: 'sunset' },
        status: 'pending',
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('includes send_gallery_image and search_gallery in AUTO_EXECUTED_TOOLS', () => {
    expect(AUTO_EXECUTED_TOOLS).toContain('send_gallery_image');
    expect(AUTO_EXECUTED_TOOLS).toContain('search_gallery');
  });

  it('filters out completed tool calls regardless of tool name', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-3',
        name: 'request_secret',
        arguments: { key: 'API_KEY', label: 'Enter your API key' },
        status: 'completed',
        result: { success: true },
      },
      {
        id: 'tc-4',
        name: 'confirm_action',
        arguments: { action: 'delete_avatar' },
        status: 'completed',
        result: { confirmed: true },
      },
      {
        id: 'tc-5',
        name: 'some_unknown_tool',
        arguments: { foo: 'bar' },
        status: 'completed',
        result: { success: true },
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('filters out failed tool calls', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-6',
        name: 'request_secret',
        arguments: { key: 'API_KEY' },
        status: 'failed',
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('includes pending non-auto-executed tool calls', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-7',
        name: 'request_secret',
        arguments: { key: 'API_KEY', label: 'Enter API key' },
        status: 'pending',
      },
      {
        id: 'tc-8',
        name: 'confirm_action',
        arguments: { action: 'delete_avatar' },
        status: 'pending',
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('request_secret');
    expect(result[1].name).toBe('confirm_action');
  });

  it('handles mixed pending and completed tool calls correctly', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-9',
        name: 'request_secret',
        arguments: { key: 'KEY' },
        status: 'pending',
      },
      {
        id: 'tc-10',
        name: 'confirm_action',
        arguments: { action: 'test' },
        status: 'completed',
        result: { confirmed: true },
      },
      {
        id: 'tc-11',
        name: 'send_gallery_image',
        arguments: { imageId: 'x' },
        status: 'pending',
      },
    ];

    const result = getInteractiveToolCalls(toolCalls);
    // Only request_secret (pending + not auto-executed) should be included
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tc-9');
  });

  it('returns empty array for undefined toolCalls', () => {
    expect(getInteractiveToolCalls(undefined)).toEqual([]);
  });

  it('returns empty array for empty toolCalls array', () => {
    expect(getInteractiveToolCalls([])).toEqual([]);
  });

  it('ensures all known auto-executed tools are in the list', () => {
    const expected = [
      'generate_image',
      'generate_video',
      'generate_sticker',
      'get_my_gallery',
      'send_gallery_image',
      'search_gallery',
      'send_voice_message',
      'create_my_voice',
      'update_my_profile',
    ];
    for (const tool of expected) {
      expect(AUTO_EXECUTED_TOOLS).toContain(tool);
    }
  });
});
