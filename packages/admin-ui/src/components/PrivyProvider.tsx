/**
 * Auth Provider — simple pass-through wrapper.
 * 
 * In local/desktop mode, the server handles all auth (password-based).
 * No third-party SDK needed.
 */
import { type ReactNode } from 'react';

interface AuthProviderProps {
  children: ReactNode;
}

export function PrivyProvider({ children }: AuthProviderProps) {
  return <>{children}</>;
}

// Stub config for backward compat
export async function buildPrivyConfig(): Promise<Record<string, unknown>> {
  return {};
}
