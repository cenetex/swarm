/**
 * Workspace Store — controls the task workspace panel visibility and content.
 *
 * The workspace is a secondary focus surface (right panel on desktop,
 * bottom drawer on mobile) that opens from task card actions. The
 * transcript remains the primary surface; the workspace is for
 * focused interaction with a single task.
 */
import { create } from 'zustand';

export interface WorkspaceState {
  /** Whether the workspace panel is open */
  isOpen: boolean;
  /** The task card ID currently displayed in the workspace (if any) */
  activeTaskCardId: string | null;
  /** Human-readable title shown in the workspace header */
  title: string;

  /** Open the workspace for a specific task card */
  openForTask: (taskCardId: string, title: string) => void;
  /** Close the workspace */
  close: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  isOpen: false,
  activeTaskCardId: null,
  title: '',

  openForTask: (taskCardId, title) =>
    set({ isOpen: true, activeTaskCardId: taskCardId, title }),

  close: () =>
    set({ isOpen: false, activeTaskCardId: null, title: '' }),
}));
