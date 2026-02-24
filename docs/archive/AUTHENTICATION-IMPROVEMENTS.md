# Authentication Improvements (Wallet + Crossmint)

This document describes the current authentication architecture in AWS Swarm (Admin UI + Admin API), the highest-impact issues observed in real user onboarding, the improvements already implemented, and a concrete roadmap/spec to make production authentication smooth, explicit, and robust.

> Scope: Admin UI / Admin API authentication and onboarding (wallet + Crossmint). Runtime channel auth (Telegram webhook secrets, etc.) is out of scope except where it interacts with Admin sessions.

---

## Summary

**Problems we’re solving**
- Users can sign in via two identity providers (Solana wallet SIWS + Crossmint email/social) but the system historically behaved as if a *single wallet address == the account*, making it impossible to cleanly “link” identities.
- Cookie/session mismatch (Domain / SameSite variants) could produce **ghost sessions** (logout appears to work but the browser still sends a different cookie).
- The UI could implicitly “switch” identities when a wallet connects, causing **Phantom signature loops** and split-brain state (UI thinks you’re logged in while backend session is invalid).
- Crossmint refresh / expiry could wedge the UI due to persisted local auth state.

**What’s already implemented (P0 stabilization)**
- A single cookie helper (`swarm_session`) used consistently by wallet and Crossmint flows, including multi-variant clearing to avoid ghost sessions.
- Admin API handlers support returning multiple cookies via the API Gateway v2 response `cookies` array.
- Admin UI prompts the user before switching identities when Crossmint-authenticated and a different Phantom wallet connects.
- App bootstrap logic treats the backend session as the source of truth and clears persisted Crossmint auth when `/auth/me` indicates unauthenticated.

**What’s next (remaining work)**
- Finish the last onboarding UX requirements (CTAs + explanation + stable “Account” view).
- Optionally: add a dedicated “Account settings” route instead of the WalletLogin modal-style UI.

**What’s implemented (production posture)**
- Admin API auth no longer “falls back” to `Origin`/`Referer` checks when no token is present; requests must authenticate via Cloudflare Access token or first-party `swarm_session`.
- When using session-cookie auth for admin endpoints, admin determination can be configured via `ADMIN_EMAILS` and/or `ADMIN_WALLETS`.

---

## Current Architecture (Relevant Pieces)

### Actors
- **Admin UI** (`packages/admin-ui`): React app with Zustand stores for wallet auth and Crossmint auth.
- **Admin API** (`packages/admin-api`): Lambda handlers that issue and validate a server-side session cookie.
- **Identity Providers**:
  - **Wallet SIWS**: sign-in with Solana wallet via challenge + signature.
  - **Crossmint**: email/social login via SDK, then backend session establishment.

### Session: single cookie
- Cookie name: `swarm_session`
- The Admin API sets/clears this cookie and uses it to look up server-side session state.

The helper used by handlers is in:
- `packages/admin-api/src/auth/session-cookie.ts`

---

## Issues Observed (Root Causes)

### 1) “Account = wallet address” makes linking impossible
If the system keys ownership/gating/admin state by wallet address, then:
- Crossmint login (email) has no clean way to “attach” a Phantom wallet.
- Users with assets in Wallet A but logged in as Wallet B see “limited mode” with no path to resolve.

**Root fix:** model accounts as first-class entities that can have multiple linked identities.

### 2) Cookie attribute mismatch causes ghost sessions
If one flow sets a host-only cookie and another sets a Domain cookie (or different SameSite), browsers can send both; servers might read one, UI might clear another.

**Root fix:** set and clear cookie variants deterministically and consistently.

### 3) Implicit switching creates loops and split-brain
If connecting a wallet automatically triggers logout/login or “switches” auth mode implicitly:
- Users get repeated signature prompts.
- Backend session and frontend store can disagree, producing wedged UX.

**Root fix:** explicit “Link vs Switch” UX with clear state transitions.

### 4) Persisted client auth resurrects invalid sessions
If Crossmint auth state is persisted and restored on page load, it can re-enable “logged in” UI even when the backend session has expired.

**Root fix:** backend session wins; client persisted auth is cleared when backend says unauthenticated.

---

## Implemented Improvements (P0)

### A) Consistent cookie parsing + multi-cookie set/clear
**Change:** shared cookie utilities standardize session cookie semantics across handlers.

- Parse: `getSessionFromCookie(event)`
- Set: `getSetSessionCookies(sessionToken)` returns multiple `Set-Cookie` strings to avoid host-only/domain duplication.
- Clear: `getClearSessionCookies()` clears both variants.

