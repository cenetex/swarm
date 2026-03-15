import { API_BASE } from './apiBase';

export type PlanType = 'free' | 'pro' | 'enterprise' | 'team';

export interface EffectiveLimitsResponse {
  avatarId: string;
  plan: PlanType;
  limits: Record<string, unknown>;
  source: 'entitlement' | 'default';
  entitlementStatus?: string;
}

export interface EntitlementRecord {
  accountId: string;
  avatarId: string;
  plan: PlanType;
  limits: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  status?: string;
  trialEndsAt?: number;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export async function getAvatarEffectiveLimits(avatarId: string): Promise<EffectiveLimitsResponse> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/effective-limits`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function getAvatarEntitlement(avatarId: string): Promise<{ avatarId: string; entitlement: EntitlementRecord | null }>{
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/entitlement`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function setAvatarEntitlement(
  avatarId: string,
  params: { plan: PlanType }
): Promise<{ avatarId: string; entitlement: EntitlementRecord; effective: { plan: PlanType; limits: Record<string, unknown>; source: string } }>{
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/entitlement`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }

  return response.json();
}
