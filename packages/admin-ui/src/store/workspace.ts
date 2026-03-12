/**
 * Workspace Store — controls the task workspace panel visibility and content.
 *
 * The workspace is a secondary focus surface (right panel on desktop,
 * bottom drawer on mobile) that opens from task card actions. The
 * transcript remains the primary surface; the workspace is for
 * focused interaction with a single task.
 *
 * State is enriched with task lifecycle metadata so that system prompt
 * and request metadata can reflect what the user is currently focused on.
 */
import { create } from 'zustand';
import { useTaskCardStore } from './task-cards';

/** Concise snapshot of the active task for request metadata / system prompt. */
export interface ActiveTaskContext {
  taskId: string;
  toolName: string;
  status: string;
  surface: 'inline' | 'workspace';
  openedAt: number;
}

export interface WorkspaceState {
  /** Whether the workspace panel is open */
  isOpen: boolean;
  /** The task card ID currently displayed in the workspace (if any) */
  activeTaskCardId: string | null;
  /** Human-readable title shown in the workspace header */
  title: string;
  /** When the workspace was opened (ms since epoch) */
  openedAt: number | null;

  /** Open the workspace for a specific task card */
  openForTask: (taskCardId: string, title: string) => void;
  /** Close the workspace (user dismiss) */
  close: () => void;
  /** Dismiss the active task (closes workspace + marks card dismissed/cancelled) */
  dismissTask: () => void;

  /**
   * Build a concise snapshot of the active task for system prompt injection.
   * Returns null when no task is focused.
   */
  getActiveTaskContext: () => ActiveTaskContext | null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  isOpen: false,
  activeTaskCardId: null,
  title: '',
  openedAt: null,

  openForTask: (taskCardId, title) => {
    // Close any previously open task in workspace
    const prev = get().activeTaskCardId;
    if (prev && prev !== taskCardId) {
      useTaskCardStore.getState().setWorkspaceState(prev, 'available');
    }
    // Mark the new card as open in workspace
    useTaskCardStore.getState().setWorkspaceState(taskCardId, 'open');
    set({ isOpen: true, activeTaskCardId: taskCardId, title, openedAt: Date.now() });
  },

  close: () => {
    const cardId = get().activeTaskCardId;
    if (cardId) {
      useTaskCardStore.getState().setWorkspaceState(cardId, 'available');
    }
    set({ isOpen: false, activeTaskCardId: null, title: '', openedAt: null });
  },

  dismissTask: () => {
    const cardId = get().activeTaskCardId;
    if (cardId) {
      const card = useTaskCardStore.getState().getCard(cardId);
      if (card && card.status === 'pending') {
        useTaskCardStore.getState().updateStatus(cardId, 'cancelled');
      }
      useTaskCardStore.getState().setWorkspaceState(cardId, 'hidden');
    }
    set({ isOpen: false, activeTaskCardId: null, title: '', openedAt: null });
  },

  getActiveTaskContext: () => {
    const { activeTaskCardId, isOpen } = get();
    if (!activeTaskCardId) return null;
    const card = useTaskCardStore.getState().getCard(activeTaskCardId);
    if (!card) return null;
    return {
      taskId: card.id,
      toolName: card.toolName,
      status: card.status,
      surface: isOpen ? 'workspace' : 'inline',
      openedAt: get().openedAt ?? card.createdAt,
    };
  },
}));
