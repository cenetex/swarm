/**
 * Tests for PromptPreviewPanel with system prompt override editing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import * as avatarsApi from '../api/avatars';
import * as promptPreviewApi from '../api/prompt-preview';
import * as store from '../store';

vi.mock('../api/avatars');
vi.mock('../api/prompt-preview');
vi.mock('../store');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaults?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'promptPreview.title': 'Prompt Preview',
        'promptPreview.refresh': 'Refresh',
        'promptPreview.errorLoadingPreview': 'Error loading preview',
        'common.loading': 'Loading',
        'promptPreview.noData': 'No data',
        'promptPreview.tokenBreakdown.system': 'System',
        'promptPreview.tokenBreakdown.tools': 'Tools',
        'promptPreview.tokenBreakdown.messages': 'Messages',
        'promptPreview.tokenBreakdown.toolsets': 'Toolsets',
        'promptPreview.tabs.systemPrompt': 'System Prompt',
        'promptPreview.tabs.tools': `Tools (${defaults?.count || 0})`,
        'promptPreview.tabs.messages': `Messages (${defaults?.count || 0})`,
        'promptPreview.noAvatarSelected': 'No avatar selected',
        'promptPreview.failedToLoad': 'Failed to load preview',
        'promptPreview.retrying': 'Retrying',
        'common.retry': 'Retry',
        'promptPreview.loadingPreview': 'Loading preview...',
        'promptPreview.filterByToolset': 'Filter by toolset',
        'promptPreview.allToolsets': `All toolsets (${defaults?.count || 0})`,
        'promptPreview.parametersJsonSchema': 'JSON Schema',
        'common.edit': 'Edit',
        'promptPreview.overrideMode': 'Override mode',
        'promptPreview.customText': 'Custom text',
        'promptPreview.urlInput': 'URL',
        'promptPreview.cacheTtlHint': 'Cache TTL: default 300s',
        'common.save': 'Save',
        'common.saving': 'Saving...',
        'common.cancel': 'Cancel',
        'promptPreview.clear': 'Clear',
      };
      return translations[key] || key;
    },
  }),
}));

describe('PromptPreviewPanel', () => {
  const mockAvatar = {
    id: 'avatar-1',
    avatarId: 'avatar-1',
    name: 'Test Avatar',
    status: 'active' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'user-1',
  };

  const mockPreview = {
    systemPrompt: 'You are a helpful assistant.',
    tools: [],
    toolCount: 0,
    enabledToolsets: [],
    enabledCategories: [],
    messages: [],
    tokenEstimate: {
      systemPrompt: 50,
      tools: 0,
      messages: 0,
      total: 50,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (store.useActiveAvatar as any).mockReturnValue(mockAvatar);
    (store.useActiveChat as any).mockReturnValue([]);
    (promptPreviewApi.fetchPromptPreview as any).mockResolvedValue(mockPreview);
  });

  it('renders panel when open', async () => {
    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Prompt Preview')).toBeInTheDocument();
    });
  });

  it('opens edit mode and switches between override modes', async () => {
    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
    });

    const editButton = screen.getByText('Edit');
    await act(async () => {
      fireEvent.click(editButton);
    });

    expect(screen.getByText('Override mode')).toBeInTheDocument();
    const buttons = screen.getAllByText('None (assembled)');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('saves inline override and refreshes preview', async () => {
    const mockUpdateAvatar = vi.fn().mockResolvedValue({ ...mockAvatar, systemPromptOverride: { kind: 'inline', text: 'Custom prompt' } });
    (avatarsApi.updateAvatar as any).mockImplementation(mockUpdateAvatar);
    (promptPreviewApi.fetchPromptPreview as any).mockResolvedValue(mockPreview);

    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
    });

    const editButton = screen.getByText('Edit');
    await act(async () => {
      fireEvent.click(editButton);
    });

    const customTextButtons = screen.getAllByText('Custom text');
    const customTextButton = customTextButtons[0];
    await act(async () => {
      fireEvent.click(customTextButton);
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter custom system prompt...')).toBeInTheDocument();
    });
  });

  it('saves URL override with proper update call', async () => {
    const mockUpdateAvatar = vi.fn().mockResolvedValue({ ...mockAvatar, systemPromptOverride: { kind: 'url', url: 'https://example.com/prompt.txt' } });
    (avatarsApi.updateAvatar as any).mockImplementation(mockUpdateAvatar);

    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
    });

    const editButton = screen.getByText('Edit');
    await act(async () => {
      fireEvent.click(editButton);
    });

    const urlButtons = screen.getAllByText('URL');
    const urlButton = urlButtons[0];
    await act(async () => {
      fireEvent.click(urlButton);
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('https://example.com/prompt.txt')).toBeInTheDocument();
    });
  });

  it('clears override when Clear button is clicked', async () => {
    const avatarWithOverride = { ...mockAvatar, systemPromptOverride: { kind: 'inline', text: 'Custom' } };
    (store.useActiveAvatar as any).mockReturnValue(avatarWithOverride);

    const mockUpdateAvatar = vi.fn().mockResolvedValue(mockAvatar);
    (avatarsApi.updateAvatar as any).mockImplementation(mockUpdateAvatar);

    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
    });

    const editButton = screen.getByText('Edit');
    await act(async () => {
      fireEvent.click(editButton);
    });

    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });
  });

  it('cancels edit mode without saving', async () => {
    const mockUpdateAvatar = vi.fn();
    (avatarsApi.updateAvatar as any).mockImplementation(mockUpdateAvatar);

    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
    });

    const editButton = screen.getByText('Edit');
    await act(async () => {
      fireEvent.click(editButton);
    });

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    const cancelButton = screen.getByText('Cancel');
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(mockUpdateAvatar).not.toHaveBeenCalled();
  });

  it('shows override badge when override is active', async () => {
    const avatarWithOverride = { ...mockAvatar, systemPromptOverride: { kind: 'inline', text: 'Custom' } };
    (store.useActiveAvatar as any).mockReturnValue(avatarWithOverride);

    render(<PromptPreviewPanel isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Using override: inline')).toBeInTheDocument();
    });
  });
});