This is implemented in:
- `packages/admin-api/src/auth/session-cookie.ts`

**Handlers updated to use it**
- `packages/admin-api/src/handlers/wallet-auth.ts`
- `packages/admin-api/src/handlers/crossmint-auth.ts`
- `packages/admin-api/src/handlers/shared-chat.ts`
- `packages/admin-api/src/handlers/avatars.ts`

**Why it matters:** fixes the “logout but still logged in” class of issues caused by cookie divergence.

### B) Multi-cookie responses via API Gateway v2 `cookies`
**Change:** handlers return cookies using the Lambda proxy `cookies: string[]` field rather than a single `Set-Cookie` header.

**Why it matters:** supports multiple cookie variants in a standards-compliant way and avoids overwriting.

### C) UI: avoid implicit switching when Crossmint-authenticated
**Change:** if a Crossmint-authenticated user connects a Phantom wallet that differs, the UI requires an explicit action.

- “Switch” performs Crossmint logout first to prevent split-brain.
- “Ignore” leaves session unchanged.

Implemented in:
- `packages/admin-ui/src/components/WalletLogin.tsx`

### D) UI bootstrap: backend session is source of truth
**Change:** after `/auth/me`, if backend says unauthenticated, clear persisted Crossmint auth state so it can’t “resurrect” UI.

Implemented in:
- `packages/admin-ui/src/store/crossmintAuth.ts` (adds `resetLocal()`)
- `packages/admin-ui/src/App.tsx` (clears local Crossmint auth if backend unauthenticated)

---

## Implemented Improvements (P2)

### E) Production auth: remove origin/referer fallback
**Change:** admin auth no longer permits “admin-by-Origin” or “admin-by-Referer” when no token is present.

Implemented in:
- `packages/admin-api/src/auth/cloudflare-access.ts`

Test coverage:
- `packages/admin-api/src/auth/cloudflare-access.test.ts`

Configuration:
- `ADMIN_EMAILS` (comma-separated)
- `ADMIN_WALLETS` (comma-separated base58 wallet addresses)

Also used:
- `AUTH_DOMAIN` (used to compute parent-domain cookie scope)
- `CF_ACCESS_CERTS_URL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (when validating CF Access JWTs)

---

## Target End State (Production-Ready Auth)

### Design principles
- **One session cookie** from the backend is the single source of truth.
- **Account is not a wallet**. An account can have multiple linked identities.
- **Linking is explicit** and reversible.
- **Switching is explicit** and always user-confirmed.
- **Gating is account-level** (evaluate across linked wallets).

---

## Implemented Data Model (Account + Identity)

### Entities

#### Account
Represents a single user/customer.
- `accountId` (UUID)
- `createdAt`
- `role` (e.g., `user | admin`) or a richer permissions set
- Optional product fields (tier, billingCustomerId, etc.)

#### Identity
A login/ownership method linked to an account.
- `identityId` (UUID)
- `accountId`
- `type`: `wallet | crossmint`
- `providerId`:
  - Wallet: canonical wallet public key (base58)
  - Crossmint: Crossmint user id / subject
- `createdAt`
- Optional metadata: display name, email hash, etc.

#### Session
Server-side session bound to an account.
- `sessionToken` (opaque random)
- `accountId`
- `createdAt`, `expiresAt`, `lastSeenAt`
- Optional: `authMethod` (wallet/crossmint), `ipHash`, `uaHash`

### DynamoDB strategy (current)
The implementation uses a single-table-style approach for account + identity mapping:
- `ACCOUNT#<accountId>` for the account root item
- `IDENTITY#wallet#<walletAddress>` and `IDENTITY#crossmint#<crossmintUserId>` mapping items that point to `accountId`

Implementation entry points:
- `packages/admin-api/src/services/accounts.ts`
- `packages/admin-api/src/services/wallet-link.ts`
- `packages/admin-api/src/services/account-gate.ts`

---

## API Spec (P1)

These endpoints are now implemented; the notes below describe the intended contract.

### Auth

#### `GET /auth/me`
Returns backend session status and the canonical authenticated account.

Response:
```json
{
  "isAuthenticated": true,
  "account": {
    "accountId": "...",
    "role": "user",
    "identities": [
      { "type": "wallet", "providerId": "<base58>" },
      { "type": "crossmint", "providerId": "<sub>" }
    ]
  }
}
```

Notes:
- UI should treat this endpoint as the only authority.
- If `isAuthenticated=false`, UI should clear any persisted provider state.

Current response shape uses `authenticated: boolean` (legacy) and includes `account`, `user`, and account-level gating fields:
- `gateStatus`, `gateWallet`, `gateStatusByWallet`

