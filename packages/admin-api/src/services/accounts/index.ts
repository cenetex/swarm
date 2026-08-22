/**
 * Accounts Services
 *
 * Unified account and identity management system.
 */

// Identity management
export {
  resolveAccountForIdentity,
  linkIdentity,
  unlinkIdentity,
  getAccountIdForIdentity,
  getAccountIdentities,
  type Identity,
  type IdentityType,
  type ResolveAccountResult,
  type LinkIdentityResult,
  type UnlinkIdentityResult,
} from './identity-service.js';

// Onboarding auth/account resolution
export {
  resolveOnboardingAuthAccount,
  onboardingAuthErrorStatusCode,
  type OnboardingAuthOutcome,
  type OnboardingAuthErrorCode,
  type OnboardingAuthIntent,
  type OnboardingAuthResult,
  type OnboardingAuthSuccessResult,
  type OnboardingAuthFailureResult,
  type ResolveOnboardingAuthAccountParams,
  type OnboardingAuthResolverDeps,
} from './onboarding-auth-resolver.js';

// Challenge management
export {
  createAuthChallenge,
  createLinkChallenge,
  consumeChallenge,
  getChallenge,
  type ChallengeType,
  type ChallengeRecord,
} from './challenge-service.js';

// Session management
export {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  getAndTouchSession,
  validateSession,
  type AuthProvider,
  type SessionRecord,
  type CreateSessionParams,
  type ValidatedSession,
} from './session-service.js';

// Auth orchestration (main entry point)
export {
  // Wallet auth
  createWalletChallenge,
  authenticateWallet,
  verifyWalletSignature,
  // Identity linking
  createWalletLinkChallenge,
  verifyAndLinkWallet,
  // Types
  type AuthenticateWalletParams,
  type AuthenticateResult,
  type LinkWalletParams,
  type LinkWalletResult,
  type OnboardingOrchestrationContext,
  type OnboardingResponseMetadata,
} from './auth-orchestrator.js';
