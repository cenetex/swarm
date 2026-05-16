# NFT Ownership Verification — Avatar Access Audit (2026-04-17)

**Auditor:** Claude (Opus 4.7)
**Trigger:** `TODO(#857)` at `packages/mcp-server/src/tools/nft.ts:480` referenced a closed issue. Issue #1361 asked whether the check had been wired in (comment rot) or whether the original gap still existed.
**Verdict:** ❌ **(b) Check missing on all production access paths.** The TODO accurately reflects an un-remediated security gap. Issue #857 was closed on 2026-03-08 without the fix landing.
**Follow-up:** #1385 — enforce re-verification across all paths.

## Claim vs. Access

Two distinct moments are involved in NFT-backed avatars:

| Moment | What's verified | Status |
|---|---|---|
| **Claim time** — `claim_nft_as_avatar` MCP tool, `createAvatarFromNFT` service | Caller owns the NFT *now* (Helius balance check via `verifyNFTOwnership`) | ✅ Correctly enforced |
| **Every subsequent access** — message send, tool invocation, chat, webhook, profile update | Nothing. Access is gated by the `creatorWallet` field stored at claim time | ❌ **Not enforced** |

Once an NFT is claimed, the claimer's wallet is baked into the avatar record. Transferring the NFT to another wallet does not change this record and does not revoke the original claimer's access. This violates the product promise that "selling the NFT revokes access."

## The dormant helper

`getAvatarWithOwnershipCheck()` exists at `packages/admin-api/src/services/avatars.ts:897-921`. Its own leading comment notes it is *not* wired into any request path. Behavior:

- For non-NFT avatars: returns the avatar if `creatorWallet` matches.
- For NFT-backed avatars: calls `verifyNFTOwnership(walletAddress, avatar.nftMint)` against Helius to check *current* on-chain ownership.

The function is correct; it is simply never called.

## Access-path inventory

Every production path that resolves an avatar for a caller was traced. None re-verifies ownership.

| Path | Entry point | File:line | Gate |
|---|---|---|---|
| Admin-API GET /avatars/{id} | `avatar-routes/crud.ts` | `packages/admin-api/src/handlers/avatar-routes/crud.ts:312` | `getAvatar()` — no ownership check |
| Admin-API PUT /avatars/{id} | `avatar-routes/crud.ts` | `packages/admin-api/src/handlers/avatar-routes/crud.ts:344` | `getAvatar()` — no ownership check |
| Admin-API POST /chat | `chat.ts` | `packages/admin-api/src/handlers/chat.ts:360` | `getAvatar()` — no ownership check |
| Admin-API POST /chat (stream) | `chat-stream.ts` | `packages/admin-api/src/handlers/chat-stream.ts` | `getAvatar()` — no ownership check |
| OpenAI-compat POST /v1/chat/completions | `openai-compat.ts` | `packages/admin-api/src/handlers/openai-compat.ts:501, 623, 738` | `getAvatar()` — no ownership check |
| OpenAI-compat stream variant | `openai-compat-stream.ts` | `packages/admin-api/src/handlers/openai-compat-stream.ts` | `getAvatar()` — no ownership check |
| Telegram webhook | `telegram-webhook-shared.ts` | `packages/handlers/src/telegram/telegram-webhook-shared.ts` | `getAvatarConfig()` from state cache — no ownership check |
| Discord gateway | `discord-gateway-shared.ts` | `packages/handlers/src/discord/discord-gateway-shared.ts` | `getAvatarConfigWithStatus()` — no ownership check |
| Twitter autonomous poster | `autonomous-tweet-poster.ts` | `packages/handlers/src/twitter/autonomous-tweet-poster.ts` | `getAvatarConfigWithStatus()` — no ownership check |
| SQS message processor | `message-processor.ts` | `packages/handlers/src/messaging/message-processor.ts` | `getAvatarConfig()` from state cache — no ownership check |
| MCP inhabit/abandon/ascension tools | `packages/mcp-server/src/tools/**` | multiple | `getAvatarInhabitationStatus()` — no ownership check |
| MCP `claim_nft_as_avatar` (claim-time only) | `tools/nft.ts` | `packages/mcp-server/src/tools/nft.ts:480` → `services.claimNFTAsAvatar()` → `verifyNFTOwnership` at `services/avatars.ts:716` | ✅ Correctly enforced at claim |

