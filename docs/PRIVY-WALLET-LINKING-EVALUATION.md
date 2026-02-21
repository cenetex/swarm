# Privy Native Wallet Linking vs Custom Flow Evaluation

**Issue:** #241
**Date:** 2026-02-20
**Status:** Decision Record

## Context

The admin UI currently uses two parallel wallet-related systems:

1. **Privy SDK** (`@privy-io/react-auth ^3.11.0`) for primary authentication (email, social, wallet login) and embedded Solana wallet creation.
2. **Custom challenge-sign-verify flow** for linking additional Solana wallets to an existing account after initial login.

This document evaluates whether Privy's native `linkWallet()` / `unlinkWallet()` could replace the custom wallet linking flow, reducing code and improving UX.

## Current Custom Wallet Linking Flow

### Architecture

The custom flow is a five-step challenge-sign-verify protocol:

```
Frontend (WalletLinkPrompt.tsx)       Backend (wallet-auth.ts / wallet-link.ts)
─────────────────────────────────     ─────────────────────────────────────────
1. User clicks "Connect & Link"
2. Solana wallet adapter modal
   opens, user selects wallet
3. POST /auth/link/wallet/challenge  -->  Generate nonce + challenge message
   { walletAddress }                      Store LINKCHALLENGE#<nonce> in DynamoDB
                                          (5-min TTL, tied to accountId + wallet)
                                     <--  { nonce, message, expiresAt }
4. Sign message via wallet adapter
   (signWalletLinkMessage util,
    Privy embedded or Phantom)
5. POST /auth/link/wallet/verify     -->  Consume challenge (atomic delete),
   { walletAddress, nonce, signature }    verify Ed25519 signature (tweetnacl),
                                          ensureIdentityLinkedToAccount() in
                                          DynamoDB (IDENTITY# + ACCOUNT# records)
                                     <--  { success, account }
6. Refresh account summary
```

### Key Backend Files

