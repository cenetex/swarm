/**
 * Prompt Preview Panel - Shows what would be sent to the LLM.
 *
 * A collapsible panel that displays the system prompt, available tools,
 * and message history that would be sent to the LLM.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchPromptPreview, type PromptPreviewResponse, type ToolPreview, type SystemPromptOverride } from '../api/prompt-preview';
import { updateAvatar } from '../api/avatars';
import { useActiveAvatar, useActiveChat } from '../store';

interface PromptPreviewPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = 'prompt' | 'tools' | 'messages';

function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function ToolCard({ tool, isExpanded, onToggle }: {
  tool: ToolPreview;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden bg-[var(--color-bg-secondary)]/50">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-[var(--color-bg-tertiary)]/50 transition-colors"
      >
        <svg
          className={`w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        <span className="text-xs px-1.5 py-0.5 rounded bg-brand-900/50 text-brand-300 font-mono">
          {tool.toolset}
        </span>

        <span className="flex-1 text-sm font-medium text-[var(--color-text)] truncate">
          {tool.name}
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 py-2 border-t border-[var(--color-border)] space-y-2">
          <p className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap">
            {tool.description}
          </p>
          <details className="text-xs">
            <summary className="text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)]">
              {t('promptPreview.parametersJsonSchema')}
            </summary>
            <pre className="mt-2 p-2 rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)] overflow-x-auto text-[10px]">
              {JSON.stringify(tool.parameters, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export function PromptPreviewPanel({ isOpen, onClose }: PromptPreviewPanelProps) {
  const { t } = useTranslation();
  const activeAgent = useActiveAvatar();
  const messages = useActiveChat();

  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('prompt');
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [toolsetFilter, setToolsetFilter] = useState<string>('all');

  // System-prompt override edit state (#1531).
  const [isEditing, setIsEditing] = useState(false);
  const [editMode, setEditMode] = useState<'none' | 'inline' | 'url'>('none');
  const [editText, setEditText] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const currentOverrideKind = preview?.systemPromptOverride?.kind ?? 'none';

  const openEditor = useCallback(() => {
    const override = preview?.systemPromptOverride;
    if (override?.kind === 'inline') {
      setEditMode('inline');
      setEditText(override.text);
      setEditUrl('');
    } else if (override?.kind === 'url') {
      setEditMode('url');
      setEditText(preview?.systemPrompt ?? '');
      setEditUrl(override.url);
    } else {
      // No override today — preload the textarea with the current assembled
      // prompt so the operator has a starting point rather than a blank box.
      setEditMode('inline');
      setEditText(preview?.systemPrompt ?? '');
      setEditUrl('');
    }
    setSaveError(null);
    setIsEditing(true);
  }, [preview]);

  const cancelEditor = useCallback(() => {
    setIsEditing(false);
    setSaveError(null);
  }, []);

  const saveOverride = useCallback(async () => {
    if (!activeAgent) return;
    setIsSaving(true);
    setSaveError(null);

    let payload: { systemPromptOverride: SystemPromptOverride | null };
    if (editMode === 'none') {
      payload = { systemPromptOverride: null };
    } else if (editMode === 'inline') {
      const trimmed = editText.trim();
      if (!trimmed) {
        setSaveError(t('promptPreview.override.errorEmptyText') || 'Prompt text cannot be empty.');
        setIsSaving(false);
        return;
      }
      payload = { systemPromptOverride: { kind: 'inline', text: editText } };
    } else {
      const trimmed = editUrl.trim();
      if (!trimmed) {
        setSaveError(t('promptPreview.override.errorEmptyUrl') || 'URL cannot be empty.');
        setIsSaving(false);
        return;
      }
      try {
        // eslint-disable-next-line no-new
        new URL(trimmed);
      } catch {
        setSaveError(t('promptPreview.override.errorInvalidUrl') || 'URL is not valid.');
        setIsSaving(false);
        return;
      }
      payload = { systemPromptOverride: { kind: 'url', url: trimmed } };
    }

    try {
      await updateAvatar(activeAgent.id, payload);
      setIsEditing(false);
      await loadPreview();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, [activeAgent, editMode, editText, editUrl, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPreview = useCallback(async () => {
    if (!activeAgent) return;

    setIsLoading(true);
    setError(null);

    try {
      const history = messages
        .filter(m => m.id !== 'welcome' && !m.isLoading)
        .map(m => ({
          role: m.role as 'user' | 'assistant' | 'system' | 'tool',
          content: m.content,
        }));

      const response = await fetchPromptPreview({
        avatarId: activeAgent.id,
        history,
      });

      setPreview(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch preview';
      setError(message);
      // Clear stale preview so error state is prominent
      setPreview(null);
    } finally {
      setIsLoading(false);
    }
  }, [activeAgent, messages]);

  useEffect(() => {
    if (isOpen && activeAgent) {
      loadPreview();
    }
  }, [isOpen, activeAgent, loadPreview]);

  const toggleTool = useCallback((toolName: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  }, []);

  const filteredTools = preview?.tools.filter(
    tool => toolsetFilter === 'all' || tool.toolset === toolsetFilter
  ) || [];

  const uniqueToolsets = preview
    ? Array.from(new Set(preview.tools.map(t => t.toolset))).sort()
    : [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-4xl max-h-[85vh] lg:max-h-[80vh] bg-[var(--color-bg)] rounded-t-2xl lg:rounded-2xl shadow-xl flex flex-col overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-900/50 flex items-center justify-center">
              <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">{t('promptPreview.title')}</h2>
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {error
                  ? t('promptPreview.errorLoadingPreview')
                  : preview
                    ? `~${formatTokenCount(preview.tokenEstimate.total)} tokens`
                    : isLoading
                      ? t('common.loading')
                      : t('promptPreview.noData')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadPreview}
              disabled={isLoading}
              className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
            >
              {isLoading ? t('common.loading') : t('promptPreview.refresh')}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg-tertiary)] flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Token breakdown */}
        {preview && (
          <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 flex flex-wrap gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-400"></span>
              <span className="text-[var(--color-text-tertiary)]">{t('promptPreview.tokenBreakdown.system')}</span>
              <span className="text-[var(--color-text-secondary)]">{formatTokenCount(preview.tokenEstimate.systemPrompt)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-400"></span>
              <span className="text-[var(--color-text-tertiary)]">{t('promptPreview.tokenBreakdown.tools')}</span>
              <span className="text-[var(--color-text-secondary)]">{formatTokenCount(preview.tokenEstimate.tools)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-purple-400"></span>
              <span className="text-[var(--color-text-tertiary)]">{t('promptPreview.tokenBreakdown.messages')}</span>
              <span className="text-[var(--color-text-secondary)]">{formatTokenCount(preview.tokenEstimate.messages)}</span>
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-[var(--color-text-tertiary)]">{t('promptPreview.tokenBreakdown.toolsets')}</span>
              <span className="text-brand-400">{preview.enabledToolsets.length}</span>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-[var(--color-border)] px-4 bg-[var(--color-bg-secondary)]">
          <div className="flex gap-4">
            <button
              onClick={() => setActiveTab('prompt')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'prompt'
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {t('promptPreview.tabs.systemPrompt')}
            </button>
            <button
              onClick={() => setActiveTab('tools')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'tools'
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {t('promptPreview.tabs.tools', { count: preview?.toolCount || 0 })}
            </button>
            <button
              onClick={() => setActiveTab('messages')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'messages'
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {t('promptPreview.tabs.messages', { count: preview?.messages.length || 0 })}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {!activeAgent && (
            <div className="m-4 p-4 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t('promptPreview.noAvatarSelected')}
              </p>
            </div>
          )}

          {error && (
            <div className="m-4 p-4 rounded-lg bg-red-900/20 border border-red-900/40">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-400">{t('promptPreview.failedToLoad')}</p>
                  <p className="text-xs text-red-400/80 mt-1 break-words">{error}</p>
                  <button
                    onClick={loadPreview}
                    disabled={isLoading}
                    className="mt-2 px-3 py-1 text-xs rounded-md bg-red-900/30 hover:bg-red-900/50 text-red-300 transition-colors disabled:opacity-50"
                  >
                    {isLoading ? t('promptPreview.retrying') : t('common.retry')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {isLoading && !preview && !error && (
            <div className="p-4 text-center text-[var(--color-text-tertiary)]">
              {t('promptPreview.loadingPreview')}
            </div>
          )}

          {/* System Prompt Tab */}
          {activeTab === 'prompt' && preview && !isEditing && (
            <div className="p-4 space-y-3">
              {/* Header: override badge + edit button */}
              <div className="flex items-center justify-between gap-2">
                <div
                  className="flex items-center gap-2 text-xs"
                  data-testid="prompt-override-badge"
                  data-override-kind={currentOverrideKind}
                >
                  <span className="text-[var(--color-text-tertiary)]">
                    {t('promptPreview.override.mode') || 'Mode:'}
                  </span>
                  {currentOverrideKind === 'inline' && (
                    <span className="px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">
                      {t('promptPreview.override.inlineActive') || 'Using override: inline'}
                    </span>
                  )}
                  {currentOverrideKind === 'url' && (
                    <span
                      className="px-2 py-0.5 rounded bg-amber-900/40 text-amber-300"
                      title={preview.systemPromptOverride?.kind === 'url' ? preview.systemPromptOverride.url : ''}
                    >
                      {t('promptPreview.override.urlActive') || 'Using override: URL'}
                    </span>
                  )}
                  {currentOverrideKind === 'none' && (
                    <span className="px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]">
                      {t('promptPreview.override.templateActive') || 'Assembled template'}
                    </span>
                  )}
                </div>
                <button
                  data-testid="prompt-override-edit"
                  onClick={openEditor}
                  className="text-xs px-3 py-1 rounded-md bg-brand-900/40 hover:bg-brand-900/60 text-brand-300 transition-colors"
                >
                  {t('promptPreview.override.edit') || 'Edit'}
                </button>
              </div>

              <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono bg-[var(--color-bg-secondary)] rounded-lg p-4 overflow-x-auto">
                {preview.systemPrompt}
              </pre>
            </div>
          )}

          {/* System Prompt Tab — EDIT MODE */}
          {activeTab === 'prompt' && preview && isEditing && (
            <div className="p-4 space-y-3" data-testid="prompt-override-editor">
              {/* Mode selector */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[var(--color-text-tertiary)]">
                  {t('promptPreview.override.mode') || 'Mode:'}
                </span>
                {(['none', 'inline', 'url'] as const).map((mode) => (
                  <label key={mode} className="inline-flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="override-mode"
                      value={mode}
                      checked={editMode === mode}
                      onChange={() => setEditMode(mode)}
                      data-testid={`prompt-override-mode-${mode}`}
                    />
                    <span className="text-[var(--color-text-secondary)]">
                      {mode === 'none' && (t('promptPreview.override.modeNone') || 'None (template)')}
                      {mode === 'inline' && (t('promptPreview.override.modeInline') || 'Custom text')}
                      {mode === 'url' && (t('promptPreview.override.modeUrl') || 'URL')}
                    </span>
                  </label>
                ))}
              </div>

              {editMode === 'inline' && (
                <textarea
                  data-testid="prompt-override-text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={18}
                  className="w-full text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder={t('promptPreview.override.placeholderText') || 'Paste the full system prompt the LLM should receive.'}
                />
              )}

              {editMode === 'url' && (
                <div className="space-y-1">
                  <input
                    type="url"
                    data-testid="prompt-override-url"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="w-full text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="https://example.com/prompt.md"
                  />
                  <p className="text-[10px] text-[var(--color-text-tertiary)]">
                    {t('promptPreview.override.urlHint') || 'Fetched at request time (5s timeout, 512 KiB cap). Cached ~5 minutes per Lambda instance. Fetch failures fall back to the assembled template.'}
                  </p>
                </div>
              )}

              {editMode === 'none' && (
                <p className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] rounded-lg p-3 border border-[var(--color-border)]">
                  {t('promptPreview.override.noneDescription') || 'Saving with "None" removes any override and reverts to the prompt-builder template.'}
                </p>
              )}

              {saveError && (
                <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-md px-3 py-2" data-testid="prompt-override-error">
                  {saveError}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  data-testid="prompt-override-save"
                  onClick={saveOverride}
                  disabled={isSaving}
                  className="text-xs px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
                >
                  {isSaving
                    ? (t('common.saving') || 'Saving…')
                    : (t('common.save') || 'Save')}
                </button>
                <button
                  data-testid="prompt-override-cancel"
                  onClick={cancelEditor}
                  disabled={isSaving}
                  className="text-xs px-3 py-1.5 rounded-md bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
                >
                  {t('common.cancel') || 'Cancel'}
                </button>
              </div>
            </div>
          )}

          {/* Tools Tab */}
          {activeTab === 'tools' && preview && (
            <div className="p-4 space-y-3">
              {/* Toolset filter */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[var(--color-text-tertiary)]">{t('promptPreview.filterByToolset')}</span>
                <select
                  value={toolsetFilter}
                  onChange={(e) => setToolsetFilter(e.target.value)}
                  className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text)]"
                >
                  <option value="all">{t('promptPreview.allToolsets', { count: preview.tools.length })}</option>
                  {uniqueToolsets.map(toolset => (
                    <option key={toolset} value={toolset}>
                      {toolset} ({preview.tools.filter(t => t.toolset === toolset).length})
                    </option>
                  ))}
                </select>
              </div>

              {/* Tools list */}
              <div className="space-y-2">
                {filteredTools.map(tool => (
                  <ToolCard
                    key={tool.name}
                    tool={tool}
                    isExpanded={expandedTools.has(tool.name)}
                    onToggle={() => toggleTool(tool.name)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Messages Tab */}
          {activeTab === 'messages' && preview && (
            <div className="p-4 space-y-3">
              {preview.messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg p-3 ${
                    msg.role === 'system'
                      ? 'bg-blue-900/20 border border-blue-900/40'
                      : msg.role === 'user'
                      ? 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
                      : 'bg-[var(--color-bg-secondary)] border border-[var(--color-border)]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                      msg.role === 'system'
                        ? 'bg-blue-500/20 text-blue-400'
                        : msg.role === 'user'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-purple-500/20 text-purple-400'
                    }`}>
                      {msg.role}
                    </span>
                  </div>
                  <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap overflow-x-auto">
                    {msg.content.length > 500
                      ? `${msg.content.slice(0, 500)}...`
                      : msg.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
