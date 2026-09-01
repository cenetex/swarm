import { useEffect, useState } from 'react';
import {
  getHostingStatus,
  getHostingSubstratesStatus,
  provisionHostedSwarm,
  selectHostingSubstrate,
  setHostingMode,
  type HostingMode,
  type HostingStatus,
  type HostingSubstrateProvider,
  type HostingSubstratesStatus,
} from '../api/hosting';

function statusLabel(status: HostingStatus): string {
  if (status.mode === 'hosted') return 'Hosted';
  return status.local.running ? 'Running locally' : 'Local';
}

function hostedStateLabel(status: HostingStatus): string {
  switch (status.hosted.status) {
    case 'active':
      return 'Active';
    case 'requested':
      return 'Request pending';
    case 'provisioning':
      return 'Setting up';
    case 'stopped':
      return 'Paused';
    case 'error':
      return 'Needs attention';
    case 'available':
      return 'Available';
    default:
      return 'Ready';
  }
}

function hostedSecondaryLabel(status: HostingStatus | null): string {
  switch (status?.hosted.status) {
    case 'active':
      return 'Online';
    case 'requested':
      return 'Request pending';
    case 'provisioning':
      return 'Setting up';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Needs attention';
    case 'available':
      return 'Available';
    default:
      return 'Ready';
  }
}

export function hostedBillingLabel(status: HostingStatus['hosted']['billing']['status']): string {
  switch (status) {
    case 'eligible':
      return 'Not subscribed';
    case 'checkout-pending':
      return 'Checkout pending confirmation';
    case 'paid':
      return 'Payment confirmed';
    case 'cancellation-pending':
      return 'Cancellation pending';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Payment failed';
  }
}

export function hostedRuntimeLabel(status: HostingStatus['hosted']['runtime']['status']): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'provisioning':
      return 'Provisioning';
    case 'health-checking':
      return 'Checking health';
    case 'active':
      return 'Healthy';
    case 'stopped':
      return 'Stopped';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
  }
}

