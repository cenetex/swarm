/**
 * TaskWorkspace — secondary focus surface for task interactions.
 *
 * Desktop: slides in as a right-side panel beside the chat transcript.
 * Mobile: slides up as a bottom drawer/sheet.
 *
 * The workspace is hidden by default and opens from explicit task card
 * actions. The transcript remains readable and the chat input stays
 * pinned while the workspace is open.
 */
import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../store/workspace';

export function TaskWorkspace() {
  const { isOpen, title, close, activeTaskCardId } = useWorkspaceStore();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  // Prevent body scroll on mobile when drawer is open
  useEffect(() => {
    if (!isOpen) return;
    const mq = window.matchMedia('(max-width: 1023px)');
    if (!mq.matches) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
        onClick={close}
        aria-hidden="true"
      />

      {/* Panel — right side on desktop, bottom drawer on mobile */}
      <div
        ref={panelRef}
        role="complementary"
        aria-label="Task workspace"
        className={[
          // Shared styles
          'bg-[var(--color-bg-secondary)] border-[var(--color-border)] flex flex-col',
          // Desktop: right panel beside chat
          'lg:relative lg:w-96 lg:border-l lg:h-full',
          // Mobile: bottom drawer
          'fixed inset-x-0 bottom-0 z-50 lg:z-auto',
          'max-h-[70vh] lg:max-h-none',
          'rounded-t-2xl lg:rounded-none',
          'border-t lg:border-t-0',
          // Animation
          'animate-slide-up lg:animate-none',
        ].join(' ')}
        style={{
          // iOS safe area for bottom drawer
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Drag handle — mobile only */}
        <div className="flex justify-center pt-2 pb-1 lg:hidden">
          <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
        </div>

        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] flex-shrink-0">
          <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
            {title || 'Task'}
          </h2>
          <button
            onClick={close}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            aria-label="Close workspace"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </header>

        {/* Content area — empty state for now; follow-on issues will add content */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          {activeTaskCardId ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-[var(--color-text-muted)]">
                  <path fillRule="evenodd" d="M6 4.75A.75.75 0 016.75 4h10.5a.75.75 0 010 1.5H6.75A.75.75 0 016 4.75zM6 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H6.75A.75.75 0 016 10zm0 5.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H6.75a.75.75 0 01-.75-.75zM1.99 4.75a1 1 0 011-1h.01a1 1 0 010 2h-.01a1 1 0 01-1-1zM2.99 9a1 1 0 000 2h.01a1 1 0 000-2h-.01zM1.99 15.25a1 1 0 011-1h.01a1 1 0 010 2h-.01a1 1 0 01-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <p className="text-sm text-[var(--color-text-muted)]">
                Task workspace ready
              </p>
              <p className="text-xs text-[var(--color-text-tertiary)]">
                Content for this task will appear here
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <p className="text-sm text-[var(--color-text-muted)]">
                No active task
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
