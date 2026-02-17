/**
 * Wallet-adapter error humanisation utilities.
 *
 * Previously lived in `walletUi.ts`; extracted so the store file stays
 * focused on state management.
 */

export function humanizeWalletAdapterError(error: unknown): string {
  const anyErr = error as { name?: string; message?: string; cause?: unknown };
  const name = typeof anyErr?.name === 'string' ? anyErr.name : '';
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(error);

  if (name.includes('WalletConnectionError') && /unexpected error/i.test(message)) {
    return 'Wallet connection failed ("Unexpected error"). If you are on mobile: open this site inside your wallet\'s in-app browser (Phantom/Solflare), unlock the wallet, then try again. If it still fails, disconnect the wallet in the wallet app and reconnect.';
  }

  if (/user rejected|rejected/i.test(message)) {
    return 'Wallet request was cancelled.';
  }

  if (!message || message === '[object Object]') {
    return 'Wallet operation failed.';
  }

  return message;
}
