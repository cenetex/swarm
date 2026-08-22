/**
 * Consent Store
 * Tracks whether users have accepted the privacy policy & data consent.
 * Persisted to localStorage as a cache; the backend is the source of truth.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { checkConsent, recordConsent, revokeConsentApi } from '../api/consent';

export interface ConsentRecord {
  /** ISO timestamp when consent was given */
  acceptedAt: string;
  /** Version of the privacy policy accepted */
  policyVersion: string;
}

interface ConsentState {
  consent: ConsentRecord | null;
  /** Whether a backend sync is in progress */
  syncing: boolean;
  /** Accept privacy policy & data usage consent */
  acceptConsent: () => Promise<boolean>;
  /** Revoke consent (for settings / GDPR) */
  revokeConsent: () => Promise<boolean>;
  /** Whether the consent banner should be shown */
  needsConsent: () => boolean;
  /** Sync consent status from the backend (call after login) */
  syncFromBackend: () => Promise<void>;
}

/** Bump this when the privacy policy materially changes */
export const CURRENT_POLICY_VERSION = '1.3';

export const useConsentStore = create<ConsentState>()(
  persist(
    (set, get) => ({
      consent: null,
      syncing: false,

      acceptConsent: async () => {
        const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
        if (isLocal) {
          // Local mode: accept immediately without backend
          set({
            consent: {
              acceptedAt: new Date().toISOString(),
              policyVersion: CURRENT_POLICY_VERSION,
            },
          });
          return true;
        }
        set({ syncing: true });
        try {
          const result = await recordConsent(CURRENT_POLICY_VERSION);
          set({
            consent: {
              acceptedAt: new Date(result.consent.acceptedAt).toISOString(),
              policyVersion: result.consent.policyVersion,
            },
          });
          return true;
        } catch (err) {
          set({ consent: null });
          console.warn('[Consent] Failed to persist consent to backend:', err);
          return false;
        } finally {
          set({ syncing: false });
        }
      },

      revokeConsent: async () => {
        const { consent } = get();
        if (!consent?.policyVersion) {
          set({ consent: null });
          return true;
        }

        set({ syncing: true });
        try {
          await revokeConsentApi(consent.policyVersion);
          set({ consent: null });
          return true;
        } catch (err) {
          console.warn('[Consent] Failed to revoke consent on backend:', err);
          return false;
        } finally {
          set({ syncing: false });
        }
      },

      needsConsent: () => {
        const { consent } = get();
        if (!consent) return true;
        // Re-prompt if policy version changed
        return consent.policyVersion !== CURRENT_POLICY_VERSION;
      },

      syncFromBackend: async () => {
        const { syncing } = get();
        if (syncing) return;

        set({ syncing: true });
        try {
          const result = await checkConsent(CURRENT_POLICY_VERSION);
          if (result.consented && result.consent) {
            set({
              consent: {
                acceptedAt: new Date(result.consent.acceptedAt).toISOString(),
                policyVersion: result.consent.policyVersion,
              },
            });
          } else {
            // Backend says no active consent for current version — clear local cache
            set({ consent: null });
          }
        } catch {
          // If the backend cannot confirm consent, keep the app in a re-consent state.
          set({ consent: null });
          console.warn('[Consent] Failed to sync from backend, clearing local state');
        } finally {
          set({ syncing: false });
        }
      },
    }),
    { name: 'swarm-consent' },
  ),
);
