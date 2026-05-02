/**
 * TaskWorkspace — secondary focus surface for task interactions and gallery.
 *
 * Desktop: slides in as a right-side panel beside the chat transcript.
 * Mobile: slides up as a bottom drawer/sheet.
 *
 * The workspace is hidden by default and opens from explicit task card
 * actions, the gallery button, or `useWorkspaceStore.setTab(...)`.
 *
 * Renders a 5-tab shell (Gallery / Prompt / Tools / Settings / Activity).
 * Gallery and Tools are wired today; Prompt / Settings / Activity show
 * placeholders that will be replaced by #1636 / #1638 / #1639.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore, type WorkspaceTab } from '../store/workspace';
import { useTaskCardStore, type TaskCard } from '../store/task-cards';
import { ToolPrompt } from './tool-prompts';
import { PromptSuccess, PromptError } from './tool-prompts/PromptStatus';
import { getToolLabel } from './tool-prompts/tool-labels';
import type { ToolSubmitResult } from './tool-prompts/types';
import { GalleryContent } from './GalleryPanel';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import { AvatarConfigModal } from './AvatarConfigModal';
import { ActivityHealthTab } from './ActivityHealthTab';
import { useActiveAvatar } from '../store';

interface TaskWorkspaceProps {
  /** Callback when a tool prompt is submitted from within the workspace. */
  onToolSubmit?: (toolCallId: string, result: unknown) => Promise<ToolSubmitResult>;
  /**
   * Pre-filled invite code (from ?invite=DP-XXXX-XXXX query param). Forwarded
   * to ActivityHealthTab → PlanUsagePanel for one-shot redemption pre-fill (#1639).
   */
  initialInviteCode?: string;
}

interface TabDef {
  id: WorkspaceTab;
  label: string;
  /** Heroicons-style 24x24 path data. */
  iconPath: string;
}

