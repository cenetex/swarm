import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch as fetch } from '../api/client';

type AgentBackendId =
  | 'swarm-native'
  | 'hermes'
  | 'elizaos'
  | 'milady'
  | 'claude-code'
  | 'codex'
  | 'openclaw'
  | 'cosyworld'
  | 'custom';
type AgentBackendAuthMode = 'none' | 'api-key' | 'oauth' | 'local-process';
type AgentRuntimeDeploymentTarget = 'local' | 'ascii-box';
type AgentBackendCapabilities = {
  chat: boolean;
  tools: boolean;
  memory: boolean;
  autonomousLoop: boolean;
  codeExecution: boolean;
  multimodal: boolean;
};
type AgentBackendDefinition = {
  id: AgentBackendId;
  name: string;
  description: string;
  authMode: AgentBackendAuthMode;
  requiresEndpoint: boolean;
  contextWindow: number;
  install: {
    summary: string;
    commands: string[];
    docsUrl?: string;
    endpointHint?: string;
  };
  launch?: {
    command: string;
    endpoint?: string;
    docker?: { command: string; endpoint?: string };
  };
  cloud?: Record<string, unknown>;
  capabilities: AgentBackendCapabilities;
};
type RuntimeState = {
  backend: AgentBackendId;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  command: string;
  endpoint: string;
  exitCode: number | null;
  lastError: string | null;
  supported: boolean;
};
type AgentBackendStatus = {
  selected: AgentBackendId;
  selectedBackend: AgentBackendDefinition;
  configured: boolean;
  endpoint?: string;
  hasApiKey: boolean;
  deploymentTarget: AgentRuntimeDeploymentTarget;
  scope: {
    avatarId?: string;
    label: string;
  };
  backends: AgentBackendDefinition[];
};

const capabilityLabels: Array<[keyof AgentBackendCapabilities, string]> = [
  ['chat', 'Chat'],
  ['tools', 'Tools'],
  ['memory', 'Memory'],
  ['autonomousLoop', 'Loop'],
  ['codeExecution', 'Code'],
  ['multimodal', 'Media'],
];

type AgentBackendSetupProps = {
  avatarId?: string;
  avatarName?: string;
};

