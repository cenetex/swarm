/**
 * Tools and Operating Principles override management panel.
 *
 * Sibling to PromptPreviewPanel - dedicated UI for managing:
 * - Tool enable/disable preferences
 * - Operating principles override
 */
import { useCallback, useEffect, useState } from 'react';
import { useActiveAvatar } from '../store';

interface ToolState {
  name: string;
  enabled: boolean;
  source: 'platform' | 'preference' | 'core';
  isCore: boolean;
}

interface ToolsAndPrinciplesPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

async function fetchTools(avatarId: string): Promise<ToolState[]> {
  const response = await fetch(`/api/avatars/${avatarId}/tools`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Failed to fetch tools');
  const data = await response.json();
  return data.state || [];
}

async function updateToolPreferences(
  avatarId: string,
  disable: string[],
  enable: string[]
): Promise<void> {
  const response = await fetch(`/api/avatars/${avatarId}/tools`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disable, enable }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to update tool preferences');
  }
}

async function deleteOperatingPrinciplesOverride(avatarId: string): Promise<void> {
  const response = await fetch(`/api/avatars/${avatarId}/operating-principles-override`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to delete override');
  }
}

async function updateOperatingPrinciplesOverride(
  avatarId: string,
  kind: 'inline' | 'url',
  text?: string,
  url?: string,
  cacheTtlSec?: number
): Promise<void> {
  const body: Record<string, unknown> = { kind };
  if (kind === 'inline' && text) body.text = text;
  if (kind === 'url' && url) {
    body.url = url;
    if (cacheTtlSec) body.cacheTtlSec = cacheTtlSec;
  }

  const response = await fetch(`/api/avatars/${avatarId}/operating-principles-override`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to update override');
  }
}

