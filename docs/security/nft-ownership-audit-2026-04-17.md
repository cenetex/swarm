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

### PR 2 — MCP slice (exempt, this PR)

**Determination: option (b) exempt with justification.**

The MCP tool package does not introduce a new entry point for callers; every MCP tool invocation happens **inside a session already authenticated by an upstream layer** — admin-api (PR 1), webhook handlers (PR 3), or an autonomous avatar tick (no caller to gate). Every tool in `packages/mcp-server/src/tools/nft.ts` that takes `context.avatarId` is a `defineReadonlyTool` self-awareness tool (`get_my_inhabitation_status`, `get_my_lineage`, `get_my_ascension_status`, `get_inhabitation_link`). Adding a per-tool `assertAvatarOwnership` call would:

1. **Duplicate the upstream gate** — the same caller / avatar pair has already been checked milliseconds earlier at the chat entry.
2. **Multiply Helius / cache cost linearly in tools-per-turn** — a typical chat turn fires 3-10 tools. With a 60s DynamoDB TTL this is mostly cache hits, but the added cost buys no additional security.
3. **Create a drift vector** — every new MCP tool author would have to remember to wire the gate manually; the centralized upstream gate is harder to forget.

The single MCP write-tool, `claim_nft_as_avatar`, still verifies ownership **at claim time** via `verifyNFTOwnership` (unchanged, correctly enforced — see claim-time column at the top of this document). No other MCP tool mutates avatar ownership state.

Operationally this means: if a caller somehow reached an MCP tool without passing through an upstream gate (a future misuse, e.g. a new MCP transport that bypasses admin-api), **the gap reopens silently**. The mitigation is architectural — gates live on entry points, and new entry points must call `assertAvatarOwnership` themselves. PR 3 (webhook slice) is an example of that discipline.

### PR 3 — webhook slice (pending)

Remaining access paths from the inventory above:

- `packages/handlers/src/telegram/telegram-webhook-shared.ts`
- `packages/handlers/src/discord/discord-gateway-shared.ts`
- `packages/handlers/src/twitter/autonomous-tweet-poster.ts` (autonomous — may be exempt like MCP)
- `packages/handlers/src/messaging/message-processor.ts`

Webhook handlers read from the state-service cache, not admin-api, so the caching layer must either be extended or a thin handler-side equivalent of `assertAvatarOwnership` added. PR 3 will also reconcile whether twitter autonomous posting and message-processor fall under the same exemption rationale as MCP (no caller wallet in context) or need their own gate.

## Cross-references

- Issue #857 — original tech-debt issue, closed prematurely on 2026-03-08.
- Issue #1361 — verification task that triggered this audit.
- Issue #1385 — remediation.
- PR #1397 — remediation PR 1 (admin-api, shipped 2026-04-17).
- Code: `packages/admin-api/src/services/avatars.ts` — `assertAvatarOwnership()` (PR 1), `:716` (claim-time verify).
- Code: `packages/admin-api/src/services/nft-ownership-cache.ts` — two-tier cache (PR 1).
- Code: `packages/mcp-server/src/tools/nft.ts` — claim-time verify at `claimNFTAsAvatar`; MCP-exempt comment documents PR 2.
- Test: `packages/admin-api/src/handlers/avatar-routes/nft-ownership-access.test.ts` — asserts post-transfer revocation end-to-end (PR 1).