export function AgentBackendSetup({ avatarId, avatarName }: AgentBackendSetupProps) {
  const [status, setStatus] = useState<AgentBackendStatus | null>(null);
  const [selected, setSelected] = useState<AgentBackendId>('swarm-native');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Runtime supervisor (launch external backends as managed child processes)
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [launchCommand, setLaunchCommand] = useState('');
  const [launchEndpoint, setLaunchEndpoint] = useState('');
  const [launchDirty, setLaunchDirty] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [terminalBusy, setTerminalBusy] = useState<string | null>(null);
  const [useDocker, setUseDocker] = useState(false);

  const selectedBackend = useMemo(
    () => status?.backends.find((backend) => backend.id === selected) ?? status?.selectedBackend,
    [selected, status],
  );
  const defaultEndpoint = selectedBackend?.launch?.endpoint ?? '';
  const effectiveEndpoint = endpoint.trim() || launchEndpoint.trim() || defaultEndpoint;
  const shouldShowManualEndpoint = Boolean(
    selectedBackend?.requiresEndpoint && !defaultEndpoint,
  );
  const scopedQuery = avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : '';
  const runtimeQuery = `backend=${encodeURIComponent(selected)}${avatarId ? `&avatarId=${encodeURIComponent(avatarId)}` : ''}`;
  const scopeLabel = avatarName || status?.scope.label || (avatarId ? `Avatar ${avatarId}` : 'New agents');

  const loadStatus = useCallback(async () => {
    const res = await fetch(`/api/agent-backends${scopedQuery}`);
    if (!res.ok) throw new Error('Failed to load agent backends');
    const nextStatus = await res.json() as AgentBackendStatus;
    setStatus(nextStatus);
    setSelected(nextStatus.selected);
    setEndpoint(nextStatus.deploymentTarget === 'local' ? nextStatus.endpoint ?? '' : '');
    setApiKey('');
  }, [scopedQuery]);

  useEffect(() => {
    loadStatus().catch(() => {
      // Older backends simply will not show this optional panel.
    });
  }, [loadStatus]);

  // Seed the editable launch command/endpoint when the selected runtime changes.
  useEffect(() => {
    if (!status) return;
    setLaunchDirty(false);
    setRuntimeError('');
    if (selected === 'swarm-native') {
      setLaunchCommand('');
      setLaunchEndpoint('');
      setRuntime(null);
      setLogs([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/runtime/status?${runtimeQuery}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((next: RuntimeState | null) => {
        if (cancelled || !next) return;
        setLaunchCommand(next.command ?? '');
        setLaunchEndpoint(next.endpoint ?? '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runtimeQuery, selected, status]);

  // Poll live runtime status + logs for the selected backend.
  useEffect(() => {
    if (!status || selected === 'swarm-native') return;
    let cancelled = false;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const [sRes, lRes] = await Promise.all([
          fetch(`/api/runtime/status?${runtimeQuery}`),
          fetch(`/api/runtime/logs?${runtimeQuery}`),
        ]);
        if (cancelled) return;
        if (sRes.ok) setRuntime((await sRes.json()) as RuntimeState);
        if (lRes.ok) {
          const body = (await lRes.json()) as { logs?: string[] };
          if (!cancelled) setLogs(body.logs ?? []);
        }
      } catch {
        /* older sidecar without runtime routes — panel stays inert */
      }
    };
    refresh();
    const id = setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runtimeQuery, selected, status]);

  if (!status || !selectedBackend) return null;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/agent-backends/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatarId,
          backend: selected,
          deploymentTarget: 'local',
          endpoint: selectedBackend.requiresEndpoint ? effectiveEndpoint : undefined,
          apiKey: apiKey.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Failed to save backend');
      }
      const nextStatus = await res.json() as AgentBackendStatus;
      setStatus(nextStatus);
      setSelected(nextStatus.selected);
      setEndpoint(nextStatus.deploymentTarget === 'local' ? nextStatus.endpoint ?? '' : '');
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save backend');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/agent-backends/select${scopedQuery}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to reset backend');
      const nextStatus = await res.json() as AgentBackendStatus;
      setStatus(nextStatus);
      setSelected(nextStatus.selected);
      setEndpoint(nextStatus.deploymentTarget === 'local' ? nextStatus.endpoint ?? '' : '');
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset backend');
    } finally {
      setSaving(false);
    }
  };

  const runtimeAction = async (action: 'start' | 'stop' | 'restart') => {
    setRuntimeBusy(true);
    setRuntimeError('');
    try {
      const res = await fetch(`/api/runtime/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatarId,
          backend: selected,
          command: launchCommand.trim(),
          endpoint: effectiveEndpoint || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as RuntimeState & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed to ${action} runtime`);
      setRuntime(body);
      setLaunchDirty(false);
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : `Failed to ${action} runtime`);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const copyCommand = async (command: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else {
        const ta = document.createElement('textarea');
        ta.value = command;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(command);
      setTimeout(() => setCopied((c) => (c === command ? null : c)), 1500);
    } catch {
      setRuntimeError('Copy failed — try selecting the text manually.');
    }
  };

  const runInTerminal = async (command: string) => {
    setTerminalBusy(command);
    setRuntimeError('');
    try {
      const res = await fetch('/api/runtime/open-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to open terminal');
      }
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : 'Failed to open terminal');
    } finally {
      setTerminalBusy(null);
    }
  };

  const applyLaunchTemplate = (docker: boolean) => {
    const l = selectedBackend.launch;
    if (docker) {
      setLaunchCommand(l?.docker?.command ?? 'docker run --rm -p 8080:8080 your-image');
      setLaunchEndpoint(l?.docker?.endpoint ?? l?.endpoint ?? launchEndpoint);
    } else {
      setLaunchCommand(l?.command ?? '');
      setLaunchEndpoint(l?.endpoint ?? '');
    }
    setLaunchDirty(true);
  };

  const toggleDocker = () => {
    const next = !useDocker;
    setUseDocker(next);
    applyLaunchTemplate(next);
  };

  const resetLaunchToDefault = async () => {
    setRuntimeBusy(true);
    setRuntimeError('');
    try {
      const res = await fetch(`/api/runtime/launch?${runtimeQuery}`, {
        method: 'DELETE',
      });
      const body = (await res.json().catch(() => ({}))) as RuntimeState & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Failed to reset');
      setUseDocker(false);
      setLaunchCommand(body.command ?? '');
      setLaunchEndpoint(body.endpoint ?? '');
      setLaunchDirty(false);
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setRuntimeBusy(false);
    }
  };

  const formatUptime = (startedAt: number | null): string => {
    if (!startedAt) return '';
    const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const isRunning = Boolean(runtime?.running);
  const canLaunch = selectedBackend.id !== 'swarm-native';

  const capabilities = capabilityLabels
    .filter(([key]) => selectedBackend.capabilities[key])
    .map(([, label]) => label);
  const isDirty = selected !== status.selected ||
    (shouldShowManualEndpoint && endpoint.trim() !== (status.endpoint ?? '')) ||
    apiKey.trim().length > 0;
  const canSave = isDirty;

  return (
    <div className="mt-4 max-w-3xl mx-auto bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl p-4 text-left">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--color-text)]">Agent runtime</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {scopeLabel}: {selectedBackend.name} with a {selectedBackend.contextWindow.toLocaleString()} token base context.
          </p>
        </div>
        <span className={`text-xs font-medium ${status.configured ? 'text-green-400' : 'text-amber-400'}`}>
          {status.configured ? 'Configured' : 'Needs endpoint'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">Runtime</span>
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value as AgentBackendId);
              setEndpoint('');
              setApiKey('');
              setError('');
            }}
            disabled={saving}
            className="mt-1 w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] focus:outline-none focus:border-brand-500"
          >
            {status.backends.map((backend) => (
              <option key={backend.id} value={backend.id}>{backend.name}</option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="px-4 py-2 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleReset}
            disabled={saving || status.selected === 'swarm-native'}
            className="px-4 py-2 text-sm bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            Reset
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs text-[var(--color-text-muted)]">{selectedBackend.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {capabilities.map((capability) => (
          <span
            key={capability}
            className="px-2 py-1 rounded-md bg-[var(--color-bg-secondary)] text-[11px] font-medium text-[var(--color-text-secondary)] border border-[var(--color-border)]"
          >
            {capability}
          </span>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">Install help</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{selectedBackend.install.summary}</p>
          </div>
          {selectedBackend.install.docsUrl && (
            <a
              href={selectedBackend.install.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-brand-400 hover:text-brand-300 whitespace-nowrap"
            >
              Docs
            </a>
          )}
        </div>
        {selectedBackend.install.commands.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {selectedBackend.install.commands.map((command) => (
              <div key={command} className="flex items-center gap-2">
                <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
                  {command}
                </code>
                <button
                  type="button"
                  onClick={() => copyCommand(command)}
                  className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
                >
                  {copied === command ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={() => runInTerminal(command)}
                  disabled={terminalBusy === command}
                  title="Open Terminal and run this command"
                  className="shrink-0 rounded-md border border-brand-500/40 bg-brand-500/10 px-2 py-1.5 text-[11px] text-brand-300 transition-colors hover:bg-brand-500/20 disabled:opacity-50"
                >
                  {terminalBusy === command ? 'Opening…' : 'Run ▸'}
                </button>
              </div>
            ))}
          </div>
        )}
        {selectedBackend.install.endpointHint && (
          <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">{selectedBackend.install.endpointHint}</p>
        )}
      </div>

      {canLaunch && (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-[var(--color-text-secondary)]">Launch runtime</p>
              <button
                type="button"
                onClick={toggleDocker}
                disabled={runtimeBusy}
                title="Toggle a containerized (docker run) launch template"
                className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                  useDocker
                    ? 'border-brand-500/50 bg-brand-500/15 text-brand-300'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                Docker {useDocker ? 'on' : 'off'}
              </button>
            </div>
            <span className={`flex items-center gap-1.5 text-xs font-medium ${isRunning ? 'text-green-400' : 'text-[var(--color-text-muted)]'}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${isRunning ? 'bg-green-400' : 'bg-[var(--color-text-tertiary)]'}`} />
              {isRunning
                ? `running · pid ${runtime?.pid ?? '?'} · ${formatUptime(runtime?.startedAt ?? null)}`
                : runtime?.exitCode != null
                  ? `stopped · exit ${runtime.exitCode}`
                  : 'stopped'}
            </span>
          </div>

          <label className="mt-3 block">
            <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">Launch command</span>
            <input
              value={launchCommand}
              onChange={(e) => { setLaunchCommand(e.target.value); setLaunchDirty(true); }}
              placeholder="e.g. hermes serve --port 7331"
              disabled={runtimeBusy}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:border-brand-500 focus:outline-none"
            />
          </label>
          <label className="mt-2 block">
            <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">Endpoint</span>
            {defaultEndpoint ? (
              <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                {effectiveEndpoint}
              </div>
            ) : (
              <input
                value={launchEndpoint}
                onChange={(e) => { setLaunchEndpoint(e.target.value); setLaunchDirty(true); }}
                placeholder="http://localhost:7331"
                disabled={runtimeBusy}
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:border-brand-500 focus:outline-none"
              />
            )}
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isRunning ? (
              <button
                type="button"
                onClick={() => runtimeAction('stop')}
                disabled={runtimeBusy}
                className="rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
              >
                {runtimeBusy ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => runtimeAction('start')}
                disabled={runtimeBusy || !launchCommand.trim()}
                className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
              >
                {runtimeBusy ? 'Starting…' : 'Start'}
              </button>
            )}
            <button
              type="button"
              onClick={() => runtimeAction('restart')}
              disabled={runtimeBusy || !launchCommand.trim()}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
            >
              Restart
            </button>
            {launchDirty && <span className="text-[11px] text-amber-400">edited — Start/Restart to apply</span>}
            <button
              type="button"
              onClick={resetLaunchToDefault}
              disabled={runtimeBusy}
              className="ml-auto text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline disabled:opacity-50"
            >
              Reset to default
            </button>
          </div>

          {runtime?.lastError && <p className="mt-2 text-[11px] text-red-400">{runtime.lastError}</p>}

          {logs.length > 0 && (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              {logs.join('\n')}
            </pre>
          )}
        </div>
      )}

      {selectedBackend.requiresEndpoint && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {shouldShowManualEndpoint && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                Endpoint
              </span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="http://localhost:7331"
                disabled={saving}
                className="mt-1 w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-brand-500"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={status.hasApiKey ? 'Saved' : 'Optional'}
              disabled={saving}
              className="mt-1 w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-brand-500"
            />
          </label>
        </div>
      )}

      {selectedBackend.authMode === 'local-process' && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Local process adapters are registered now; execution wiring is handled by the selected runtime adapter.
        </p>
      )}

      {runtimeError && <p className="text-xs text-red-400 mt-3">{runtimeError}</p>}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