## Repro

User A claims avatar X (NFT `mint_X` owned by A). `creatorWallet = A` is persisted.
User A transfers NFT `mint_X` to user B off-chain / via Jupiter / via direct Solana transfer.
User A (wallet A, still authenticated) sends a message via POST /chat for avatar X.
The handler resolves the avatar via `getAvatar(avatarId)`, sees `creatorWallet = A`, matches against the authenticated session, and serves the request.
User A continues to speak as avatar X. User B — the current NFT holder — has no access.

## Existing documentation of the gap

A test file `packages/admin-api/src/handlers/avatar-routes/nft-ownership-access.test.ts` explicitly documents the missing check in its leading comment (lines 1-29): *"getAvatarWithOwnershipCheck() exists in services/avatars.ts but is not wired into any request path."* The test asserts the current (bypassable) behavior rather than the desired one, so it cannot fail when a regression reintroduces the gap.

## Risk

- **Exploitability:** low — requires owner cooperation (the original claimer has no reason to voluntarily transfer if it costs them access).
- **Product truth:** the promise that "selling the NFT revokes access" is currently false. If the token is marketed on the basis of that promise, it is a misrepresentation.
- **Blast radius:** any NFT-backed avatar whose NFT has changed hands post-claim. Observable by comparing `avatars.creatorWallet` against current Helius owner for each `avatars.nftMint`.

## Recommendation

**Outcome (b) — open follow-up fix issue.** Do **not** remove the `TODO(#857)` at `packages/mcp-server/src/tools/nft.ts:480`; it is accurate and serves as the last in-code pointer to the gap until the fix lands.

Follow-up tracked as #1385. Design considerations captured there:

- Synchronous Helius lookup per request is too expensive on the hot path — needs short-TTL caching or background re-verification.
- Webhook handlers read from the state-service cache, not admin-api — any fix must propagate to both packages.
- Decide whether every access path gets the check or whether specific paths (e.g., read-only public profile view) are explicitly exempt with justification.

## Remediation

Landing across three PRs against #1385. Design principle: **verify at message entry, exempt downstream layers that inherit the gate.**

### PR 1 — admin-api slice (shipped #1397)

- New `packages/admin-api/src/services/nft-ownership-cache.ts` — two-tier cache (10s in-memory LRU + 60s DynamoDB keyed `NFT_OWNER#<mint>/CURRENT`), fail-closed on Helius outage, emits `NFTOwnershipCacheMiss` EMF metric.
- New `assertAvatarOwnership(avatarId, wallet, { isAdmin })` in `services/avatars.ts` — unified gate with typed `AvatarOwnershipError` (`not_found`, `not_owner`, `nft_revoked`, `verification_unavailable`). Claim-time cache invalidation wired into `createAvatarFromNFT`.
- Wired into 6 admin-api entry points: `GET/PUT /avatars/{id}`, `POST /chat` + stream, `POST /v1/chat/completions` + stream.
- Product-level outcome: NFT transfer revokes access **within ~60 seconds** on admin-api paths. Admins still bypass (unchanged admin semantics).

### PR 2 — MCP slice (exempt, shipped #1414)

**Determination: option (b) exempt with justification.**

The MCP tool package does not introduce a new entry point for callers; every MCP tool invocation happens **inside a session already authenticated by an upstream layer** — admin-api (PR 1), webhook handlers (PR 3), or an autonomous avatar tick (no caller to gate). Every tool in `packages/mcp-server/src/tools/nft.ts` that takes `context.avatarId` is a `defineReadonlyTool` self-awareness tool (`get_my_inhabitation_status`, `get_my_lineage`, `get_my_ascension_status`, `get_inhabitation_link`). Adding a per-tool `assertAvatarOwnership` call would duplicate the upstream gate, multiply Helius / cache cost linearly in tools-per-turn (3-10 tools per typical turn), and create a drift vector.

The single MCP write-tool, `claim_nft_as_avatar`, still verifies ownership at claim time via `verifyNFTOwnership` (unchanged).

