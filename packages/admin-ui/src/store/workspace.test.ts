import { describe, test, expect, beforeEach } from 'bun:test';
import { useWorkspaceStore } from './workspace';
import { useTaskCardStore } from './task-cards';

describe('WorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      isOpen: false,
      activeTab: 'tools',
      contentType: 'task',
      activeTaskCardId: null,
      galleryAvatarId: null,
      title: '',
      openedAt: null,
    });
    useTaskCardStore.setState({ cards: {} });
  });

  test('starts closed with no active task', () => {
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeTab).toBe('tools');
    expect(state.contentType).toBe('task');
    expect(state.activeTaskCardId).toBeNull();
    expect(state.galleryAvatarId).toBeNull();
    expect(state.title).toBe('');
    expect(state.openedAt).toBeNull();
  });

  test('openForTask sets isOpen, activeTaskCardId, title, openedAt, and selects Tools tab', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-123', avatarId: 'a1', toolName: 'request_secret', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-123', 'Secret Input');
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTab).toBe('tools');
    expect(state.contentType).toBe('task');
    expect(state.activeTaskCardId).toBe('tc-123');
    expect(state.title).toBe('Secret Input');
    expect(state.openedAt).toBeGreaterThan(0);
  });

  test('openForTask updates task card workspaceState to open', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Confirm');
    const card = useTaskCardStore.getState().getCard('tc-1');
    expect(card?.workspaceState).toBe('open');
  });

  test('close resets state and sets card workspaceState to available', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Confirm');
    useWorkspaceStore.getState().close();

    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeTab).toBe('tools');
    expect(state.activeTaskCardId).toBeNull();
    expect(state.openedAt).toBeNull();

    const card = useTaskCardStore.getState().getCard('tc-1');
    expect(card?.workspaceState).toBe('available');
  });

  test('dismissTask cancels pending card and hides it', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'request_secret', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Secret');
    useWorkspaceStore.getState().dismissTask();

    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(false);

    const card = useTaskCardStore.getState().getCard('tc-1');
    expect(card?.status).toBe('cancelled');
    expect(card?.workspaceState).toBe('hidden');
  });

  test('opening a different task sets previous card to available', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-2', avatarId: 'a1', toolName: 'request_secret', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'First');
    useWorkspaceStore.getState().openForTask('tc-2', 'Second');

    expect(useTaskCardStore.getState().getCard('tc-1')?.workspaceState).toBe('available');
    expect(useTaskCardStore.getState().getCard('tc-2')?.workspaceState).toBe('open');
    expect(useWorkspaceStore.getState().activeTaskCardId).toBe('tc-2');
  });

  test('getActiveTaskContext returns null when no task is active', () => {
    expect(useWorkspaceStore.getState().getActiveTaskContext()).toBeNull();
  });

  test('getActiveTaskContext returns snapshot when task is open', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'request_secret', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Secret');
    const ctx = useWorkspaceStore.getState().getActiveTaskContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.taskId).toBe('tc-1');
    expect(ctx!.toolName).toBe('request_secret');
    expect(ctx!.status).toBe('pending');
    expect(ctx!.surface).toBe('workspace');
    expect(ctx!.openedAt).toBeGreaterThan(0);
  });

  test('openGallery selects Gallery tab and sets avatarId', () => {
    useWorkspaceStore.getState().openGallery('avatar-123');
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTab).toBe('gallery');
    expect(state.contentType).toBe('gallery');
    expect(state.galleryAvatarId).toBe('avatar-123');
    expect(state.activeTaskCardId).toBeNull();
    expect(state.title).toBe('Gallery');
  });

  test('openGallery toggles off when Gallery tab is already open', () => {
    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useWorkspaceStore.getState().isOpen).toBe(true);

    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useWorkspaceStore.getState().isOpen).toBe(false);
    expect(useWorkspaceStore.getState().galleryAvatarId).toBeNull();
  });

  test('openGallery from a non-gallery tab switches without toggling closed', () => {
    useWorkspaceStore.getState().setTab('settings');
    expect(useWorkspaceStore.getState().activeTab).toBe('settings');

    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useWorkspaceStore.getState().isOpen).toBe(true);
    expect(useWorkspaceStore.getState().activeTab).toBe('gallery');
  });

  test('openGallery releases any active task card', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Task');
    expect(useTaskCardStore.getState().getCard('tc-1')?.workspaceState).toBe('open');

    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useTaskCardStore.getState().getCard('tc-1')?.workspaceState).toBe('available');
    expect(useWorkspaceStore.getState().activeTab).toBe('gallery');
  });

  test('openForTask clears gallery state', () => {
    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useWorkspaceStore.getState().activeTab).toBe('gallery');

    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });
    useWorkspaceStore.getState().openForTask('tc-1', 'Task');

    const state = useWorkspaceStore.getState();
    expect(state.activeTab).toBe('tools');
    expect(state.galleryAvatarId).toBeNull();
    expect(state.activeTaskCardId).toBe('tc-1');
  });

  test('getActiveTaskContext returns null when gallery is open', () => {
    useWorkspaceStore.getState().openGallery('avatar-123');
    expect(useWorkspaceStore.getState().getActiveTaskContext()).toBeNull();
  });

  test('setTab opens the workspace and switches tab', () => {
    useWorkspaceStore.getState().setTab('settings');
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTab).toBe('settings');
    expect(state.title).toBe('Settings');
    expect(state.openedAt).toBeGreaterThan(0);
  });

  test('setTab preserves an active task card across tab switches', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1', avatarId: 'a1', toolName: 'confirm_action', arguments: {},
    });

    useWorkspaceStore.getState().openForTask('tc-1', 'Task');
    useWorkspaceStore.getState().setTab('settings');

    const state = useWorkspaceStore.getState();
    expect(state.activeTab).toBe('settings');
    expect(state.activeTaskCardId).toBe('tc-1'); // preserved
    expect(useTaskCardStore.getState().getCard('tc-1')?.workspaceState).toBe('open');
  });

  test('setTab preserves galleryAvatarId across tab switches', () => {
    useWorkspaceStore.getState().openGallery('avatar-123');
    useWorkspaceStore.getState().setTab('prompt');

    const state = useWorkspaceStore.getState();
    expect(state.activeTab).toBe('prompt');
    expect(state.galleryAvatarId).toBe('avatar-123'); // preserved
  });

  test('setTab to all five tabs sets the corresponding title', () => {
    const cases: Array<{ tab: 'gallery' | 'prompt' | 'tools' | 'settings' | 'activity'; title: string }> = [
      { tab: 'gallery', title: 'Gallery' },
      { tab: 'prompt', title: 'Prompt' },
      { tab: 'tools', title: 'Tools' },
      { tab: 'settings', title: 'Settings' },
      { tab: 'activity', title: 'Activity' },
    ];
    for (const { tab, title } of cases) {
      useWorkspaceStore.getState().setTab(tab);
      expect(useWorkspaceStore.getState().activeTab).toBe(tab);
      expect(useWorkspaceStore.getState().title).toBe(title);
    }
  });
});
