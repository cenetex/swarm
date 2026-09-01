import { API_BASE } from './apiBase';
import { apiFetch as fetch } from './client';
import {
  parseHostingStatus,
  type HostingStatus,
  type ManagedSwarmInstance,
  type SwarmRunMode,
} from '@swarm/core/hosted';

export type HostingMode = SwarmRunMode;
export type HostingSubstrateProvider = 'fly' | 'aws' | 'ascii-box';

export type { HostingStatus, ManagedSwarmInstance };

export type HostingSubstrateProviderStatus = {
  id: HostingSubstrateProvider;
  label: string;
  cliInstalled: boolean;
  authenticated: boolean;
  enabled: boolean;
  detail: string;
  account?: string;
  loginCommand: string;
  connectUrl?: string;
  connectLabel?: string;
};

export type HostingSubstratesStatus = {
  selected?: HostingSubstrateProvider;
  providers: HostingSubstrateProviderStatus[];
};

export async function getHostingStatus(): Promise<HostingStatus> {
  const response = await fetch(`${API_BASE}/hosting/status`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Failed to load hosting status' }));
    throw new Error(String(body.error ?? 'Failed to load hosting status'));
  }
  return parseHostingStatus(await response.json());
}

export async function setHostingMode(mode: HostingMode): Promise<HostingStatus> {
  const response = await fetch(`${API_BASE}/hosting/mode`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body.error ?? `Failed to switch to ${mode}`));
  }
  return parseHostingStatus(body);
}

export async function provisionHostedSwarm(): Promise<HostingStatus> {
  const response = await fetch(`${API_BASE}/hosting/provision`, {
    method: 'POST',
    credentials: 'include',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body.error ?? 'Failed to start hosted Swarm'));
  }
  return parseHostingStatus(body);
}

export async function getHostingSubstratesStatus(): Promise<HostingSubstratesStatus> {
  const response = await fetch(`${API_BASE}/hosting/substrates/status`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Failed to load hosting substrates' }));
    throw new Error(String(body.error ?? 'Failed to load hosting substrates'));
  }
  return response.json();
}

export async function selectHostingSubstrate(provider: HostingSubstrateProvider): Promise<HostingSubstratesStatus> {
  const response = await fetch(`${API_BASE}/hosting/substrates/select`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body.error ?? 'Failed to select hosting substrate'));
  }
  return body as HostingSubstratesStatus;
}
