import { beforeEach, describe, expect, it } from 'vitest';
import { useAvatarStore } from './avatars';

beforeEach(() => {
  useAvatarStore.setState({
    avatars: [],
    chats: {},
    activeAvatarId: null,
    isLoading: false,
    error: null,
  });
});

describe('useAvatarStore.applyAvatarUpdates', () => {
  it('updates avatar name, profile image, and welcome message immediately', () => {
    useAvatarStore.setState({
      avatars: [{
        id: 'avatar-1',
        name: 'Avatar 1',
        avatar: 'old.png',
        secrets: [],
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
      }],
      chats: {
        'avatar-1': [{
          id: 'welcome',
          role: 'assistant',
          content: "Hi! I'm **Avatar 1**. Talk to me to configure my integrations!",
          timestamp: 1,
        }],
      },
      activeAvatarId: 'avatar-1',
      isLoading: false,
      error: null,
    });

    useAvatarStore.getState().applyAvatarUpdates('avatar-1', {
      name: 'Mika',
      profileImageUrl: 'new.png',
    });

    const avatar = useAvatarStore.getState().avatars[0];
    expect(avatar.name).toBe('Mika');
    expect(avatar.avatar).toBe('new.png');
    expect(useAvatarStore.getState().chats['avatar-1'][0].content).toContain("I'm **Mika**");
  });
});