function ToolsEditor({ tools, onUpdate, isUpdating }: {
  tools: ToolState[];
  onUpdate: (disable: string[], enable: string[]) => Promise<void>;
  isUpdating: boolean;
}) {
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set());
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleToggle = (toolName: string, enabled: boolean) => {
    if (tools.find(t => t.name === toolName)?.isCore) return; // Cannot toggle core tools

    if (enabled) {
      setDisabledTools(prev => {
        const next = new Set(prev);
        next.delete(toolName);
        return next;
      });
      setEnabledTools(prev => new Set(prev)); // Remove from enabled if was there
    } else {
      setDisabledTools(prev => new Set(prev).add(toolName));
    }
  };

  const handleSave = async () => {
    setError(null);
    try {
      await onUpdate(Array.from(disabledTools), Array.from(enabledTools));
      setDisabledTools(new Set());
      setEnabledTools(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const hasChanges = disabledTools.size > 0 || enabledTools.size > 0;

  // Group tools by category
  const groupedTools: Record<string, ToolState[]> = {};
  for (const tool of tools) {
    const key = tool.source === 'core' ? 'Core Tools' : 'Available Tools';
    if (!groupedTools[key]) groupedTools[key] = [];
    groupedTools[key].push(tool);
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {Object.entries(groupedTools).map(([category, categoryTools]) => (
        <div key={category} className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase">
            {category}
          </h3>
          <div className="space-y-1">
            {categoryTools.map(tool => {
              const currentlyDisabled = disabledTools.has(tool.name);
              const isDisabledPref = tool.source === 'preference' && !tool.enabled;
              const displayDisabled = currentlyDisabled || isDisabledPref;

              return (
                <label
                  key={tool.name}
                  className={`flex items-start gap-2 p-2 rounded cursor-pointer hover:bg-[var(--color-bg-tertiary)]/50 transition-colors ${
                    tool.isCore ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!displayDisabled}
                    onChange={(e) => handleToggle(tool.name, e.target.checked)}
                    disabled={tool.isCore || isUpdating}
                    className="mt-0.5 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--color-text)]">
                        {tool.name}
                      </span>
                      {tool.isCore && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">
                          core
                        </span>
                      )}
                      {tool.source === 'platform' && !tool.isCore && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">
                          platform
                        </span>
                      )}
                      {tool.source === 'preference' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300">
                          custom
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {hasChanges && (
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={isUpdating}
            className="text-xs px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
          >
            {isUpdating ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            onClick={() => {
              setDisabledTools(new Set());
              setEnabledTools(new Set());
            }}
            disabled={isUpdating}
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function OperatingPrinciplesEditor({ onUpdate, onDelete, isUpdating }: {
  onUpdate: (kind: 'inline' | 'url', text?: string, url?: string) => Promise<void>;
  onDelete: () => Promise<void>;
  isUpdating: boolean;
}) {
  const [editMode, setEditMode] = useState<'none' | 'inline' | 'url'>('none');
  const [editText, setEditText] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (editMode === 'none') {
      try {
        await onDelete();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    } else if (editMode === 'inline' && editText.trim()) {
      try {
        await onUpdate('inline', editText);
        setEditText('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    } else if (editMode === 'url' && editUrl.trim()) {
      try {
        new URL(editUrl);
        await onUpdate('url', editUrl);
        setEditUrl('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid URL or save failed');
      }
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--color-text-tertiary)]">Mode:</span>
        {(['none', 'inline', 'url'] as const).map(mode => (
          <label key={mode} className="inline-flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="principles-mode"
              value={mode}
              checked={editMode === mode}
              onChange={(e) => setEditMode(e.target.value as typeof mode)}
            />
            <span className="text-[var(--color-text-secondary)]">
              {mode === 'none' && 'None (template)'}
              {mode === 'inline' && 'Custom text'}
              {mode === 'url' && 'URL'}
            </span>
          </label>
        ))}
      </div>

      {editMode === 'inline' && (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={10}
          className="w-full text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-brand-500"
          placeholder="Enter operating principles for the avatar..."
        />
      )}

      {editMode === 'url' && (
        <div className="space-y-1">
          <input
            type="url"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            className="w-full text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-brand-500"
            placeholder="https://example.com/principles.md"
          />
          <p className="text-[10px] text-[var(--color-text-tertiary)]">
            Fetched at request time. Cached ~5 minutes per Lambda instance.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={isUpdating}
          className="text-xs px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
        >
          {isUpdating ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export function ToolsAndPrinciplesPanel({ isOpen, onClose }: ToolsAndPrinciplesPanelProps) {
  const activeAgent = useActiveAvatar();

  const [tools, setTools] = useState<ToolState[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [activeTab, setActiveTab] = useState<'tools' | 'principles'>('tools');

  useEffect(() => {
    if (!isOpen || !activeAgent) return;

    const loadTools = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetchTools(activeAgent.id);
        setTools(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tools');
      } finally {
        setIsLoading(false);
      }
    };

    loadTools();
  }, [isOpen, activeAgent]);

  const handleUpdateTools = useCallback(
    async (disable: string[], enable: string[]) => {
      if (!activeAgent) return;
      setIsUpdating(true);
      try {
        await updateToolPreferences(activeAgent.id, disable, enable);
        const data = await fetchTools(activeAgent.id);
        setTools(data);
      } finally {
        setIsUpdating(false);
      }
    },
    [activeAgent]
  );

  const handleUpdatePrinciples = useCallback(
    async (kind: 'inline' | 'url', text?: string, url?: string) => {
      if (!activeAgent) return;
      setIsUpdating(true);
      try {
        await updateOperatingPrinciplesOverride(activeAgent.id, kind, text, url);
      } finally {
        setIsUpdating(false);
      }
    },
    [activeAgent]
  );

  const handleDeletePrinciples = useCallback(
    async () => {
      if (!activeAgent) return;
      setIsUpdating(true);
      try {
        await deleteOperatingPrinciplesOverride(activeAgent.id);
      } finally {
        setIsUpdating(false);
      }
    },
    [activeAgent]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center lg:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-2xl max-h-[75vh] lg:max-h-[70vh] bg-[var(--color-bg)] rounded-t-2xl lg:rounded-2xl shadow-xl flex flex-col overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Tools & Principles</h2>
            <p className="text-xs text-[var(--color-text-tertiary)]">Manage tool preferences and operating principles</p>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg-tertiary)] flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-[var(--color-border)] px-4 bg-[var(--color-bg-secondary)]">
          <div className="flex gap-4">
            <button
              onClick={() => setActiveTab('tools')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'tools'
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              Tools
            </button>
            <button
              onClick={() => setActiveTab('principles')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'principles'
                  ? 'border-brand-500 text-brand-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              Operating Principles
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {!activeAgent && (
            <p className="text-sm text-[var(--color-text-secondary)]">No avatar selected</p>
          )}

          {error && (
            <div className="mb-4 p-4 rounded-lg bg-red-900/20 border border-red-900/40">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {isLoading && <p className="text-sm text-[var(--color-text-tertiary)]">Loading...</p>}

          {activeTab === 'tools' && tools && !isLoading && (
            <ToolsEditor tools={tools} onUpdate={handleUpdateTools} isUpdating={isUpdating} />
          )}

          {activeTab === 'principles' && !isLoading && (
            <OperatingPrinciplesEditor onUpdate={handleUpdatePrinciples} onDelete={handleDeletePrinciples} isUpdating={isUpdating} />
          )}
        </div>
      </div>
    </div>
  );
}
