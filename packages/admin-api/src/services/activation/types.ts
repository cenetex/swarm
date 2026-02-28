/**
 * Activation Readiness Types
 *
 * Type definitions, interfaces, and constants for the
 * activation readiness evaluation system.
 */
import type { SecretType } from '../../types.js';
import type { getAccountSummary } from '../accounts.js';
import type { secretExists } from '../secrets.js';
import type { diagnoseTelegram } from '../telegram-admin.js';
import type { getConnectionStatus as getTwitterConnectionStatus } from '../twitter-oauth.js';
import type { getConnectionStatus as getDiscordConnectionStatus, DiscordServiceDeps } from '../discord.js';

export const ACTIVATION_READINESS_VERSION = 'activation_readiness_v1' as const;

export type ActivationGateStatus = 'pass' | 'fail';
export type ReadinessCheckStatus = 'pass' | 'fail' | 'warn' | 'not_applicable';
export type RemediationKind =
  | 'execute_step'
  | 'open_ui_route'
  | 'open_external_docs'
  | 'contact_support';

export type ReadinessEvidenceValue = string | number | boolean | null;

export interface RemediationActionV1 {
  id: string;
  kind: RemediationKind;
  label: string;
  description: string;
  retryable: boolean;
  target?: {
    method?: 'GET' | 'POST';
    endpoint?: string;
    route?: string;
    docsUrl?: string;
  };
  supportHint?: {
    runbookKey: string;
    reasonCode: string;
  };
}

export interface ReadinessCheckV1 {
  id: string;
  title: string;
  required: boolean;
  status: ReadinessCheckStatus;
  reasonCode: string;
  message: string;
  sourceStep?: string;
  remediation: RemediationActionV1[];
  evidence?: Record<string, ReadinessEvidenceValue>;
}

export interface ActivationReadinessReportV1 {
  version: typeof ACTIVATION_READINESS_VERSION;
  avatarId: string;
  evaluatedAt: string;
  gateStatus: ActivationGateStatus;
  summary: {
    requiredTotal: number;
    requiredPassing: number;
    requiredFailing: number;
    optionalTotal: number;
    optionalFailing: number;
  };
  checks: ReadinessCheckV1[];
}

export interface ActivationReadinessContext {
  effectiveIsAdmin: boolean;
  walletAddress: string | null;
  accountId: string | null;
}

export interface ActivationReadinessDeps {
  now?: () => number;
  getAccountSummary?: typeof getAccountSummary;
  secretExists?: typeof secretExists;
  diagnoseTelegram?: typeof diagnoseTelegram;
  getTwitterConnectionStatus?: typeof getTwitterConnectionStatus;
  getDiscordConnectionStatus?: typeof getDiscordConnectionStatus;
  discordServiceDeps?: DiscordServiceDeps;
}

/** Re-export SecretType for internal use */
export type { SecretType };
