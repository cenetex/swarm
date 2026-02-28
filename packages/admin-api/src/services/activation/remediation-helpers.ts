/**
 * Activation Readiness — Remediation Helpers
 *
 * Factory functions for creating remediation actions and
 * shared utility functions used across readiness checks.
 */
import type { SecretType } from '../../types.js';
import { secretExists as secretExistsDefault } from '../secrets.js';
import type { RemediationActionV1, ActivationReadinessDeps } from './types.js';

export function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function executeStepAction(
  id: string,
  avatarId: string,
  step: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'execute_step',
    label,
    description,
    retryable: true,
    target: {
      method: 'POST',
      endpoint: `/onboarding/${avatarId}/steps/${step}/execute`,
      route: `/avatars/${avatarId}/onboarding?step=${step}`,
    },
  };
}

export function openUiRouteAction(
  id: string,
  route: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'open_ui_route',
    label,
    description,
    retryable: true,
    target: {
      method: 'GET',
      route,
    },
  };
}

export function externalDocsAction(
  id: string,
  docsUrl: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'open_external_docs',
    label,
    description,
    retryable: true,
    target: {
      docsUrl,
    },
  };
}

export function contactSupportAction(
  id: string,
  label: string,
  description: string,
  runbookKey: string,
  reasonCode: string
): RemediationActionV1 {
  return {
    id,
    kind: 'contact_support',
    label,
    description,
    retryable: false,
    supportHint: {
      runbookKey,
      reasonCode,
    },
  };
}

export async function hasSecretConfigured(
  avatarId: string,
  secretType: SecretType,
  deps: ActivationReadinessDeps
): Promise<boolean> {
  const secretExistsImpl = deps.secretExists ?? secretExistsDefault;
  const [avatarSpecific, global] = await Promise.all([
    secretExistsImpl(avatarId, secretType, 'default'),
    secretExistsImpl(null, secretType, 'default'),
  ]);
  return avatarSpecific || global;
}
