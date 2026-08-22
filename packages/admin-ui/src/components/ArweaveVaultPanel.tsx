import { useCallback, useMemo, useRef, useState } from 'react';
import {
  decryptVault,
  detectVaultWallets,
  downloadVault,
  encryptLocalSnapshot,
  fetchVaultFromArweave,
  parseVaultJson,
  restoreLocalSnapshot,
  type DetectedVaultWallet,
  type SwarmEncryptedVault,
} from '../services/arweave-vault';

type VaultStatus = {
  kind: 'idle' | 'success' | 'error';
  message: string;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function isWebLocalMode(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.swarmWebLocal === 'true';
}

async function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export function ArweaveVaultPanel() {
  const [wallets, setWallets] = useState<DetectedVaultWallet[]>(() => detectVaultWallets());
  const [selectedWalletSource, setSelectedWalletSource] = useState<string>(wallets[0]?.source ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<VaultStatus>({ kind: 'idle', message: '' });
  const [lastVault, setLastVault] = useState<SwarmEncryptedVault | null>(null);
  const [arweaveInput, setArweaveInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const webLocal = isWebLocalMode();
  const hasArConnect = typeof window !== 'undefined' && 'arweaveWallet' in window;
  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.source === selectedWalletSource) ?? wallets[0],
    [selectedWalletSource, wallets],
  );

  const refreshWallets = useCallback(() => {
    const nextWallets = detectVaultWallets();
    setWallets(nextWallets);
    setSelectedWalletSource((current) => (
      nextWallets.some((wallet) => wallet.source === current)
        ? current
        : nextWallets[0]?.source ?? ''
    ));
  }, []);

  const runWithWallet = useCallback(async <T,>(operation: (wallet: DetectedVaultWallet) => Promise<T>): Promise<T | null> => {
    refreshWallets();
    const wallet = selectedWallet ?? detectVaultWallets()[0];
    if (!wallet) {
      setStatus({ kind: 'error', message: 'Install or unlock Phantom, Solflare, or Backpack to encrypt and decrypt vaults.' });
      return null;
    }
    setBusy(true);
    setStatus({ kind: 'idle', message: '' });
    try {
      return await operation(wallet);
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Vault operation failed.' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [refreshWallets, selectedWallet]);

  const handleDownload = useCallback(async () => {
    await runWithWallet(async (wallet) => {
      const vault = await encryptLocalSnapshot(wallet);
      downloadVault(vault);
      setLastVault(vault);
      setStatus({
        kind: 'success',
        message: `Encrypted vault saved for ${shortAddress(vault.walletAddress)}.`,
      });
    });
  }, [runWithWallet]);

  const restoreVault = useCallback(async (vault: SwarmEncryptedVault) => {
    await runWithWallet(async (wallet) => {
      const snapshot = await decryptVault(vault, wallet);
      restoreLocalSnapshot(snapshot);
      setLastVault(vault);
      setStatus({
        kind: 'success',
        message: `Loaded ${Object.keys(snapshot.storage).length} local state entries. Refresh to apply the restored swarm.`,
      });
    });
  }, [runWithWallet]);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setStatus({ kind: 'idle', message: '' });
    try {
      const vault = parseVaultJson(await readFileText(file));
      setBusy(false);
      await restoreVault(vault);
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to import vault file.' });
    }
  }, [restoreVault]);

  const handleLoadFromArweave = useCallback(async () => {
    if (!arweaveInput.trim()) {
      setStatus({ kind: 'error', message: 'Paste an Arweave transaction id or URL first.' });
      return;
    }
    setBusy(true);
    setStatus({ kind: 'idle', message: '' });
    try {
      const vault = await fetchVaultFromArweave(arweaveInput);
      setBusy(false);
      await restoreVault(vault);
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load vault from Arweave.' });
    }
  }, [arweaveInput, restoreVault]);

  const handleRefresh = useCallback(() => {
    window.location.reload();
  }, []);

  if (!webLocal) return null;

  return (
    <div className="mt-4 max-w-3xl mx-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-4 text-left">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--color-text)]">Arweave vault</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Encrypt this browser&apos;s swarm with a wallet signature, then save or restore it as a portable dApp vault.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshWallets}
            disabled={busy}
            className="self-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
          >
            Detect wallets
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Signing wallet</span>
            <select
              value={selectedWalletSource}
              onChange={(event) => setSelectedWalletSource(event.target.value)}
              disabled={busy || wallets.length === 0}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-brand-500 disabled:opacity-60"
            >
              {wallets.length === 0 ? (
                <option value="">No wallet detected</option>
              ) : wallets.map((wallet) => (
                <option key={wallet.source} value={wallet.source}>{wallet.name}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={handleDownload}
            disabled={busy || wallets.length === 0}
            className="rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-2 text-sm font-medium text-brand-300 transition-colors hover:bg-brand-500/20 disabled:opacity-50"
          >
            Save vault
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || wallets.length === 0}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
          >
            Load file
          </button>
          <input
            value={arweaveInput}
            onChange={(event) => setArweaveInput(event.target.value)}
            disabled={busy}
            placeholder="Arweave transaction id or https://arweave.net/..."
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-brand-500 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleLoadFromArweave}
            disabled={busy || wallets.length === 0 || !arweaveInput.trim()}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
          >
            Load tx
          </button>
        </div>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {hasArConnect
            ? 'ArConnect detected. Direct permanent upload is the next step: sign an Arweave/Turbo upload for this encrypted vault.'
            : 'Direct upload needs an Arweave upload signer such as ArConnect or a Turbo credit path. For now, save the encrypted vault file and upload that JSON to Arweave.'}
          {lastVault && (
            <span className="block mt-1">
              Last vault: {lastVault.manifest.storageKeys.length} keys, {lastVault.manifest.byteLength} bytes, owner {shortAddress(lastVault.walletAddress)}.
            </span>
          )}
        </div>

        {status.message && (
          <div className={[
            'rounded-lg border px-3 py-2 text-xs',
            status.kind === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : status.kind === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]',
          ].join(' ')}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{status.message}</span>
              {status.kind === 'success' && status.message.includes('Refresh') && (
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="self-start rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/10"
                >
                  Refresh
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
