import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaEditor } from './PersonaEditor';

const apiMocks = vi.hoisted(() => ({
  getPersona: vi.fn(),
  previewPersona: vi.fn(),
  updatePersona: vi.fn(),
}));

const i18nMocks = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => i18nMocks,
}));

vi.mock('../api/persona', () => apiMocks);

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getPersona.mockResolvedValue({
    avatarId: 'avatar-1',
    name: 'Opus',
    persona: 'Old persona',
  });
  apiMocks.previewPersona.mockResolvedValue({
    systemPrompt: 'Assembled prompt with New persona',
    diff: { added: ['New persona'], removed: ['Old persona'] },
    tokenDelta: 2,
    preview: { oldLength: 11, newLength: 11, oldTokens: 3, newTokens: 5 },
  });
  apiMocks.updatePersona.mockResolvedValue({
    avatarId: 'avatar-1',
    name: 'Opus',
    persona: 'New persona',
    updatedAt: 2,
    tokenDelta: 2,
  });
});

describe('PersonaEditor', () => {
  it('requires a preview before saving a direct persona edit', async () => {
    const onSaved = vi.fn();
    render(<PersonaEditor avatarId="avatar-1" initialPersona="Old persona" onSaved={onSaved} />);

    await waitFor(() => expect(screen.getByTestId('avatar-persona-input')).toHaveValue('Old persona'));
    const saveButton = screen.getByTestId('save-persona-button');
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('avatar-persona-input'), {
      target: { value: 'New persona' },
    });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByTestId('preview-persona-button'));
    await waitFor(() => expect(screen.getByTestId('persona-preview')).toBeInTheDocument());
    expect(apiMocks.previewPersona).toHaveBeenCalledWith('avatar-1', 'New persona');
    expect(screen.getByText('+ New persona')).toBeInTheDocument();
    expect(screen.getByText('- Old persona')).toBeInTheDocument();
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);
    await waitFor(() => expect(apiMocks.updatePersona).toHaveBeenCalledWith('avatar-1', 'New persona'));
    expect(onSaved).toHaveBeenCalledWith('New persona');
    expect(screen.getByRole('status')).toHaveTextContent('avatar.personaEditor.saved');
  });

  it('invalidates an old preview when the draft changes', async () => {
    render(<PersonaEditor avatarId="avatar-1" />);
    await waitFor(() => expect(screen.getByTestId('avatar-persona-input')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('avatar-persona-input'), {
      target: { value: 'New persona' },
    });
    fireEvent.click(screen.getByTestId('preview-persona-button'));
    await waitFor(() => expect(screen.getByTestId('save-persona-button')).toBeEnabled());

    fireEvent.change(screen.getByTestId('avatar-persona-input'), {
      target: { value: 'A different persona' },
    });

    expect(screen.queryByTestId('persona-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-persona-button')).toBeDisabled();
  });
});
