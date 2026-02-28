/**
 * Auth Domain
 *
 * Authentication, authorization, and identity services:
 * wallet auth, Privy auth, NFT gating, account management.
 *
 * Note: The `accounts/` sub-package is intentionally NOT re-exported here
 * because it contains names that overlap with the legacy `accounts.js` and
 * `wallet-auth.js` modules.  Import from `../accounts/index.js` directly
 * when you need the newer decomposed auth orchestrator / identity / session
 * services.
 */
export * from '../wallet-auth.js';
export * from '../privy-auth.js';
export * from '../account-gate.js';
export * from '../accounts.js';
export * from '../web3/wallet-link.js';
export * from '../web3/nft-gate.js';
