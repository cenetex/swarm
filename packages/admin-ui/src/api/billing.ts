/**
 * Billing API client — Stripe Checkout, Customer Portal, and Design Partner invites.
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

// ── Design Partner Invite Redemption ──────────────────────────────────────────

export interface RedeemInviteResponse {
  success: boolean;
  message: string;
  partner: {
    accountId: string;
    avatarId: string;
    plan: 'pro' | 'enterprise';
    status: string;
    refundEligible: boolean;
    refundDeadline: string;
  };
}

export async function redeemInviteCode(
  code: string,
  avatarId: string,
): Promise<RedeemInviteResponse> {
  const res = await fetch(`${API_BASE}/design-partners/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code, avatarId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to redeem invite code (${res.status})`);
  }

  return res.json();
}
