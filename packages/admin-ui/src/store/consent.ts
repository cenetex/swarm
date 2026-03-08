/**
 * Consent Store
 * Tracks whether users have accepted the privacy policy & data consent.
 * Persisted to localStorage so the banner is only shown once.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ConsentRecord {
  /** ISO timestamp when consent was given */
  acceptedAt: string;
  /** Version of the privacy policy accepted */
  policyVersion: string;
}

interface ConsentState {
  consent: ConsentRecord | null;
  /** Accept privacy policy & data usage consent */
  acceptConsent: () => void;
  /** Revoke consent (for settings / GDPR) */
  revokeConsent: () => void;
  /** Whether the consent banner should be shown */
  needsConsent: () => boolean;
}

/** Bump this when the privacy policy materially changes */
export const CURRENT_POLICY_VERSION = '1.2';

export const useConsentStore = create<ConsentState>()(
  persist(
    (set, get) => ({
      consent: null,

      acceptConsent: () =>
        set({
          consent: {
            acceptedAt: new Date().toISOString(),
            policyVersion: CURRENT_POLICY_VERSION,
          },
        }),

      revokeConsent: () => set({ consent: null }),

      needsConsent: () => {
        const { consent } = get();
        if (!consent) return true;
        // Re-prompt if policy version changed
        return consent.policyVersion !== CURRENT_POLICY_VERSION;
      },
    }),
    { name: 'swarm-consent' },
  ),
);
