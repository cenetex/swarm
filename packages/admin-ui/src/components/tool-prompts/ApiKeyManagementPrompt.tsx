/**
 * API Key Management Prompt - Manage API keys for avatar owners
 * Allows listing, creating, and revoking API keys for an avatar
 */
import { useState, useEffect, useCallback } from 'react';
import { useActiveAvatar } from '../../store';
import { API_BASE, type ToolPromptProps } from './types';
import { PromptError } from './PromptStatus';

interface ApiKey {
  keyPrefix: string;
  name: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt?: number;
  enabled: boolean;
}

export function ApiKeyManagementPrompt({ disabled }: ToolPromptProps) {
  const activeAvatar = useActiveAvatar();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<{ apiKey: string; keyPrefix: string } | null>(null);
  const [hasSeenNewKey, setHasSeenNewKey] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const avatarId = activeAvatar?.id;

  const fetchApiKeys = useCallback(async () => {
    if (!avatarId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/avatars/${avatarId}/api-keys`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error || `Failed to fetch API keys (HTTP ${response.status})`);
      }

      const payload = (await response.json()) as { keys: ApiKey[] };
      setApiKeys(payload.keys || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
    } finally {
      setIsLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    if (!avatarId) return;
    fetchApiKeys();
  }, [avatarId, fetchApiKeys]);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!avatarId || !newKeyName.trim()) return;

    setIsCreating(true);
    setCreateError(null);
    try {
      const response = await fetch(`${API_BASE}/avatars/${avatarId}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newKeyName.trim() }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error || `Failed to create API key (HTTP ${response.status})`);
      }

      const payload = (await response.json()) as { apiKey: string; keyPrefix: string };
      setNewlyCreatedKey(payload);
      setHasSeenNewKey(false);
      setNewKeyName('');
      setShowCreateForm(false);
      // Refresh the list
      await fetchApiKeys();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyKey = () => {
    if (newlyCreatedKey?.apiKey) {
      navigator.clipboard.writeText(newlyCreatedKey.apiKey);
      setHasSeenNewKey(true);
    }
  };

  const handleDismissNewKey = () => {
    setIsDismissing(true);
    setTimeout(() => {
      setNewlyCreatedKey(null);
      setHasSeenNewKey(false);
      setIsDismissing(false);
    }, 200);
  };

  const handleRevokeKey = async (keyPrefix: string) => {
    if (!avatarId) return;

    setIsRevoking(true);
    setRevokeError(null);
    try {
      const response = await fetch(`${API_BASE}/avatars/${avatarId}/api-keys/${encodeURIComponent(keyPrefix)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error || `Failed to revoke API key (HTTP ${response.status})`);
      }

      // Refresh the list
      await fetchApiKeys();
      setRevokeConfirm(null);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke API key');
    } finally {
      setIsRevoking(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  // Show newly created key immediately after creation
  if (newlyCreatedKey && !hasSeenNewKey) {
    return (
      <div className={`border rounded-lg p-4 space-y-3 bg-blue-500/10 border-blue-500/30 transition-opacity ${
        isDismissing ? 'opacity-0' : 'opacity-100'
      }`}>
        <div className="flex items-start gap-2">
          <div className="p-1.5 rounded-md bg-blue-500/20 mt-0.5">
            <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-blue-400">API Key Created</h4>
            <p className="text-xs text-blue-300/80 mt-1">Save this key now — it will not be shown again</p>
          </div>
        </div>

        <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
          <code className="text-xs text-[var(--color-text)] break-all font-mono block max-h-20 overflow-auto">
            {newlyCreatedKey.apiKey}
          </code>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleCopyKey}
            className="flex-1 px-3 py-2 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors"
          >
            Copy to Clipboard
          </button>
          <button
            onClick={handleDismissNewKey}
            className="flex-1 px-3 py-2 text-sm bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] rounded-lg transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="border rounded-lg p-4 bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-center">
        <div className="inline-block text-sm text-[var(--color-text-secondary)]">Loading API keys...</div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-text)]">API Key Management</h3>
        {!showCreateForm && (
          <button
            onClick={() => setShowCreateForm(true)}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-brand-600 hover:bg-brand-700 text-white rounded transition-colors disabled:opacity-50"
          >
            + Create Key
          </button>
        )}
      </div>

      {error && <PromptError message={error} />}
      {createError && <PromptError message={createError} />}
      {revokeError && <PromptError message={revokeError} />}

      {showCreateForm && (
        <form onSubmit={handleCreateKey} className="space-y-2 p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Key Name
            </label>
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="e.g., My App, Local Dev"
              className="w-full px-2 py-1.5 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-brand-500"
              autoFocus
              maxLength={100}
              disabled={isCreating}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!newKeyName.trim() || isCreating || disabled}
              className="flex-1 px-2 py-1.5 text-xs bg-brand-600 hover:bg-brand-700 text-white rounded transition-colors disabled:opacity-50"
            >
              {isCreating ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              disabled={isCreating}
              className="flex-1 px-2 py-1.5 text-xs bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {apiKeys.length === 0 ? (
          <div className="text-xs text-[var(--color-text-tertiary)] text-center py-3">
            No API keys yet. Create one to get started.
          </div>
        ) : (
          apiKeys.map((key) => (
            <div key={key.keyPrefix} className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-[var(--color-text)] truncate">{key.name}</h4>
                    {!key.enabled && (
                      <span className="px-1.5 py-0.5 text-xs font-medium bg-red-500/20 text-red-400 rounded">
                        Revoked
                      </span>
                    )}
                  </div>
                  <code className="text-xs text-[var(--color-text-secondary)] font-mono">
                    {key.keyPrefix}...
                  </code>
                </div>
                {key.enabled && !revokeConfirm && (
                  <button
                    onClick={() => setRevokeConfirm(key.keyPrefix)}
                    disabled={disabled || isRevoking}
                    className="px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </div>

              {revokeConfirm === key.keyPrefix && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-2 space-y-2">
                  <p className="text-xs text-red-300">Are you sure? Revoke "{key.name}"?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleRevokeKey(key.keyPrefix)}
                      disabled={isRevoking}
                      className="flex-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors disabled:opacity-50"
                    >
                      {isRevoking ? 'Revoking...' : 'Revoke'}
                    </button>
                    <button
                      onClick={() => setRevokeConfirm(null)}
                      disabled={isRevoking}
                      className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="text-xs text-[var(--color-text-tertiary)] space-y-0.5">
                <div>Created: {formatDate(key.createdAt)} at {formatTime(key.createdAt)} by {key.createdBy}</div>
                {key.lastUsedAt && (
                  <div>Last used: {formatDate(key.lastUsedAt)} at {formatTime(key.lastUsedAt)}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg space-y-2">
        <h4 className="text-xs font-medium text-blue-400">Usage Example</h4>
        <div className="bg-[var(--color-bg-tertiary)] rounded p-2 text-xs overflow-x-auto">
          <code className="text-[var(--color-text)]">
            {`curl https://swarm.rati.chat/api/v1/chat/completions \\
  -H "Authorization: Bearer sk-rati-..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "hello"}]
  }'`}
          </code>
        </div>
        <p className="text-xs text-blue-300">
          Scoped keys target <code className="bg-blue-500/20 px-1 rounded">{avatarId}</code> automatically — no <code className="bg-blue-500/20 px-1 rounded">model</code> field needed.
        </p>
      </div>
    </div>
  );
}
