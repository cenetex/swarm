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
import { useTaskCardStore, onTaskCardCreated } from './task-cards';
import { getToolLabel, isInlineOnly } from '../components/tool-prompts/tool-labels';

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
 * Workspace size mode (#1636).
 *
 * - 'pane' (default): right side panel on desktop, bottom drawer on mobile;
 *   chat transcript stays visible.
 * - 'fullscreen': fills the viewport, hides chat. Auto-engaged when entering
 *   prompt edit mode; restorable via the maximize/restore button or `Esc`.
 */
export type WorkspaceSize = 'pane' | 'fullscreen';

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
  /** Pane vs fullscreen layout (#1636) */
  size: WorkspaceSize;
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
  setTab: (tab: WorkspaceTab, avatarId?: string) => void;
  /** Set pane vs fullscreen layout (#1636). Idempotent. */
  setSize: (size: WorkspaceSize) => void;
  /** Toggle between pane and fullscreen (#1636). */
  toggleSize: () => void;
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
  size: 'pane',
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

  setTab: (tab, avatarId) => {
    const prevOpen = get().isOpen;
    const prevTab = get().activeTab;
    const nextGalleryAvatarId = avatarId ?? get().galleryAvatarId;
    // Pure tab switch — preserve task / gallery state so users can switch
    // tabs without losing their focused card or gallery scroll.
    set({
      isOpen: true,
      activeTab: tab,
      contentType: tab === 'gallery' ? 'gallery' : get().contentType,
      galleryAvatarId: nextGalleryAvatarId,
      title: TAB_TITLES[tab],
      openedAt: prevOpen && prevTab === tab ? get().openedAt : Date.now(),
    });
  },

  setSize: (size) => {
    if (get().size === size) return;
    set({ size });
  },

  toggleSize: () => {
    set((state) => ({ size: state.size === 'fullscreen' ? 'pane' : 'fullscreen' }));
  },

  close: () => {
    const cardId = get().activeTaskCardId;
    if (cardId) {
      useTaskCardStore.getState().setWorkspaceState(cardId, 'available');
    }
    set({
      isOpen: false,
      activeTab: 'tools',
      size: 'pane',
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
      size: 'pane',
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

/**
 * Auto-open the workspace Tools tab whenever a non-trivial pending task
 * card is registered (#1637). `confirm_action` and similar small inline
 * tools are exempt — they keep their inline UX.
 *
 * Subscribed at module-init so the hook is live for the full session
 * regardless of which component first imports the store.
 *
 * Deferred via microtask so synchronous follow-ups (e.g. taskAction cards
 * that immediately resolve to 'completed') can land first — we only open
 * for cards that are still pending after the current tick, and skip ones
 * the caller already directed somewhere via setWorkspaceState.
 */
onTaskCardCreated((card) => {
  if (isInlineOnly(card.toolName)) return;
  queueMicrotask(() => {
    const current = useTaskCardStore.getState().getCard(card.id);
    if (!current || current.status !== 'pending') return;
    if (current.workspaceState === 'open') return;
    useWorkspaceStore.getState().openForTask(card.id, getToolLabel(card));
  });
});
