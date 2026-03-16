/**
 * Tests for task/workspace action pattern.
 *
 * Covers:
 * - TaskAction schema structure
 * - withTaskAction helper enriches results
 * - extractTaskAction parses from serialized JSON
 * - Backward compatibility: existing fields (uiAction, media, pendingJob) are preserved
 * - Tools that adopt the pattern return valid taskAction in their results
 */
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import {
  ToolRegistry,
  defineTool,
  withTaskAction,
  extractTaskAction,
  type ToolResult,
  type TaskAction,
} from './registry.js';

/* ------------------------------------------------------------------ */
/* withTaskAction helper                                               */
/* ------------------------------------------------------------------ */

describe('withTaskAction', () => {
  it('attaches taskAction to a successful result', () => {
    const base: ToolResult = { success: true, data: { items: [] } };
    const action: TaskAction = {
      task: {
        type: 'gallery',
        title: 'Media Gallery',
        summary: '3 items',
      },
      workspace: { focus: true, surface: 'side_panel' },
    };

    const enriched = withTaskAction(base, action);
    expect(enriched.success).toBe(true);
    expect(enriched.data).toEqual({ items: [] });
    expect(enriched.taskAction).toEqual(action);
    expect(enriched.taskAction?.task.type).toBe('gallery');
    expect(enriched.taskAction?.workspace?.focus).toBe(true);
  });

  it('preserves existing uiAction for backward compatibility', () => {
    const base: ToolResult = {
      success: true,
      data: {},
      uiAction: { type: 'upload_widget', payload: { purpose: 'gallery' } },
    };
    const action: TaskAction = {
      task: { type: 'gallery', title: 'Upload' },
    };

    const enriched = withTaskAction(base, action);
    expect(enriched.uiAction?.type).toBe('upload_widget');
    expect(enriched.taskAction?.task.type).toBe('gallery');
  });

  it('preserves media and pendingJob fields', () => {
    const base: ToolResult = {
      success: true,
      media: { type: 'image', url: 'https://example.com/img.png' },
      pendingJob: { jobId: 'j-1', type: 'image' },
    };
    const action: TaskAction = {
      task: { type: 'document', title: 'Image Result' },
    };

    const enriched = withTaskAction(base, action);
    expect(enriched.media?.url).toBe('https://example.com/img.png');
    expect(enriched.pendingJob?.jobId).toBe('j-1');
    expect(enriched.taskAction?.task.type).toBe('document');
  });

  it('works with workspace omitted (task-only action)', () => {
    const enriched = withTaskAction(
      { success: true },
      { task: { type: 'diagnostics', title: 'Bug Report' } },
    );
    expect(enriched.taskAction?.workspace).toBeUndefined();
    expect(enriched.taskAction?.task.title).toBe('Bug Report');
  });
});

/* ------------------------------------------------------------------ */
/* extractTaskAction — parsing from serialized tool results            */
/* ------------------------------------------------------------------ */

describe('extractTaskAction', () => {
  it('extracts a valid taskAction from JSON', () => {
    const content = JSON.stringify({
      success: true,
      data: { items: [] },
      taskAction: {
        task: { type: 'gallery', title: 'Gallery', summary: '5 items' },
        workspace: { focus: true, surface: 'side_panel' },
      },
    });

    const action = extractTaskAction(content);
    expect(action).toBeDefined();
    expect(action!.task.type).toBe('gallery');
    expect(action!.task.title).toBe('Gallery');
    expect(action!.task.summary).toBe('5 items');
    expect(action!.workspace?.focus).toBe(true);
    expect(action!.workspace?.surface).toBe('side_panel');
  });

  it('returns undefined when no taskAction field exists', () => {
    const content = JSON.stringify({ success: true, data: {} });
    expect(extractTaskAction(content)).toBeUndefined();
  });

  it('returns undefined for non-JSON input', () => {
    expect(extractTaskAction('not json')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractTaskAction('')).toBeUndefined();
  });

  it('returns undefined for malformed taskAction (missing type)', () => {
    const content = JSON.stringify({
      taskAction: { task: { title: 'No type' } },
    });
    expect(extractTaskAction(content)).toBeUndefined();
  });

  it('returns undefined for malformed taskAction (missing title)', () => {
    const content = JSON.stringify({
      taskAction: { task: { type: 'gallery' } },
    });
    expect(extractTaskAction(content)).toBeUndefined();
  });

  it('handles taskAction with props', () => {
    const content = JSON.stringify({
      taskAction: {
        task: {
          type: 'wallet_link',
          title: 'Wallets',
          props: { walletCount: 3, chain: 'solana' },
        },
      },
    });

    const action = extractTaskAction(content);
    expect(action).toBeDefined();
    expect(action!.task.props?.walletCount).toBe(3);
    expect(action!.task.props?.chain).toBe('solana');
  });
});

