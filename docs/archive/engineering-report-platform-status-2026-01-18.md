# Engineering Report: Platform Status (Consolidated)

**Date:** 2026-01-18
**Scope:** Admin UI + Admin API + MCP tools (chat, onboarding, voice/media)
**Sources (superseded and removed after consolidation):**
- Engineering Report: Chat System Improvements (2026-01-18)
- Engineering Report: User Onboarding Issues (2026-01-18)
- Engineering Report: Synthesis of Remaining Gaps (2026-01-18)
- Engineering Report: Voice UI Reliability + Tool/Chat Split Plan (2026-01-18)

---

## Executive Summary

This report consolidates the four engineering reports from 2026-01-18 into a single, repo-verified status snapshot.

**What’s in good shape now (verified in code):**
- Chat reliability has concrete guardrails (idempotency + LLM circuit breaker).
- Telegram bot token setup is transactional-ish (validate → register webhook → persist config/secrets) and returns status.
- Replicate API key is validated before storage.
- Wallet address UX supports copy-to-clipboard.
- Voice/media rendering is improved so audio can render immediately when surfaced as media.

**What remains:**
- Diagnostics + UX gaps (Telegram diagnosis tool, clearer onboarding verification, access-mode edge cases).
- Architecture debt (monolithic chat orchestration, MCP adapter size, hardcoded pause-for-input behavior).
- Performance ergonomics (SSE job updates).
- Tool/content model split is still a design plan, not implemented.

---

## Verified Shipped Work (Evidence in Repo)

### Chat Reliability

- **Idempotency support in `/chat`**
  - Reads/writes `Idempotency-Key` header and caches responses.
  - Evidence: `chatIdempotencyStore` used in `packages/admin-api/src/handlers/chat.ts`.

- **LLM circuit breaker**
  - Rejects LLM execution when open; tracks success/failure.
  - Evidence: `llmCircuitBreaker` in `packages/admin-api/src/services/circuit-breaker.ts` and usage in `packages/admin-api/src/handlers/chat.ts`.

### Telegram Setup Improvements

- **Token setup performs webhook registration before persisting state**
  - Validates token, generates secret, registers webhook, then persists avatar + secrets.
  - Evidence: `packages/admin-api/src/services/telegram-setup.ts` and usage in `packages/admin-api/src/handlers/avatars.ts`.

- **User-facing Telegram status returned on secret store**
  - Evidence: `telegramStatus` returned from `POST /avatars/{id}/secrets` in `packages/admin-api/src/handlers/avatars.ts`.

### Replicate Key UX

- **Replicate key validated before storage**
  - Evidence: `validateReplicateApiKey()` path in `packages/admin-api/src/handlers/avatars.ts`.

### Wallet UX + Linking

- **Copyable wallet addresses**
  - Evidence: `packages/admin-ui/src/components/CopyableAddress.tsx` and use in `packages/admin-ui/src/components/WalletLogin.tsx`.

- **Wallet linking supports Phantom signing fallback**
  - Evidence: `phantomProvider?.signMessage` usage and `signWalletLinkMessage()` in `packages/admin-ui/src/components/WalletLogin.tsx`.

### Voice / Media Rendering

- **Audio can render from message media**
  - Media typing supports `audio` and UI renders audio accordingly.
  - Evidence: `packages/admin-ui/src/components/ChatMessage.tsx` and `packages/admin-api/src/handlers/chat.ts` media extraction.

---

## Remaining Gaps (Prioritized)

### P0 — User Blockers / High-Impact UX

1) **Telegram diagnostics & verification UX**
   - Gap: no `diagnose_telegram` tool exists; users still lack a simple “is it wired up?” check.
   - Desired: tool that reports token presence, webhook URL/info, pending update count, last errors, and “last message received” signal.

2) **Access-mode edge cases (browse/limited/chat/admin)**
   - Gap: still worth hardening transitions (wallet auth changes, avatar switching, inhabit/creator changes).
   - Desired: centralized selector/state derivation + regression tests for transitions.

### P1 — Reliability / Performance

3) **SSE (or push) for job completion**
   - Gap: no `text/event-stream`/`EventSource` implementation detected; polling remains the strategy.
   - Desired: SSE endpoint (plus polling fallback) to reduce redundant polling across tabs.

4) **Pause-for-input behavior still hardcoded**
   - Gap: tool interactivity is still driven by name lists / UI assumptions rather than tool metadata.
   - Desired: declarative tool metadata (e.g. `interaction: { pauseForInput: true, ... }`) used by both API + UI.

### P2 — Maintainability / Architecture

5) **`processChat` / chat handler complexity**
   - Gap: orchestration is still concentrated and hard to test in isolation.
   - Desired: modular boundaries (`context`, `llm`, `tools`, `response`) and targeted unit tests.

