/**
 * Tests for PromptPreviewPanel's system-prompt override edit flow (#1531).
 *
 * Covers:
 *  - badge indicator reflects current override mode returned by the preview API
 *  - Edit button opens the editor and preloads text/url as appropriate
 *  - mode switch (none / inline / url) shows the right control
 *  - Save: inline override → PUT /avatars/{id} with correct payload + refetch
 *  - Save: URL override → PUT with url payload
 *  - Save: None → PUT with systemPromptOverride: null (clear)
 *  - Cancel: no API call, editor closes
 *  - Validation: empty text blocks save, empty/invalid URL blocks save
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import type { PromptPreviewResponse } from '../api/prompt-preview';

// ─── Mock the store ─────────────────────────────────────────────────────────
// Both hooks return stable references so useCallback/useEffect dep arrays don't
// refire on every render (which would cause fetchPreviewMock to be invoked
// repeatedly and break call-count assertions).
const STABLE_AVATAR = { id: 'avatar-test', name: 'TestBot' };
const STABLE_MESSAGES: unknown[] = [];
vi.mock('../store', () => ({
  useActiveAvatar: () => STABLE_AVATAR,
  useActiveChat: () => STABLE_MESSAGES,
}));

// ─── Mock i18n ──────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, opts?: { count?: number }) => (opts?.count !== undefined ? String(opts.count) : _k) }),
}));

// ─── Mock API calls ─────────────────────────────────────────────────────────
const fetchPreviewMock = vi.fn<[], Promise<PromptPreviewResponse>>();
const updateAvatarMock = vi.fn<[string, Record<string, unknown>], Promise<unknown>>();

vi.mock('../api/prompt-preview', () => ({
  fetchPromptPreview: (...args: unknown[]) => fetchPreviewMock(...(args as [])),
}));

vi.mock('../api/avatars', () => ({
  updateAvatar: (...args: unknown[]) => updateAvatarMock(...(args as [string, Record<string, unknown>])),
}));

function buildPreview(
  override?: PromptPreviewResponse['systemPromptOverride'],
  systemPrompt = 'ASSEMBLED PROMPT TEXT',
): PromptPreviewResponse {
  return {
    systemPrompt,
    tools: [],
    toolCount: 0,
    enabledToolsets: [],
    enabledCategories: [],
    messages: [],
    tokenEstimate: { systemPrompt: 10, tools: 0, messages: 0, total: 10 },
    ...(override ? { systemPromptOverride: override } : {}),
  };
}

async function renderOpen(initial: PromptPreviewResponse) {
  fetchPreviewMock.mockResolvedValue(initial);
  render(<PromptPreviewPanel isOpen={true} onClose={() => {}} />);
  await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalled());
  // allow preview state to settle
  await screen.findByTestId('prompt-override-badge');
}

beforeEach(() => {
  fetchPreviewMock.mockReset();
  updateAvatarMock.mockReset();
});

describe('PromptPreviewPanel — override badge', () => {
  it('shows "assembled template" when no override is set', async () => {
    await renderOpen(buildPreview(undefined));
    const badge = screen.getByTestId('prompt-override-badge');
    expect(badge.getAttribute('data-override-kind')).toBe('none');
  });

  it('shows "inline" when override.kind = inline', async () => {
    await renderOpen(buildPreview({ kind: 'inline', text: 'SHORT PROMPT' }));
    const badge = screen.getByTestId('prompt-override-badge');
    expect(badge.getAttribute('data-override-kind')).toBe('inline');
  });

  it('shows "url" when override.kind = url', async () => {
    await renderOpen(buildPreview({ kind: 'url', url: 'https://example.com/p.md' }));
    const badge = screen.getByTestId('prompt-override-badge');
    expect(badge.getAttribute('data-override-kind')).toBe('url');
  });
});

describe('PromptPreviewPanel — editor open/close', () => {
  it('Edit button opens the editor and preloads the current prompt when no override exists', async () => {
    await renderOpen(buildPreview(undefined, 'CURRENT ASSEMBLED'));
    fireEvent.click(screen.getByTestId('prompt-override-edit'));
    const textarea = (await screen.findByTestId('prompt-override-text')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('CURRENT ASSEMBLED');
    expect(screen.getByTestId('prompt-override-editor')).toBeTruthy();
  });

  it('Cancel returns to view mode without calling updateAvatar', async () => {
    await renderOpen(buildPreview(undefined));
    fireEvent.click(screen.getByTestId('prompt-override-edit'));
    fireEvent.click(screen.getByTestId('prompt-override-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('prompt-override-editor')).toBeNull(),
    );
    expect(updateAvatarMock).not.toHaveBeenCalled();
  });
});

describe('PromptPreviewPanel — save flows', () => {
  it('inline save sends { kind: inline, text } and refreshes the preview', async () => {
    const initial = buildPreview(undefined, 'INITIAL PROMPT');
    const post = buildPreview({ kind: 'inline', text: 'NEW PROMPT' }, 'NEW PROMPT');
    fetchPreviewMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(post);
    updateAvatarMock.mockResolvedValue(undefined);

    render(<PromptPreviewPanel isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByTestId('prompt-override-edit'));
    const textarea = (await screen.findByTestId('prompt-override-text')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'NEW PROMPT' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('prompt-override-save'));
    });

    await waitFor(() => expect(updateAvatarMock).toHaveBeenCalledTimes(1));
    expect(updateAvatarMock.mock.calls[0][0]).toBe('avatar-test');
    expect(updateAvatarMock.mock.calls[0][1]).toEqual({
      systemPromptOverride: { kind: 'inline', text: 'NEW PROMPT' },
    });
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalledTimes(2));
  });

  it('url save sends { kind: url, url }', async () => {
    const initial = buildPreview(undefined);
    fetchPreviewMock.mockResolvedValue(initial);
    updateAvatarMock.mockResolvedValue(undefined);

    render(<PromptPreviewPanel isOpen={true} onClose={() => {}} />);
    await screen.findByTestId('prompt-override-badge');
    fireEvent.click(screen.getByTestId('prompt-override-edit'));

    fireEvent.click(screen.getByTestId('prompt-override-mode-url'));
    const urlInput = (await screen.findByTestId('prompt-override-url')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://example.com/prompt.md' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('prompt-override-save'));
    });

    await waitFor(() => expect(updateAvatarMock).toHaveBeenCalledTimes(1));
    expect(updateAvatarMock.mock.calls[0][1]).toEqual({
      systemPromptOverride: { kind: 'url', url: 'https://example.com/prompt.md' },
    });
  });

  it('none save sends { systemPromptOverride: null } to clear', async () => {
    await renderOpen(buildPreview({ kind: 'inline', text: 'some text' }));
    updateAvatarMock.mockResolvedValue(undefined);

    fireEvent.click(screen.getByTestId('prompt-override-edit'));
    fireEvent.click(screen.getByTestId('prompt-override-mode-none'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('prompt-override-save'));
    });

    await waitFor(() => expect(updateAvatarMock).toHaveBeenCalledTimes(1));
    expect(updateAvatarMock.mock.calls[0][1]).toEqual({ systemPromptOverride: null });
  });
});

describe('PromptPreviewPanel — save validation', () => {
  it('blocks inline save when text is only whitespace', async () => {
    await renderOpen(buildPreview(undefined, '   '));
    fireEvent.click(screen.getByTestId('prompt-override-edit'));
    const textarea = (await screen.findByTestId('prompt-override-text')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '   ' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('prompt-override-save'));
    });
    expect(updateAvatarMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt-override-error')).toBeTruthy();
  });

  it('blocks URL save on an invalid URL', async () => {
    await renderOpen(buildPreview(undefined));
    fireEvent.click(screen.getByTestId('prompt-override-edit'));
    fireEvent.click(screen.getByTestId('prompt-override-mode-url'));
    const urlInput = (await screen.findByTestId('prompt-override-url')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'not a url' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('prompt-override-save'));
    });
    expect(updateAvatarMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt-override-error')).toBeTruthy();
  });
});
