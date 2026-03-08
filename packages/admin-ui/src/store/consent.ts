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
  acceptConsent: () => void;
  /** Revoke consent (for settings / GDPR) */
  revokeConsent: () => void;
  /** Whether the consent banner should be shown */
  needsConsent: () => boolean;
  /** Sync consent status from the backend (call after login) */
  syncFromBackend: () => Promise<void>;
}

/** Bump this when the privacy policy materially changes */
export const CURRENT_POLICY_VERSION = '1.1';

export const useConsentStore = create<ConsentState>()(
  persist(
    (set, get) => ({
      consent: null,
      syncing: false,

      acceptConsent: () => {
        const consent: ConsentRecord = {
          acceptedAt: new Date().toISOString(),
          policyVersion: CURRENT_POLICY_VERSION,
        };
        // Update localStorage immediately for responsive UI
        set({ consent });
        // Fire-and-forget backend persistence
        recordConsent(CURRENT_POLICY_VERSION).catch((err) => {
          console.warn('[Consent] Failed to persist consent to backend:', err);
        });
      },

      revokeConsent: () => {
        const { consent } = get();
        set({ consent: null });
        // Fire-and-forget backend revocation
        if (consent?.policyVersion) {
          revokeConsentApi(consent.policyVersion).catch((err) => {
            console.warn('[Consent] Failed to revoke consent on backend:', err);
          });
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
          // On error, keep localStorage state as fallback
          console.warn('[Consent] Failed to sync from backend, using local state');
        } finally {
          set({ syncing: false });
        }
      },
    }),
    { name: 'swarm-consent' },
  ),
);