### PR 3 — webhook and autonomous handler wiring (shipped #1416)

PR 3 completed the handler-side enforcement path:

1. `AvatarConfig` now carries `nftMint` and `creatorWallet` in `packages/core/src/types/platform.ts`, and `packages/admin-api/src/services/config-sync.ts` copies those fields from the admin avatar record into state.
2. `packages/infra/src/constructs/shared-handlers.ts` injects `HELIUS_API_KEY`, `HELIUS_API_KEY_ARN`, and `NFT_OWNERSHIP_ENFORCEMENT` into shared handler Lambdas, with secret grants for Helius-backed cache misses.
3. `telegram-webhook-shared.ts`, `discord-gateway-shared.ts`, and `autonomous-tweet-poster.ts` call `assertAvatarStillOwnedByClaimer` after resolving avatar config. Revoked or unverifiable NFT ownership is dropped before message/post processing.
4. `packages/handlers/src/telegram/nft-ownership-enforcement.test.ts` covers post-transfer revocation, current-owner pass-through, fail-closed verification outages, and non-NFT pass-through.

### PR 4 — remaining authorization gaps (this PR, #1728)

This PR closes the remaining gaps found after the three-part #1385 remediation:

1. `requireOwnerOrAdmin` now delegates to `services/avatars.assertAvatarOwnership`, so every route using the shared avatar-route guard re-verifies NFT ownership instead of comparing stale `creatorWallet`.
2. OpenAI-compatible API keys now persist the creating wallet and an explicit `adminBypass` flag. Scoped keys for NFT-backed avatars are re-checked on every use; legacy keys without owner metadata cannot access NFT-backed avatars unless they are admin bypass keys.
3. Billing, jobs, Twitter OAuth, onboarding, and ascension management paths now use the same ownership authorizer for non-admin access.
4. Handler-side ownership verification fails closed when `nftMint` is present but `creatorWallet` is missing.
5. Infra defaults enable NFT ownership enforcement in prod whenever a Helius key or Helius secret ARN is configured, while preserving explicit `nftOwnershipEnforcement=off` overrides.
6. The resource-count guard is active again and stubs Lambda code bundling in-test so it counts CloudFormation resources without fetching package artifacts.

**Message-processor exemption**

Of the remaining audit paths:

- `packages/handlers/src/messaging/message-processor.ts` is **exempt**. It reads from the SQS message queue, whose producers (webhook handlers + admin-api) are now all gated. A message that reaches the processor has already passed an upstream check. Processing must not double-gate because by the time a message is dequeued, the caller context (wallet, session) is gone.
The former `packages/handlers/src/twitter/autonomous-tweet-poster.ts` gap is closed by PR 3; autonomous posts are gated by `assertAvatarStillOwnedByClaimer`.

## Cross-references

- Issue #857 — original tech-debt issue, closed prematurely on 2026-03-08.
- Issue #1361 — verification task that triggered this audit.
- Issue #1385 — remediation.
- Issue #1728 — remaining authorization gaps closed after the initial remediation.
- PR #1397 — remediation PR 1 (admin-api, shipped 2026-04-17).
- PR #1414 — remediation PR 2 (MCP exemption, 2026-04-19).
- PR #1416 — remediation PR 3 (webhook and autonomous handler wiring).
- Code: `packages/core/src/services/nft-ownership-cache.ts` — shared factory (PR 3 infrastructure).
- Code: `packages/admin-api/src/services/nft-ownership-cache.ts` — admin-api binding (PR 3 infrastructure).
- Code: `packages/handlers/src/services/nft-ownership-cache.ts` — handler binding (PR 3 infrastructure).
- Code: `packages/handlers/src/services/assert-avatar-ownership.ts` — handler gate helper (PR 3 infrastructure).
- Code: `packages/admin-api/src/services/avatars.ts` — `assertAvatarOwnership()` (PR 1), `:716` (claim-time verify).
- Code: `packages/mcp-server/src/tools/nft.ts` — claim-time verify at `claimNFTAsAvatar`; MCP-exempt top-of-file comment (PR 2).
- Test: `packages/admin-api/src/handlers/avatar-routes/nft-ownership-access.test.ts` — asserts post-transfer revocation end-to-end (PR 1).
