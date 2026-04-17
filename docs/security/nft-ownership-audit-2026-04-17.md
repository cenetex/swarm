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

## Cross-references

- Issue #857 — original tech-debt issue, closed prematurely on 2026-03-08.
- Issue #1361 — verification task that triggered this audit.
- Issue #1385 — remediation.
- Code: `packages/admin-api/src/services/avatars.ts:897-921` (unused helper), `:716` (claim-time verify).
- Code: `packages/mcp-server/src/tools/nft.ts:480` (dormant TODO).
- Test: `packages/admin-api/src/handlers/avatar-routes/nft-ownership-access.test.ts` (documents current gap).
