import { useState } from 'react';
import {
  acknowledgeCredentialRotation,
  migrateLegacyLocalWebState,
} from '../local-web-api';

export function CredentialMigrationNotice() {
  const [visible, setVisible] = useState(() => migrateLegacyLocalWebState());

  if (!visible) return null;

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--color-text)] sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="font-medium">Rotate credentials previously saved in this browser</p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Swarm removed legacy provider keys, avatar secrets, and backend API keys from browser storage. Treat those values as exposed, rotate them with each provider, then save replacements through the native app or trusted backend.
        </p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-lg border border-amber-500/50 px-3 py-2 text-xs font-medium hover:bg-amber-500/10"
        onClick={() => {
          acknowledgeCredentialRotation();
          setVisible(false);
        }}
      >
        I have rotated them
      </button>
    </div>
  );
}
