import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiKeyManagementPrompt } from './ApiKeyManagementPrompt';
import * as store from '../../store';

vi.mock('../../store', () => ({
  useActiveAvatar: vi.fn(),
}));

const mockToolCall = {
  id: 'test-tool-call',
  name: 'manage_api_keys',
  arguments: {},
};

const mockOnSubmit = vi.fn();

const mockApiKey: any = {
  keyPrefix: 'sk-rati-abc123',
  name: 'Test Key',
  createdAt: Date.now() - 86400000,
  createdBy: 'test@example.com',
  enabled: true,
};

const mockDisabledKey: any = {
  keyPrefix: 'sk-rati-xyz789',
  name: 'Revoked Key',
  createdAt: Date.now() - 172800000,
  createdBy: 'admin@example.com',
  enabled: false,
};

describe('ApiKeyManagementPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(store.useActiveAvatar).mockReturnValue({
      id: 'avatar-123',
      name: 'Test Avatar',
    } as any);
  });

  it('renders loading state initially', () => {
    global.fetch = vi.fn(() =>
      new Promise(() => {
        // Never resolve to keep loading state
      })
    );

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    expect(screen.getByText(/Loading API keys/i)).toBeInTheDocument();
  });

  it('lists existing API keys', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              keys: [mockApiKey, mockDisabledKey],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Test Key')).toBeInTheDocument();
      expect(screen.getByText('Revoked Key')).toBeInTheDocument();
    });

    expect(screen.getByText(/sk-rati-abc123/)).toBeInTheDocument();
    expect(screen.getByText(/sk-rati-xyz789/)).toBeInTheDocument();
  });

  it('shows revoked status badge for disabled keys', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              keys: [mockDisabledKey],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });
  });

  it('shows empty state when no keys exist', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              keys: [],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/No API keys yet/i)).toBeInTheDocument();
    });
  });

  it('toggles create form on button click', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('+ Create Key')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ Create Key'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e.g., My App/i)).toBeInTheDocument();
    });
  });

  it('creates a new API key', async () => {
    global.fetch = vi.fn((url, options) => {
      if (url.includes('/api-keys') && (options as RequestInit)?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              apiKey: 'sk-rati-full-secret-key-here',
              keyPrefix: 'sk-rati-full',
            }),
            { status: 201 }
          )
        );
      }
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      fireEvent.click(screen.getByText('+ Create Key'));
    });

    const nameInput = screen.getByPlaceholderText(/e.g., My App/i);
    fireEvent.change(nameInput, { target: { value: 'My New Key' } });
    fireEvent.click(screen.getByText(/^Create$/));

    await waitFor(() => {
      expect(screen.getByText('API Key Created')).toBeInTheDocument();
      expect(screen.getByText(/sk-rati-full-secret-key-here/)).toBeInTheDocument();
    });
  });

  it('shows copy button for newly created key', async () => {
    global.fetch = vi.fn((url, options) => {
      if (url.includes('/api-keys') && (options as RequestInit)?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              apiKey: 'sk-rati-secret',
              keyPrefix: 'sk-rati-123',
            }),
            { status: 201 }
          )
        );
      }
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      fireEvent.click(screen.getByText('+ Create Key'));
    });

    const nameInput = screen.getByPlaceholderText(/e.g., My App/i);
    fireEvent.change(nameInput, { target: { value: 'New Key' } });
    fireEvent.click(screen.getByText(/^Create$/));

    await waitFor(() => {
      expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
    });
  });

  it('revokes an API key with confirmation', async () => {
    global.fetch = vi.fn((url, options) => {
      if (url.includes('/api-keys') && (options as RequestInit)?.method === 'DELETE') {
        return Promise.resolve(new Response('', { status: 204 }));
      }
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [mockApiKey] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Test Key')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Revoke'));

    await waitFor(() => {
      expect(screen.getByText(/Are you sure/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/^Revoke$/));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api-keys/'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  it('displays error if key fetch fails', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
    });
  });

  it('formats dates and times correctly', async () => {
    const createdTime = new Date('2026-04-01T10:30:00');
    const keyWithTime = {
      ...mockApiKey,
      createdAt: createdTime.getTime(),
      lastUsedAt: Date.now(),
    };

    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [keyWithTime] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Test Key')).toBeInTheDocument();
    });

    // Should show creation date
    expect(screen.getByText(/Created:/)).toBeInTheDocument();
    // Should show last used
    expect(screen.getByText(/Last used:/)).toBeInTheDocument();
  });

  it('shows usage example with avatar ID', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Usage Example/i)).toBeInTheDocument();
      expect(screen.getByText(/avatar-123/)).toBeInTheDocument();
      expect(screen.getByText(/swarm.rati.chat/)).toBeInTheDocument();
    });
  });

  it('disables inputs when disabled prop is true', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/api-keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 })
        );
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    render(
      <ApiKeyManagementPrompt
        toolCall={mockToolCall}
        onSubmit={mockOnSubmit}
        disabled={true}
      />
    );

    await waitFor(() => {
      const createButton = screen.getByText('+ Create Key');
      expect(createButton).toBeDisabled();
    });
  });
});
