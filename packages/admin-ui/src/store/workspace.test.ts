import { describe, test, expect, beforeEach } from 'bun:test';
import { useWorkspaceStore } from './workspace';

describe('WorkspaceStore', () => {
  beforeEach(() => {
    // Reset to default state
    useWorkspaceStore.setState({
      isOpen: false,
      activeTaskCardId: null,
      title: '',
    });
  });

  test('starts closed with no active task', () => {
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeTaskCardId).toBeNull();
    expect(state.title).toBe('');
  });

  test('openForTask sets isOpen, activeTaskCardId, and title', () => {
    useWorkspaceStore.getState().openForTask('tc-123', 'Twitter Connect');
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTaskCardId).toBe('tc-123');
    expect(state.title).toBe('Twitter Connect');
  });

  test('close resets all state', () => {
    useWorkspaceStore.getState().openForTask('tc-123', 'Twitter Connect');
    useWorkspaceStore.getState().close();
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeTaskCardId).toBeNull();
    expect(state.title).toBe('');
  });

  test('opening a different task replaces the previous one', () => {
    useWorkspaceStore.getState().openForTask('tc-1', 'First Task');
    useWorkspaceStore.getState().openForTask('tc-2', 'Second Task');
    const state = useWorkspaceStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTaskCardId).toBe('tc-2');
    expect(state.title).toBe('Second Task');
  });
});