### Link wallet to current account

#### `POST /auth/link/wallet/challenge`
Requires authenticated session.

Request:
```json
{ "walletAddress": "<base58>" }
```

Response:
```json
{
  "message": "Sign this message to link wallet ...",
  "nonce": "...",
  "expiresAt": 1730000000000
}
```

Rules:
- Challenge must be single-use and expire quickly (e.g., 5 minutes).
- Message includes `accountId`, `walletAddress`, nonce, expiry, and domain/origin context.

#### `POST /auth/link/wallet/verify`
Requires authenticated session.

Request:
```json
{
  "walletAddress": "<base58>",
  "nonce": "...",
  "signature": "<base58|base64>"
}
```

Response:
```json
{ "success": true }
```

Server behavior:
- Verify signature over the exact challenge message.
- Ensure nonce is unused and unexpired.
- Enforce uniqueness: a wallet can only be linked to one account.

Test coverage:
- `packages/admin-api/src/services/wallet-link.test.ts`

### Link Crossmint identity to current account

#### `POST /auth/link/crossmint/verify`
Requires authenticated session (cookie).

Behavior:
- Verifies the Crossmint JWT (proof of Crossmint identity)
- Links `IDENTITY#crossmint#<userId>` to the current `accountId`
- Does not create a new backend session (no cookie mutation)

Test coverage:
- `packages/admin-api/src/services/accounts.test.ts`

---

## Remaining onboarding UX requirements

These are the only remaining TODOs in the auth plan dashboard:
- After email/social login, show the embedded wallet and a CTA to “Link existing wallet to use your Orbs”.
- If the embedded wallet has no Orbs, explain “limited mode” and how to unlock (link wallet or acquire Orbs).
- Provide a stable “Account” view that answers: which identities are linked, which wallet has Orbs, and what features are unlocked.
- On success: attach wallet identity to account.

### Switch account (optional but recommended)

#### `POST /auth/switch/wallet`
This is a “sign in as this wallet” flow, not linking.
- Clears existing session
- Establishes session for whichever account owns that wallet, or creates a new account.

---

## UX Spec (P1)

### “Link vs Switch” modal
Triggered when:
- User is authenticated (Crossmint or wallet)
- A different wallet is connected

Options:
- **Link this wallet** (recommended): keeps current account, adds wallet identity.
- **Switch account**: logs out current session and signs in as the connected wallet.

The UI should never auto-switch identities.

### Onboarding flow recommendation
- If user starts with Crossmint email/social: after initial login, prompt “Connect a wallet (optional)” with clear explanation and a skip option.
- If user starts with wallet: after login, offer “Add email login (optional)” (Crossmint) for account recovery / cross-device convenience.

---

## Gating & Ownership (P1)

### Orb/NFT gating should be account-level
When checking gating:
- Evaluate across **all linked wallet identities**.
- If the currently connected wallet differs, show:
  - “Your account has Orbs on Wallet X. Connect it or link it.”

This eliminates the "I paid but I’m in limited mode" confusion.

---

## Security Considerations

### Cookie security
- `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- Avoid “dual cookies” by standardizing Domain usage; clear both variants defensively.

### CSRF
If you rely on cookies, protect state-changing endpoints:
- `SameSite=Lax` mitigates many cases, but consider adding:
  - Origin checks (`Origin` / `Referer`) for browser calls
  - CSRF token for high-risk endpoints (link/unlink, billing, admin actions)

### Challenge replay protection
- Nonce stored server-side; single-use.
- Short expiry.
- Signature binds to `accountId` and `walletAddress`.

### Rate limiting
- Rate limit challenges and verifies per session + per IP.

### Logging
- Log structured events for auth transitions: `login_success`, `logout`, `session_invalid`, `link_success`, `link_conflict`.

---

## Migration Plan

1. **Introduce Account/Identity storage** behind feature flags.
2. On next login for any user:
   - Create an account if none exists.
   - Create an identity mapping for the provider.
   - Store `accountId` on the session.
3. Update gating checks to resolve identities via account.
4. Add linking UI + endpoints.

---

## Testing Plan

The TODO checklist for this work is tracked in:
- `packages/plan-tests/authentication-signup.todo.test.ts`

As each feature ships, convert the relevant `test.todo(...)` items into real tests (or integration tests using your existing test harnesses).

---

## Out of Scope (for this doc)
- Telegram webhook authentication, platform adapter auth, and non-admin API security.
- Billing implementation details.
- Full RBAC/permissions system (beyond the need for account roles).
