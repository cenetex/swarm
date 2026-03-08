/**
 * Consent API — server-side consent persistence for privacy-policy acceptance.
 */
import { API_BASE } from './apiBase';

export interface ConsentResponse {
  consented: boolean;
  consent: {
    policyVersion: string;
    acceptedAt: number;
    status: 'active' | 'revoked';
  } | null;
}

export interface RecordConsentResponse {
  consent: {
    policyVersion: string;
    acceptedAt: number;
    status: 'active' | 'revoked';
  };
}

/**
 * Check whether the current user has accepted a specific policy version.
 */
export async function checkConsent(policyVersion: string): Promise<ConsentResponse> {
  const params = new URLSearchParams({ policyVersion });
  const response = await fetch(`${API_BASE}/consent?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    // On auth failure or network error, treat as no consent (re-prompt)
    if (response.status === 401) {
      return { consented: false, consent: null };
    }
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Record consent acceptance for the current user.
 */
export async function recordConsent(policyVersion: string): Promise<RecordConsentResponse> {
  const response = await fetch(`${API_BASE}/consent`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policyVersion }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Revoke consent for the current user.
 */
export async function revokeConsentApi(policyVersion: string): Promise<void> {
  const response = await fetch(`${API_BASE}/consent/revoke`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policyVersion }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}