| File | Purpose |
|------|---------|
| `packages/admin-api/src/services/wallet-link.ts` | Challenge creation, nonce generation, message formatting, signature verification, DynamoDB linking |
| `packages/admin-api/src/services/wallet-auth.ts` | Ed25519 signature verification (`tweetnacl`), session management |
| `packages/admin-api/src/handlers/wallet-auth.ts` | HTTP routes: `/auth/link/wallet/challenge`, `/auth/link/wallet/verify` |
| `packages/admin-api/src/services/accounts.ts` | `ensureIdentityLinkedToAccount()` -- DynamoDB identity graph (IDENTITY#wallet#<addr> -> ACCOUNT#<id>) |

### Key Frontend Files

| File | Purpose |
|------|---------|
| `packages/admin-ui/src/components/tool-prompts/WalletLinkPrompt.tsx` | Inline chat prompt UI, state machine (idle/connecting/challenging/signing/verifying/success/error) |
| `packages/admin-ui/src/auth/wallet-linking.ts` | `signWalletLinkMessage()` -- signs with Privy embedded wallet or Phantom fallback, encodes to base58 |
| `packages/admin-ui/src/auth/wallet-errors.ts` | Error classification (Phantom extension invalidated, user rejection, network errors) |
| `packages/admin-ui/src/components/unified-wallet.tsx` | `UnifiedWalletProvider` wrapping `@solana/wallet-adapter-react` for Phantom/external wallet support |

### Challenge Message Format

```
Sign this message to link a Solana wallet to your Swarm account.

Domain: swarm.rati.chat
Account: <accountId>
Wallet: <walletAddress>
Nonce: <64-char hex>
Issued At: 2026-02-20T12:00:00.000Z
Expiration: 2026-02-20T12:05:00.000Z

This signature will not trigger any blockchain transaction or cost any fees.
```

This message is human-readable and includes the specific account, wallet, and a time-bound nonce -- a custom SIWS-like protocol.

## Privy SDK Capabilities

### Available APIs (from `@privy-io/react-auth ^3.11.0`)

**`usePrivy()` hook** (high-level, UI-driven):
- `linkWallet(options?)` -- opens the Privy modal prompting the user to connect and link an external wallet. Returns `void` (fire-and-forget, result arrives via callbacks/user object update).
- `unlinkWallet(address)` -- unlinks a wallet by address. Returns updated `User` object. Requires at least one other linked account to remain.

**`useLinkWithSiws()` hook** (headless, Solana-specific):
- `generateSiwsMessage({ address })` -- generates a SIWS message for a given Solana address.
- `linkWithSiws({ signature, message, walletClientType?, connectorType? })` -- verifies the signature and links the wallet. Returns `{ user, linkedAccount }`.

**`useLinkAccount()` hook** (callback-driven):
- `linkWallet(options?)` -- same as `usePrivy().linkWallet` but with `onSuccess`/`onError` callbacks registered at hook initialization.

### Solana Support

Privy supports Solana wallets natively:
- The `PrivyProvider` is configured with `walletChainType: 'solana-only'`, Phantom/Solflare/Backpack connectors, and embedded Solana wallet creation (`createOnLogin: 'users-without-wallets'`).
- `useLinkWithSiws()` provides a headless SIWS flow specifically for Solana wallets.
- `unlinkSolanaWallet(address)` is available on the internal client for Solana-specific unlinking.

### How Privy Stores Linked Wallets

When a wallet is linked via Privy, it appears in `user.linkedAccounts` as an entry with `type: 'wallet'` and `chainType: 'solana'`. Privy manages the identity mapping on its own servers -- the wallet is associated with the Privy user ID.

## Integration Challenges

### 1. DynamoDB Identity Graph Synchronization

The backend maintains its own identity graph in DynamoDB:

```
IDENTITY#wallet#<address> -> ACCOUNT#<uuid>
ACCOUNT#<uuid> -> IDENTITY#wallet#<address> (reverse index)
```

Privy's `linkWallet()` only updates Privy's servers. The backend would still need to be notified to create/update the DynamoDB identity mapping. This means:

- A webhook or polling mechanism would be needed to sync Privy's linked accounts to DynamoDB.
- Alternatively, the frontend would need to call a backend endpoint after `linkWallet()` completes, passing the Privy access token so the backend can read the updated `user.linkedAccounts` and sync.
- The existing `/auth/link/privy/verify` endpoint partially handles this pattern (for Privy identity linking), but it would need to be extended to handle wallet additions detected from the Privy user object.

### 2. Custom Challenge Messages

The current custom flow uses a human-readable challenge message that includes the specific Swarm account ID, domain, and nonce. This gives users clear visibility into what they are authorizing. Privy's SIWS messages follow the SIWS standard format, which is more generic and does not include application-specific context like the Swarm account ID.

### 3. Orb/NFT Gate Checks

The backend performs NFT gate checks (Orb holder verification) during authentication and wallet linking. With Privy-managed linking:

- NFT gate checks would need to happen in a separate step after Privy reports the linked wallet.
- The atomic "verify signature + check NFT gate + link identity" flow would become a two-phase process: (1) Privy links the wallet, (2) backend syncs and runs gate checks.
- Race conditions could occur if the user navigates away between steps.

### 4. Conflict Detection

The custom flow checks for conflicts before generating a challenge (`getAccountIdForIdentity`) -- if a wallet is already linked to a different account, the user gets an immediate error. With Privy linking:

- Privy does not know about Swarm's multi-account model. A wallet could be linked in Privy but conflict with a different Swarm account.
- Conflict detection would shift to a post-link validation step, potentially requiring an `unlinkWallet()` call to roll back if a conflict is found.

### 5. Embedded Wallet Signing

The current `signWalletLinkMessage()` utility supports both Privy embedded wallets and external Phantom wallets with a fallback chain. Privy's `linkWallet()` modal handles this internally, but the `useLinkWithSiws()` headless flow would require the caller to manage wallet connection and signing.

### 6. Unlink Constraints

Privy's `unlinkWallet()` requires at least one other linked account to remain. The Swarm backend has no such constraint -- it allows unlinking any wallet as long as the account exists. This difference in unlinking semantics could cause confusion.

## Pros and Cons

| Factor | Privy Native (`linkWallet`) | Custom Flow (Current) |
|--------|---------------------------|----------------------|
| **Code reduction** | Eliminates ~300 lines of frontend state machine + signing util; removes 2 backend endpoints and `wallet-link.ts` service | N/A (status quo) |
| **UX consistency** | Privy modal matches login flow; users see familiar UI | Custom inline chat prompt; state machine has known bugs (issue #241 context) |
| **Solana support** | Full SIWS support via `useLinkWithSiws()`; modal supports Phantom, Solflare, Backpack | Full support via `@solana/wallet-adapter-react`; Phantom + embedded wallet fallback |
| **Backend sync** | Requires new sync mechanism (webhook or post-link API call) to update DynamoDB identity graph | Direct DynamoDB writes in the same request |
| **Conflict detection** | Post-link only; may need rollback via `unlinkWallet()` | Pre-challenge check; immediate rejection |
| **Custom challenge message** | Not possible; SIWS standard format only | Full control over message content |
| **NFT gate integration** | Decoupled; separate step after linking | Atomic; part of the verify flow |
| **Dependency risk** | Deeper coupling to Privy SDK; breaking changes in Privy affect linking | Independent; only uses standard Ed25519 verification |
| **Offline/degraded mode** | Requires Privy servers to be reachable | Only requires our own backend |
| **Migration effort** | Medium-high: new sync endpoint, update DynamoDB sync logic, handle conflict rollbacks, update WalletLinkPrompt, regression testing | Low: fix frontend state machine bugs |
| **Unlink support** | Built-in `unlinkWallet()`; requires 1+ remaining account | Not yet implemented; would need custom endpoint |

## Recommendation

**Keep the custom challenge-sign-verify flow and fix the frontend state machine bugs.**

### Rationale

1. **The backend is solid.** The challenge-sign-verify protocol in `wallet-link.ts` and `wallet-auth.ts` is well-tested, handles conflicts atomically, and integrates directly with the DynamoDB identity graph. There are no known bugs in the backend linking logic.

2. **The problems are in the frontend.** The `WalletLinkPrompt.tsx` state machine has edge cases around wallet connection state transitions (connecting -> challenging -> signing), reconnection after Phantom restarts, and error recovery. These are frontend UX bugs that can be fixed without replacing the underlying protocol.

3. **Privy linking would add complexity, not remove it.** Adopting Privy's `linkWallet()` would eliminate the frontend state machine but introduce a new backend synchronization problem. The DynamoDB identity graph must stay in sync with Privy's linked accounts, which means either:
   - A webhook integration (Privy webhook -> Lambda -> DynamoDB sync), adding infrastructure complexity.
   - A post-link frontend call (frontend calls backend after Privy linking completes), which is roughly the same amount of frontend code with a different failure mode.

4. **Conflict detection degrades.** The current pre-challenge conflict check is a better UX than linking in Privy and then discovering a conflict that requires a rollback `unlinkWallet()` call.

5. **Custom challenge messages are valuable.** The human-readable challenge message showing the Swarm account ID, domain, and nonce provides transparency to users about exactly what they are authorizing. SIWS standard messages lack this application-specific context.

6. **Dependency risk.** The custom flow depends only on `tweetnacl` for Ed25519 verification -- a stable, widely-used cryptographic library. Privy's `linkWallet()` adds a dependency on Privy's modal UI, SIWS implementation, and server-side wallet storage, all of which could change across SDK versions.

### Recommended Next Steps

1. **Fix the `WalletLinkPrompt.tsx` state machine** (separate issue): handle wallet disconnection during signing, add timeout recovery, improve error messages for Phantom extension invalidation.
2. **Add unlink wallet support** using the existing custom flow pattern: a new `/auth/unlink/wallet` endpoint that removes the IDENTITY# mapping from DynamoDB.
3. **Consider Privy `linkWallet()` for future simplification** only if:
   - Privy adds webhook support for account linking events.
   - The DynamoDB identity graph is migrated to use Privy as the source of truth for wallet associations.
   - The NFT gate check can be decoupled from the linking flow without UX degradation.
