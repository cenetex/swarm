/**
 * API Key Setup — shown in local/desktop mode when no API key is configured.
 */
import { useState, useEffect } from 'react';

interface LlmStatus {
  configured: boolean;
  provider: 'openrouter' | 'ollama' | null;
  selectedProvider: 'openrouter' | 'ollama' | null;
  openrouter: { configured: boolean };
  ollama: { available: boolean; model?: string; endpoint: string };
}

interface SecretStatus {
  exists?: boolean;
}

interface ApiKeySetupProps {
  onReadyChange?: (ready: boolean) => void;
}

export function ApiKeySetup({ onReadyChange }: ApiKeySetupProps) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [error, setError] = useState('');

  const configured = Boolean(status?.configured);
  const isWebLocal = typeof document !== 'undefined' && document.documentElement.dataset.swarmWebLocal === 'true';

  // Poll for provider readiness after OAuth flow or after Ollama starts.
  useEffect(() => {
    const check = async () => {
      try {
        const statusRes = await fetch('/api/llm/status');
        if (statusRes.ok) {
          const nextStatus = await statusRes.json() as LlmStatus;
          setStatus(nextStatus);
          onReadyChange?.(nextStatus.configured);
          return;
        }

        const secretRes = await fetch('/api/secrets/llm-api-key');
        if (secretRes.ok) {
          const secret = await secretRes.json() as SecretStatus;
          onReadyChange?.(Boolean(secret.exists));
        }
      } catch {
        // OAuth completion is polled; transient fetch failures are retried.
      }
    };
    const interval = setInterval(check, 2000);
    check();
    return () => clearInterval(interval);
  }, [onReadyChange]);

  if (configured) return null;
  if (isWebLocal) {
    return (
      <div className="mt-6 max-w-md mx-auto bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl p-4 text-left">
        <p className="text-sm font-medium text-[var(--color-text)] mb-2">Native app required</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          The browser-local client does not accept or persist provider credentials. Open the native app to store an API key in the local credential store, or connect to a trusted backend.
        </p>
      </div>
    );
  }

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/secrets/llm-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: apiKey.trim() }),
      });
      if (!res.ok) throw new Error('Failed to save');
      const statusRes = await fetch('/api/llm/status');
      if (statusRes.ok) {
        const nextStatus = await statusRes.json() as LlmStatus;
        setStatus(nextStatus);
        onReadyChange?.(nextStatus.configured);
      } else {
        onReadyChange?.(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const handleUseOllama = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/llm/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama' }),
      });
      if (!res.ok) throw new Error('Failed to select Ollama');
      const nextStatus = await res.json() as LlmStatus;
      setStatus(nextStatus);
      onReadyChange?.(nextStatus.configured);
      if (!nextStatus.configured) {
        setError('Ollama is not ready yet. Start Ollama and pull a chat model, then try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select Ollama');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 max-w-md mx-auto bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl p-4 text-left">
      <p className="text-sm font-medium text-[var(--color-text)] mb-2">Choose an AI provider</p>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Chat is blocked until Swarm can reach OpenRouter or a local Ollama model.
      </p>
      <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--color-text)]">Ollama</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {status?.ollama.available
                ? `Detected${status.ollama.model ? `: ${status.ollama.model}` : ''}`
                : 'Not detected on localhost:11434'}
            </p>
          </div>
          <span className={`text-xs font-medium ${status?.provider === 'ollama' ? 'text-green-400' : 'text-[var(--color-text-tertiary)]'}`}>
            {status?.provider === 'ollama' ? 'Ready' : status?.selectedProvider === 'ollama' ? 'Selected' : 'Local'}
          </span>
        </div>
        <button
          onClick={handleUseOllama}
          disabled={saving || !status?.ollama.available}
          className="mt-3 w-full px-4 py-2 text-sm bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          Use local Ollama
        </button>
      </div>
      {!isWebLocal && (
        <button onClick={() => { window.location.href = '/api/auth/openrouter'; }}
          className="w-full px-4 py-2.5 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors mb-3"
        >
          Connect with OpenRouter
        </button>
      )}
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        After authorizing, come back here — the key will be detected automatically. Or paste your API key manually:
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-or-v1-..."
          className="flex-1 px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-brand-500"
          disabled={saving}
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="px-4 py-2 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