/* ------------------------------------------------------------------ */
/* ToolRegistry: tools returning taskAction                            */
/* ------------------------------------------------------------------ */

describe('ToolRegistry with taskAction', () => {
  it('tool result includes taskAction after execution', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'gallery_with_action',
      description: 'Gallery tool with task action',
      inputSchema: z.object({}),
      execute: async () => withTaskAction(
        { success: true, data: { items: ['img-1', 'img-2'] } },
        {
          task: { type: 'gallery', title: 'My Gallery', summary: '2 items' },
          workspace: { focus: true, surface: 'side_panel' },
        },
      ),
    }));

    const result = await registry.execute(
      'gallery_with_action',
      {},
      { avatarId: 'a1', platform: 'admin-ui' },
    );

    expect(result.success).toBe(true);
    expect(result.taskAction).toBeDefined();
    expect(result.taskAction?.task.type).toBe('gallery');
    expect(result.taskAction?.task.summary).toBe('2 items');
    expect(result.taskAction?.workspace?.focus).toBe(true);
  });

  it('taskAction is serialized in JSON output for tool results', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'wallet_overview',
      description: 'Wallet overview',
      inputSchema: z.object({}),
      execute: async () => withTaskAction(
        { success: true, data: { wallets: [] } },
        {
          task: {
            type: 'wallet_link',
            title: 'Wallet Overview',
            summary: 'No wallets',
            props: { walletCount: 0 },
          },
          workspace: { focus: false },
        },
      ),
    }));

    const result = await registry.execute(
      'wallet_overview',
      {},
      { avatarId: 'a1', platform: 'admin-ui' },
    );

    // Simulate what the backend does: serialize to JSON
    const serialized = JSON.stringify(result);
    const extracted = extractTaskAction(serialized);
    expect(extracted).toBeDefined();
    expect(extracted!.task.type).toBe('wallet_link');
    expect(extracted!.workspace?.focus).toBe(false);
  });

  it('existing uiAction tools still work without taskAction', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'legacy_tool',
      description: 'Legacy tool with uiAction only',
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => ({
        success: true,
        data: {},
        uiAction: { type: 'upload_widget', payload: { purpose: 'test' } },
      }),
    }));

    const result = await registry.execute(
      'legacy_tool',
      {},
      { avatarId: 'a1', platform: 'admin-ui' },
    );

    expect(result.success).toBe(true);
    expect(result.uiAction?.type).toBe('upload_widget');
    expect(result.taskAction).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* TaskAction types — validate all task types                          */
/* ------------------------------------------------------------------ */

describe('TaskAction task types', () => {
  const validTypes: TaskAction['task']['type'][] = [
    'tool_prompt',
    'gallery',
    'wallet_link',
    'integration_config',
    'document',
    'diagnostics',
  ];

  for (const type of validTypes) {
    it(`accepts task type '${type}'`, () => {
      const action: TaskAction = {
        task: { type, title: `Test ${type}` },
      };
      expect(action.task.type).toBe(type);
    });
  }
});
