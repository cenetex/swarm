/**
 * Workspace Store — controls the right-pane workspace visibility, tab, and content.
 *
 * The workspace is a secondary focus surface (right panel on desktop,
 * bottom drawer on mobile) with five tabs: Gallery, Prompt, Tools,
 * Settings, Activity. The transcript remains the primary surface; the
 * workspace is for focused interaction.
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

/**
 * Tabs surfaced in the workspace header.
 *
 * - 'gallery'  — avatar media gallery (existing)
 * - 'prompt'   — system-prompt / persona editor (#1636)
 * - 'tools'    — pending tool prompts (#1637)
 * - 'settings' — persistent avatar config (#1638)
 * - 'activity' — usage, plan, health, activation (#1639)
 */
export type WorkspaceTab = 'gallery' | 'prompt' | 'tools' | 'settings' | 'activity';

/**
 * Legacy content selector for the tools/task body. Kept distinct from
 * `activeTab` because a focused task card is internal state ("which card
 * fills the Tools body"), not a tab selection. Removed once #1637 lands.
 */
export type WorkspaceContentType = 'task' | 'gallery';

export interface WorkspaceState {
  /** Whether the workspace panel is open */
  isOpen: boolean;
  /** Which tab is currently selected */
  activeTab: WorkspaceTab;
  /**
   * @deprecated retained for callers that still discriminate task vs
   * gallery body without consulting `activeTab`. Will be removed once
   * #1637 (auto-open tool prompts) lands.
   */
  contentType: WorkspaceContentType;
  /** The task card ID currently displayed in the Tools tab (if any) */
  activeTaskCardId: string | null;
  /** Avatar ID for gallery content (when Gallery tab is active) */
  galleryAvatarId: string | null;
  /** Human-readable title shown in the workspace header */
  title: string;
  /** When the workspace was opened (ms since epoch) */
  openedAt: number | null;

  /** Open the workspace for a specific task card (selects Tools tab) */
  openForTask: (taskCardId: string, title: string) => void;
  /** Open the workspace showing gallery content (toggles closed if Gallery tab is already active) */
  openGallery: (avatarId: string) => void;
  /** Switch to a tab, opening the workspace if closed. Preserves task / gallery state. */
  setTab: (tab: WorkspaceTab) => void;
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

const TAB_TITLES: Record<WorkspaceTab, string> = {
  gallery: 'Gallery',
  prompt: 'Prompt',
  tools: 'Tools',
  settings: 'Settings',
  activity: 'Activity',
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  isOpen: false,
  activeTab: 'tools',
  contentType: 'task',
  activeTaskCardId: null,
  galleryAvatarId: null,
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
    set({
      isOpen: true,
      activeTab: 'tools',
      contentType: 'task',
      activeTaskCardId: taskCardId,
      galleryAvatarId: null,
      title,
      openedAt: Date.now(),
    });
  },

  openGallery: (avatarId) => {
    // Release any previously open task card
    const prev = get().activeTaskCardId;
    if (prev) {
      useTaskCardStore.getState().setWorkspaceState(prev, 'available');
    }
    // Toggle: if Gallery tab is already showing, close the workspace
    if (get().isOpen && get().activeTab === 'gallery') {
      set({
        isOpen: false,
        activeTab: 'tools',
        contentType: 'task',
        activeTaskCardId: null,
        galleryAvatarId: null,
        title: '',
        openedAt: null,
      });
      return;
    }
    set({
      isOpen: true,
      activeTab: 'gallery',
      contentType: 'gallery',
      activeTaskCardId: null,
      galleryAvatarId: avatarId,
      title: TAB_TITLES.gallery,
      openedAt: Date.now(),
    });
  },

  setTab: (tab) => {
    const prevOpen = get().isOpen;
    const prevTab = get().activeTab;
    // Pure tab switch — preserve task / gallery state so users can switch
    // tabs without losing their focused card or gallery scroll.
    set({
      isOpen: true,
      activeTab: tab,
      title: TAB_TITLES[tab],
      openedAt: prevOpen && prevTab === tab ? get().openedAt : Date.now(),
    });
  },

  close: () => {
    const cardId = get().activeTaskCardId;
    if (cardId) {
      useTaskCardStore.getState().setWorkspaceState(cardId, 'available');
    }
    set({
      isOpen: false,
      activeTab: 'tools',
      contentType: 'task',
      activeTaskCardId: null,
      galleryAvatarId: null,
      title: '',
      openedAt: null,
    });
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
    set({
      isOpen: false,
      activeTab: 'tools',
      contentType: 'task',
      activeTaskCardId: null,
      galleryAvatarId: null,
      title: '',
      openedAt: null,
    });
  },

  getActiveTaskContext: () => {
    const { activeTaskCardId, isOpen, activeTab } = get();
    if (!activeTaskCardId || activeTab !== 'tools') return null;
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