const TABS: TabDef[] = [
  { id: 'gallery', label: 'Gallery', iconPath: 'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z' },
  { id: 'prompt', label: 'Prompt', iconPath: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10' },
  { id: 'tools', label: 'Tools', iconPath: 'M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z' },
  { id: 'settings', label: 'Settings', iconPath: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'activity', label: 'Activity', iconPath: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.281m5.94 2.28l-2.28 5.941' },
];

function TabIcon({ d }: { d: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="w-4 h-4"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

export function TaskWorkspace({ onToolSubmit, initialInviteCode }: TaskWorkspaceProps) {
  const { t } = useTranslation();
  const isOpen = useWorkspaceStore((s) => s.isOpen);
  const title = useWorkspaceStore((s) => s.title);
  const close = useWorkspaceStore((s) => s.close);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const setTab = useWorkspaceStore((s) => s.setTab);
  const activeTaskCardId = useWorkspaceStore((s) => s.activeTaskCardId);
  const galleryAvatarId = useWorkspaceStore((s) => s.galleryAvatarId);
  const openForTask = useWorkspaceStore((s) => s.openForTask);
  const size = useWorkspaceStore((s) => s.size);
  const setSize = useWorkspaceStore((s) => s.setSize);
  const toggleSize = useWorkspaceStore((s) => s.toggleSize);
  const isFullscreen = size === 'fullscreen';
  const card = useTaskCardStore((s) => activeTaskCardId ? s.cards[activeTaskCardId] : undefined);
  const allCards = useTaskCardStore((s) => s.cards);
  const activeAvatar = useActiveAvatar();
  const panelRef = useRef<HTMLDivElement>(null);

  // Pending cards for the active avatar — most recent first. Drives the
  // queue list at the top of the Tools tab (#1637).
  const pendingCards = useMemo<TaskCard[]>(() => {
    if (!activeAvatar?.id) return [];
    return Object.values(allCards)
      .filter((c) => c.avatarId === activeAvatar.id && c.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [allCards, activeAvatar?.id]);

  // Escape: in fullscreen, restore to pane; otherwise close (#1636).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isFullscreen) {
        setSize('pane');
      } else {
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close, isFullscreen, setSize]);

  // Prevent body scroll on mobile when drawer is open
  useEffect(() => {
    if (!isOpen) return;
    const mq = window.matchMedia('(max-width: 1023px)');
    if (!mq.matches) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  // Build a ToolCall object for the prompt when the card is pending
  const toolCallForPrompt = card && card.status === 'pending' ? {
    id: card.id,
    name: card.toolName,
    arguments: card.arguments,
    status: 'pending' as const,
  } : null;

  const renderPendingQueue = () => {
    if (pendingCards.length <= 1) return null;
    return (
      <div className="mb-4 -mx-1">
        <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
          Pending ({pendingCards.length})
        </div>
        <div className="flex flex-col gap-1">
          {pendingCards.map((c) => {
            const selected = c.id === activeTaskCardId;
            return (
              <button
                key={c.id}
                onClick={() => openForTask(c.id, getToolLabel(c))}
                className={[
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors text-xs',
                  selected
                    ? 'bg-brand-500/15 text-[var(--color-text)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
                ].join(' ')}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0 animate-pulse" aria-hidden />
                <span className="truncate">{getToolLabel(c)}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderToolsBody = () => {
    if (toolCallForPrompt && onToolSubmit) {
      return (
        <>
          {renderPendingQueue()}
          <ToolPrompt
            toolCall={toolCallForPrompt}
            onSubmit={onToolSubmit}
            disabled={false}
          />
        </>
      );
    }
    if (card && card.status === 'completed') {
      return (
        <div className="space-y-3">
          {renderPendingQueue()}
          <PromptSuccess message={card.summary || t('workspace.completed')} />
        </div>
      );
    }
    if (card && card.status === 'failed') {
      return (
        <div className="space-y-3">
          {renderPendingQueue()}
          <PromptError
            message={
              typeof (card.result as Record<string, unknown>)?.error === 'string'
                ? (card.result as Record<string, unknown>).error as string
                : card.summary || t('workspace.actionFailed')
            }
          />
        </div>
      );
    }
    if (card && card.status === 'cancelled') {
      return (
        <div className="space-y-3">
          {renderPendingQueue()}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)]">
            {card.summary || t('workspace.cancelled')}
          </div>
        </div>
      );
    }
    // No active card. If there's a pending queue, render the list as the
    // primary content so the user can pick one.
    if (pendingCards.length > 0) {
      return (
        <div className="space-y-1">
          <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Pending ({pendingCards.length})
          </div>
          {pendingCards.map((c) => (
            <button
              key={c.id}
              onClick={() => openForTask(c.id, getToolLabel(c))}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0 animate-pulse" aria-hidden />
              <span className="truncate flex-1">{getToolLabel(c)}</span>
              <span className="text-xs text-[var(--color-text-muted)]">Open</span>
            </button>
          ))}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3">
        <div className="w-10 h-10 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-[var(--color-text-muted)]">
            <path fillRule="evenodd" d="M6 4.75A.75.75 0 016.75 4h10.5a.75.75 0 010 1.5H6.75A.75.75 0 016 4.75zM6 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H6.75A.75.75 0 016 10zm0 5.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H6.75a.75.75 0 01-.75-.75zM1.99 4.75a1 1 0 011-1h.01a1 1 0 010 2h-.01a1 1 0 01-1-1zM2.99 9a1 1 0 000 2h.01a1 1 0 000-2h-.01zM1.99 15.25a1 1 0 011-1h.01a1 1 0 010 2h-.01a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">
          {t('workspace.noActiveTask')}
        </p>
      </div>
    );
  };

  const renderBody = () => {
    switch (activeTab) {
      case 'gallery':
        return galleryAvatarId
          ? <GalleryContent avatarId={galleryAvatarId} isOpen={isOpen} />
          : (
            <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
              No avatar selected.
            </div>
          );
      case 'tools':
        return renderToolsBody();
      case 'prompt':
        return <PromptPreviewPanel embedded isOpen={true} onClose={close} />;
      case 'settings':
        return activeAvatar
          ? <AvatarConfigModal avatar={activeAvatar} embedded isOpen={true} onClose={close} />
          : (
            <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
              No avatar selected.
            </div>
          );
      case 'activity':
        return <ActivityHealthTab onClose={close} initialInviteCode={initialInviteCode} />;
    }
  };

  return (
    <>
      {/* Backdrop — mobile drawer (always) + desktop fullscreen (#1636) */}
      <div
        className={[
          'fixed inset-0 bg-black/50 z-40',
          isFullscreen ? '' : 'lg:hidden',
        ].join(' ')}
        onClick={isFullscreen ? () => setSize('pane') : close}
        aria-hidden="true"
      />

      {/* Panel — right side on desktop, bottom drawer on mobile, full
          viewport when size === 'fullscreen' (#1636). */}
      <div
        ref={panelRef}
        role="complementary"
        aria-label="Workspace"
        className={[
          'bg-[var(--color-bg-secondary)] border-[var(--color-border)] flex flex-col',
          isFullscreen
            ? // Fullscreen: fills viewport on every breakpoint
              'fixed inset-0 z-50 max-h-none rounded-none border-0'
            : [
                // Desktop: right panel beside chat
                'lg:relative lg:w-96 lg:border-l lg:h-full',
                // Mobile: bottom drawer
                'fixed inset-x-0 bottom-0 z-50 lg:z-auto',
                'max-h-[70vh] lg:max-h-none',
                'rounded-t-2xl lg:rounded-none',
                'border-t lg:border-t-0',
                'animate-slide-up lg:animate-none',
              ].join(' '),
        ].join(' ')}
        style={{
          // iOS safe area for bottom drawer
          paddingBottom: isFullscreen ? undefined : 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Drag handle — mobile only */}
        <div className="flex justify-center pt-2 pb-1 lg:hidden">
          <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
        </div>

        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] flex-shrink-0">
          <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
            {title || t('workspace.title')}
          </h2>
          <div className="flex items-center gap-1">
            {/* Maximize / restore (#1636) */}
            <button
              type="button"
              onClick={toggleSize}
              className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              aria-label={isFullscreen ? 'Restore' : 'Maximize'}
              title={isFullscreen ? 'Restore (Esc)' : 'Maximize'}
            >
              {isFullscreen ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M8 3a.75.75 0 01.75.75v3.5a.75.75 0 01-.75.75h-3.5a.75.75 0 010-1.5h2.69L3.22 3.28a.75.75 0 011.06-1.06L7.25 5.19V2.5A.75.75 0 018 3zM12 3a.75.75 0 01.75.75v2.69l2.97-2.97a.75.75 0 011.06 1.06L13.81 7.5h2.69a.75.75 0 010 1.5h-3.5a.75.75 0 01-.75-.75v-3.5A.75.75 0 0112 3zM4.75 12.5a.75.75 0 010 1.5H7.44l-2.97 2.97a.75.75 0 01-1.06-1.06L6.38 13H4.75a.75.75 0 010-.5zM12.56 13l2.97 2.97a.75.75 0 11-1.06 1.06L11.5 14.06v2.69a.75.75 0 01-1.5 0v-3.5a.75.75 0 01.75-.75h3.5a.75.75 0 010 1.5h-1.69z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h2a.75.75 0 010 1.5h-2a.75.75 0 00-.75.75v2a.75.75 0 01-1.5 0v-2zM12.75 2a.75.75 0 010 1.5h2a.75.75 0 01.75.75v2a.75.75 0 001.5 0v-2A2.25 2.25 0 0014.75 2h-2zM3.75 12a.75.75 0 01.75.75v2c0 .414.336.75.75.75h2a.75.75 0 010 1.5h-2A2.25 2.25 0 013 14.75v-2a.75.75 0 01.75-.75zM16.25 12a.75.75 0 01.75.75v2A2.25 2.25 0 0114.75 17h-2a.75.75 0 010-1.5h2a.75.75 0 00.75-.75v-2a.75.75 0 01.75-.75z" clipRule="evenodd" />
                </svg>
              )}
            </button>
            <button
              onClick={close}
              className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              aria-label={t('workspace.closeWorkspace')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Tab strip */}
        <nav
          role="tablist"
          aria-label="Workspace tabs"
          className="flex items-stretch border-b border-[var(--color-border)] flex-shrink-0 overflow-x-auto"
        >
          {TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={selected}
                aria-controls={`workspace-panel-${tab.id}`}
                onClick={() => setTab(tab.id)}
                className={[
                  'flex-1 min-w-[64px] flex flex-col items-center justify-center gap-0.5 px-2 py-2 text-[11px] font-medium transition-colors border-b-2',
                  selected
                    ? 'text-brand-400 border-brand-500 bg-brand-500/5'
                    : 'text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
                ].join(' ')}
              >
                <TabIcon d={tab.iconPath} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Content area */}
        <div
          id={`workspace-panel-${activeTab}`}
          role="tabpanel"
          className="flex-1 overflow-y-auto px-4 py-4 flex flex-col"
        >
          {renderBody()}
        </div>
      </div>
    </>
  );
}