6) **MCP adapter size / coupling**
   - Gap: adapter consolidation remains a change-risk hotspot.
   - Desired: split by domain (media, wallet, social, gallery, secrets, jobs).

### P3 — Product / Optional Enhancements

7) **Wallet export flow**
   - Gap: no UI/API references to `exportWallet()` detected.
   - Desired: confirm Privy support and add a gated export/migration experience.

8) **Tool/content model split**
   - Gap: still a design plan.
   - Desired: route tool planning to a tool-capable model; allow user-selected content model for final responses with clear UI messaging.

---

## Recommended Next Steps (2-Week Slice)

**Note:** The Step Functions “agent runtime” architecture work is intentionally deferred until these bugfixes and hardening tasks land; see [docs/legacy/2026-01/reports/engineering-report-agentic-resilience-stepfunctions-2026-01-19.md](legacy/2026-01/reports/engineering-report-agentic-resilience-stepfunctions-2026-01-19.md).

**Week 1**
1) Add `diagnose_telegram` tool and surface a “Telegram setup verified” summary after token setup.
2) Add access-mode transition tests (store selector) and fix any reproducible race.

**Week 2**
3) Add SSE job subscription endpoint + UI integration; keep polling fallback.
4) Start the pause-for-input metadata contract (tool definitions → API → UI).

---

## Discord Integration Status (Updated 2026-02-07)

Discord is explicitly **out of scope for M1** (see PLAN.md) and targeted for feature parity with Telegram in **M2 (3-9 months)**.

### What's implemented (~70%)

| Area | Status | Evidence |
|------|--------|----------|
| Core adapter (webhook + bot + hybrid modes) | Implemented | `packages/core/src/platforms/discord.ts` (683 LOC) |
| Ed25519 signature verification | Implemented | `DiscordAdapter.verifyRequest()` |
| Message + interaction parsing | Implemented | `parseMessage()`, `parseInteraction()`, `parseMessageEvent()` |
| Gateway WebSocket worker | Implemented | `packages/handlers/src/discord-gateway.ts` (424 LOC) |
| Webhook Lambda handler | Implemented | `packages/handlers/src/discord-webhook.ts` (276 LOC) |
| Admin API service (status, messaging, channels, guilds) | Implemented | `packages/admin-api/src/services/discord.ts` (585 LOC) |
| MCP tool definitions (13 tools) | Implemented | `packages/mcp-server/src/tools/discord.ts` (733 LOC) |
| CDK infra (webhook Lambda + ECS gateway) | Implemented | `packages/infra/src/constructs/avatar.ts`, `shared.ts` |

### Known gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| `setPresence()` not implemented | Medium | MCP tool `discord_set_status` defined but backend function missing; returns fallback message |
| `getChannelSummary()` not implemented | Low | Falls back to basic message count |
| No rate limiting | High (for production) | Discord enforces 10 req/10sec per channel; no throttling in codebase |
| `MESSAGE_CONTENT` privileged intent not validated | Medium | Gateway assumes bot has privileged intent approval; silent message drops if missing |
| Webhook ignores `channelId` parameter | Medium | `sendMessage()` always routes to stored webhook URL regardless of target channel |
| No slash command registration flow | Low | Tool infrastructure exists but no dynamic command registration |
| No thread/forum support | Low | Not handled |
| No message edit/delete | Low | Send-only |
| Interaction token expiry not handled gracefully | Low | 15-min tokens; no timeout error handling |
| Fargate gateway has no health checks or auto-scaling | Medium | Always 1 instance, no graceful shutdown for reconnection |
| Zero tests for Discord adapter | High | SWARM-007 Phase 3 scope; not yet started |

### Comparison with Telegram

| Capability | Telegram | Discord |
|------------|----------|---------|
| Production maturity | ~95% (stable MVP) | ~70% (beta, deferred) |
| Home channel redirection | Yes | No |
| DM/channel allowlisting | Yes | No |
| Rate limiting | Handled | None |
| Integration tests | Comprehensive | None |
| Diagnostics/runbook | Yes (SWARM-016) | None |
| Admin tooling | Full setup/verify flow | Basic connection status |

### M2 path to parity

1. Implement `setPresence()` backend
2. Add rate limiting middleware for Discord API calls
3. Add intents validation on gateway startup
4. Fix webhook channel targeting logic
5. Add Discord-specific tests (SWARM-007 Phase 3)
6. Create Discord operational runbook
7. Implement slash command registration
8. Add thread/forum support

---

## Notes on This Consolidation

- This report is intentionally **evidence-based** (items listed as "done" are backed by repository code paths).
- The superseded reports were kept highly actionable but overlapped heavily; this doc replaces them to reduce drift.
