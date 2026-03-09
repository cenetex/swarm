/**
 * Billing API client — Stripe Checkout and Customer Portal.
 */
import { API_BASE } from './apiBase';

export interface CheckoutResponse {
  sessionId: string;
  url: string;
}

export interface PortalResponse {
  sessionId: string;
  url: string;
}

export async function createCheckoutSession(
  avatarId: string,
  plan: 'pro' | 'enterprise',
): Promise<CheckoutResponse> {
  const successUrl = `${window.location.origin}?billing=success&plan=${plan}`;
  const cancelUrl = `${window.location.origin}?billing=cancelled`;

  const res = await fetch(`${API_BASE}/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ avatarId, plan, successUrl, cancelUrl }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Checkout failed (${res.status})`);
  }

  return res.json();
}

export async function createPortalSession(
  avatarId: string,
): Promise<PortalResponse> {
  const returnUrl = window.location.href;

  const res = await fetch(`${API_BASE}/billing/portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ avatarId, returnUrl }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Portal session failed (${res.status})`);
  }

  return res.json();
}
