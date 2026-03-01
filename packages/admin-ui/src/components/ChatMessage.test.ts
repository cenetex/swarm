/**
 * Tests for ChatMessage tool call visibility filtering logic.
 *
 * Validates that:
 * - send_gallery_image and search_gallery are auto-executed (never visible)
 * - Pending, completed, and failed non-auto-executed tool calls ARE visible
 * - Auto-executed tools are excluded regardless of status
 *
 * Covers regression for issue #229: completed send_gallery_image rendering
 * as "Unknown tool" prompt in admin UI.
 *
 * Updated for issue #566: completed/failed tool calls now render as status
 * badges instead of disappearing.
 */
import { describe, it, expect } from 'vitest';
import { getVisibleToolCalls, getInteractiveToolCalls, AUTO_EXECUTED_TOOLS } from './ChatMessage';
import type { ToolCall } from '../types';

describe('getVisibleToolCalls', () => {
  it('excludes send_gallery_image from visible prompts', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-1',
        name: 'send_gallery_image',
        arguments: { imageId: 'img-123', chatId: '456' },
        status: 'pending',
      },
    ];

    const result = getVisibleToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('excludes search_gallery from visible prompts', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-2',
        name: 'search_gallery',
        arguments: { query: 'sunset' },
        status: 'pending',
      },
    ];

    const result = getVisibleToolCalls(toolCalls);
    expect(result).toHaveLength(0);
  });

  it('includes send_gallery_image and search_gallery in AUTO_EXECUTED_TOOLS', () => {
    expect(AUTO_EXECUTED_TOOLS).toContain('send_gallery_image');
    expect(AUTO_EXECUTED_TOOLS).toContain('search_gallery');
  });

  it('keeps completed tool calls visible for status badge rendering', () => {
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
    ];

    const result = getVisibleToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('completed');
    expect(result[1].status).toBe('completed');
  });

  it('keeps failed tool calls visible for error badge rendering', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-6',
        name: 'request_secret',
        arguments: { key: 'API_KEY' },
        status: 'failed',
      },
    ];

    const result = getVisibleToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('failed');
  });

  it('still excludes auto-executed tools even when completed', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tc-5',
        name: 'send_gallery_image',
        arguments: { imageId: 'x' },
        status: 'completed',
        result: { success: true },
      },
      {
        id: 'tc-5b',
        name: 'generate_image',
        arguments: { prompt: 'cat' },
        status: 'completed',
        result: { success: true },
      },
    ];

    const result = getVisibleToolCalls(toolCalls);
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

    const result = getVisibleToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('request_secret');
    expect(result[1].name).toBe('confirm_action');
  });

  it('handles mixed statuses — excludes only auto-executed tools', () => {
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

    const result = getVisibleToolCalls(toolCalls);
    // request_secret (pending) + confirm_action (completed) — both non-auto-executed
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('tc-9');
    expect(result[1].id).toBe('tc-10');
  });

  it('returns empty array for undefined toolCalls', () => {
    expect(getVisibleToolCalls(undefined)).toEqual([]);
  });

  it('returns empty array for empty toolCalls array', () => {
    expect(getVisibleToolCalls([])).toEqual([]);
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

describe('getInteractiveToolCalls (deprecated alias)', () => {
  it('is an alias for getVisibleToolCalls', () => {
    expect(getInteractiveToolCalls).toBe(getVisibleToolCalls);
  });
});