export function HostingModePanel() {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [busy, setBusy] = useState<HostingMode | 'provision' | null>(null);
  const [substrates, setSubstrates] = useState<HostingSubstratesStatus | null>(null);
  const [substrateBusy, setSubstrateBusy] = useState<HostingSubstrateProvider | 'refresh' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getHostingStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load hosting status');
      });
    getHostingSubstratesStatus()
      .then((next) => {
        if (!cancelled) setSubstrates(next);
      })
      .catch(() => {
        if (!cancelled) setSubstrates({ providers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseMode = async (mode: HostingMode) => {
    setBusy(mode);
    setError('');
    try {
      const next = await setHostingMode(mode);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to switch to ${mode}`);
    } finally {
      setBusy(null);
    }
  };

  const refreshSubstrates = async () => {
    setSubstrateBusy('refresh');
    setError('');
    try {
      setSubstrates(await getHostingSubstratesStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh substrates');
    } finally {
      setSubstrateBusy(null);
    }
  };

  const chooseSubstrate = async (provider: HostingSubstrateProvider) => {
    setSubstrateBusy(provider);
    setError('');
    try {
      setSubstrates(await selectHostingSubstrate(provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select substrate');
    } finally {
      setSubstrateBusy(null);
    }
  };

  const provisionHosted = async () => {
    setBusy('provision');
    setError('');
    try {
      const next = await provisionHostedSwarm();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start hosted Swarm');
    } finally {
      setBusy(null);
    }
  };

  const activeMode = status?.mode ?? 'local';
  const hostedDisabled = !status?.hosted.available;
  const hostedBusy = busy === 'hosted' || busy === 'provision';
  const hostedSubscribed = status?.hosted.billing.status === 'paid';

  return (
    <div className="mt-4 max-w-3xl mx-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-4 text-left">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--color-text)]">Run Swarm</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {status ? statusLabel(status) : 'Checking runtime mode'}
          </p>
        </div>
        <span className={`text-xs font-medium ${activeMode === 'hosted' ? 'text-green-400' : 'text-brand-300'}`}>
          {activeMode === 'hosted' && status ? hostedStateLabel(status) : 'This device'}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <button
          type="button"
          onClick={() => chooseMode('local')}
          disabled={busy !== null}
          className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
            activeMode === 'local'
              ? 'border-brand-500/60 bg-brand-500/15'
              : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-elevated)]'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--color-text)]">{status?.local.label ?? 'This device'}</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">Free</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {status?.local.detail ?? 'Runs while this app is open.'}
          </p>
        </button>

        <button
          type="button"
          onClick={() => chooseMode('hosted')}
          disabled={busy !== null || hostedDisabled}
          className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            activeMode === 'hosted'
              ? 'border-green-500/60 bg-green-500/15'
              : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-elevated)]'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--color-text)]">{status?.hosted.label ?? 'Hosted 24/7'}</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              ${status?.hosted.priceUsdMonthly ?? 9}/mo
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {status?.hosted.detail ?? 'We keep your avatar online even when this app is closed.'}
          </p>
        </button>
      </div>

      {status ? (
        <div className="mt-3 grid gap-2 text-[11px] text-[var(--color-text-muted)] sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2">
            <span className="text-[var(--color-text-tertiary)]">Billing</span>
            <span className="ml-2 font-medium text-[var(--color-text-secondary)]">
              {hostedBillingLabel(status.hosted.billing.status)}
            </span>
          </div>
          <div className="rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2">
            <span className="text-[var(--color-text-tertiary)]">Runtime</span>
            <span className="ml-2 font-medium text-[var(--color-text-secondary)]">
              {hostedRuntimeLabel(status.hosted.runtime.status)}
            </span>
          </div>
        </div>
      ) : null}

      {hostedSubscribed ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled
            className="rounded-lg bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-300 disabled:opacity-100"
          >
            Subscribed
          </button>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            {status?.hosted.modelWorkAllowed ? 'Hosted runtime is online' : 'Waiting for a healthy hosted runtime'}
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={provisionHosted}
            disabled={hostedBusy || hostedDisabled}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {hostedBusy ? 'Starting...' : 'Start hosted'}
          </button>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            {hostedSecondaryLabel(status)}
          </span>
        </div>
      )}

      <div className="mt-4 border-t border-[var(--color-border)] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">BYO substrate</p>
            <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
              Connect a substrate for BYO provisioning.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshSubstrates}
            disabled={substrateBusy !== null}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
          >
            {substrateBusy === 'refresh' ? 'Checking...' : 'Refresh'}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-[repeat(3,minmax(13rem,1fr))] gap-2 overflow-x-auto pb-1">
          {(substrates?.providers ?? []).map((provider) => {
            const selected = substrates?.selected === provider.id;
            const ready = provider.authenticated;
            const canConnect = !ready && Boolean(provider.connectUrl);
            const statusText = ready
              ? 'Signed in'
              : provider.cliInstalled
                ? 'Sign in'
                : canConnect
                  ? 'Setup needed'
                  : 'CLI missing';
            return (
              <div
                key={provider.id}
                className={`flex min-w-0 flex-col rounded-lg border p-3 ${
                  selected
                    ? 'border-brand-500/60 bg-brand-500/15'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--color-text)]">{provider.label}</span>
                  <span className={`shrink-0 text-[11px] font-medium ${ready ? 'text-green-400' : canConnect ? 'text-amber-300' : 'text-[var(--color-text-tertiary)]'}`}>
                    {statusText}
                  </span>
                </div>
                <p className="mt-1 min-h-[2rem] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  {provider.detail}
                </p>
                <div className="mt-auto pt-3">
                  {canConnect ? (
                    <a
                      href={provider.connectUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-center text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)]"
                    >
                      {provider.connectLabel ?? 'Connect'}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => chooseSubstrate(provider.id)}
                      disabled={!ready || substrateBusy !== null || selected}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {substrateBusy === provider.id ? 'Selecting...' : selected ? 'Selected' : 'Use'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && <p className="mt-3 text-[11px] text-amber-300">{error}</p>}
    </div>
  );
}
