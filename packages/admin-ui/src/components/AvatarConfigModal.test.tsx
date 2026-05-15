import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AvatarConfigModal } from './AvatarConfigModal';
import type { Avatar } from '../types';

const storeMocks = vi.hoisted(() => ({
  updateAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../store/avatars', () => ({
  useAvatarStore: () => storeMocks,
}));

vi.mock('../store/auth', () => ({
  useAuth: () => ({ gateStatus: { ownedNFTs: [] } }),
}));

vi.mock('../api/avatars', () => ({
  slotOrb: vi.fn(),
  unslotOrb: vi.fn(),
}));

vi.mock('./AvatarSidebar', () => ({
  AvatarDisplay: () => <div data-testid="avatar-display" />,
}));

vi.mock('./EnergyPanel', () => ({
  EnergyPanel: () => <div data-testid="energy-panel" />,
}));

vi.mock('./UsageMeterPanel', () => ({
  UsageMeterPanel: () => <div data-testid="usage-meter-panel" />,
}));

const avatar: Avatar = {
  id: 'avatar-1',
  name: 'Opus',
  description: 'Original description',
  persona: 'Original persona',
  secrets: [],
  createdAt: 1,
  updatedAt: 1,
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AvatarConfigModal save behavior', () => {
  it('keeps embedded settings open and turns the save button green', () => {
    const onClose = vi.fn();
    render(<AvatarConfigModal avatar={avatar} embedded isOpen={true} onClose={onClose} />);

    fireEvent.change(screen.getByTestId('avatar-name-input'), {
      target: { value: 'Updated Opus' },
    });
    fireEvent.click(screen.getByTestId('save-avatar-button'));

    expect(storeMocks.updateAvatar).toHaveBeenCalledWith('avatar-1', {
      name: 'Updated Opus',
      description: 'Original description',
      persona: 'Original persona',
      secrets: [],
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('save-avatar-button')).toHaveClass('bg-green-600');
    expect(screen.getByTestId('save-avatar-button')).toHaveTextContent('avatar.savedChanges');
  });

  it('preserves legacy modal close behavior after save', () => {
    const onClose = vi.fn();
    render(<AvatarConfigModal avatar={avatar} isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('save-avatar-button'));

    expect(storeMocks.updateAvatar).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
