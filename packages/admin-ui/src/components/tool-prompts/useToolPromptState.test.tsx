/**
 * Canary for the DOM test harness (#1455).
 *
 * If this test runs, the vitest + jsdom setup works and future React
 * component/hook tests can use @testing-library/react freely. Keep these
 * assertions focused on the ToolSubmitResult contract so the doc
 * reference from #1453 stays true.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useToolPromptState } from './useToolPromptState';
import type { ToolSubmitResult } from './types';

describe('useToolPromptState', () => {
  it('transitions idle → processing → success on ok result', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }) as ToolSubmitResult);
    const { result } = renderHook(() =>
      useToolPromptState({ onSubmit, toolCallId: 'call-1' }),
    );

    expect(result.current.phase).toBe('idle');

    await act(async () => {
      await result.current.submit({ answer: 'yes' });
    });

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.error).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith('call-1', { answer: 'yes' });
  });

  it('transitions to error with the returned message on ok:false', async () => {
    const onSubmit = vi.fn(
      async () => ({ ok: false, error: 'invalid token' }) as ToolSubmitResult,
    );
    const { result } = renderHook(() =>
      useToolPromptState({ onSubmit, toolCallId: 'call-2' }),
    );

    await act(async () => {
      await result.current.submit({});
    });

    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.error).toBe('invalid token');
  });

  it('retry() resets from error back to idle', async () => {
    const onSubmit = vi.fn(
      async () => ({ ok: false, error: 'boom' }) as ToolSubmitResult,
    );
    const { result } = renderHook(() =>
      useToolPromptState({ onSubmit, toolCallId: 'call-3' }),
    );

    await act(async () => {
      await result.current.submit({});
    });
    await waitFor(() => expect(result.current.phase).toBe('error'));

    act(() => {
      result.current.retry();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('defensively catches thrown errors from legacy onSubmit implementations', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('legacy throw');
    });
    const { result } = renderHook(() =>
      useToolPromptState({ onSubmit, toolCallId: 'call-4' }),
    );

    await act(async () => {
      await result.current.submit({});
    });

    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.error).toBe('legacy throw');
  });
});
