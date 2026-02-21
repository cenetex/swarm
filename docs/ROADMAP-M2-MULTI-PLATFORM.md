# Roadmap: M2 Multi-Platform Parity

**Status:** Planning (research complete, pending implementation)

**Last reviewed:** 2026-02-21

**Prerequisite:** M1 Paid Telegram MVP (see [ROADMAP-M1-PAID-TELEGRAM-MVP.md](ROADMAP-M1-PAID-TELEGRAM-MVP.md))

This document defines the M2 milestone: bringing Discord and Twitter (X) adapters to feature parity with Telegram, unifying the tool registry, surfacing usage metering in the admin UI, adding SQS payload offload for large media, integrating Stripe for self-serve billing, and hardening the shipped semantic retrieval path with production coverage tracking, benchmarks, and regression tests.

---

## What "M2 done" means (acceptance criteria)

An operator can:
1. Deploy an avatar to Discord, Twitter, or Telegram with equivalent core capabilities.
2. Use a single tool registry that is shared by the admin API chat and the platform runtime handlers.
3. View daily/weekly usage (messages, media, voice, tool calls) inside the admin chat.
4. Subscribe to a paid plan via Stripe Checkout, manage billing via the customer portal, and see overages reflected in invoices.
5. Send and receive media payloads larger than 256 KB without hitting SQS size limits.
6. Inspect and replay messages from the dead-letter queue via admin tools.
7. Demonstrate higher-relevance memory retrieval via the shipped semantic path with production embedding coverage, a benchmark harness, and regression evidence.

Primary references:
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- Web2 Floor + Web3 Ceiling model, tier definitions
- [ROADMAP-M1-PAID-TELEGRAM-MVP.md](ROADMAP-M1-PAID-TELEGRAM-MVP.md) -- M1 scope and shipped items
- [TOOL-COMPOSITION-OBSERVABILITY-RFC.md](TOOL-COMPOSITION-OBSERVABILITY-RFC.md) -- Tool metadata and composition design
- [PLAYBOOK-M2-MULTI-PLATFORM.md](PLAYBOOK-M2-MULTI-PLATFORM.md) -- execution cadence, readiness gates, and rollout checklist
- [SEMANTIC-MEMORY-DESIGN.md](SEMANTIC-MEMORY-DESIGN.md) -- embedding architecture, hybrid scoring formula, migration strategy

---

## 1. Current State -- Feature Matrix

### 1.1 Adapter Capabilities

| Capability | Telegram | Discord | Twitter | Notes |
|---|:---:|:---:|:---:|---|
| **Ingestion** | | | | |
| Text messages | Y | Y | Y (polling) | Twitter uses mention poller, not webhooks |
| Photo/image | Y | Y | Partial | Twitter: media URLs extracted, no file download on ingest |
| Video | Y | Y | Partial | Same as photo |
| Voice/audio | Y | N | N/A | Discord: no voice message ingest |
| Sticker | Y | N | N/A | Discord: sticker events not parsed |
| Document/file | Y | Y | N/A | |
| Animation/GIF | Y | Partial | N/A | Discord: treated as generic attachment |
| Forward metadata | Y | N | N/A | Telegram API 7.0+ forward_origin extraction |
| Reply detection | Y | Y | Y | |
| Mention detection | Y | Y | Y | |
| DM handling | Y | Y | N | Twitter DM API not integrated |
| **Sending** | | | | |
| Text reply | Y | Y | Y | |
| Photo/image | Y (sendPhoto) | Y (embed URL) | Y (media upload) | Discord uses embed, not file upload |
| Video | Y (sendVideo) | Y (embed URL) | Y (media upload) | Same as photo |
| Voice | Y (sendVoice) | N (text+URL) | N (text+URL) | Discord/Twitter fall back to text with URL |
| Sticker | Y (sendSticker) | N | N/A | Discord: no sticker send API used |
| Typing indicator | Y | Y | N/A | |
| Reactions | Y (setMessageReaction) | Y (addReaction) | Y (like) | Twitter "react" maps to like |
| Image compression | Y (Jimp) | N | Y (sharp resize) | Discord relies on embed URLs, no compression needed |
| **Infrastructure** | | | | |
| Webhook ingestion | Y (shared, multi-tenant) | Y (per-avatar) | N (polling) | |
| Gateway/WebSocket | N/A | Y (ECS Fargate) | N/A | |
| Home channel registry | Y | N | N/A | |
| DM allowlisting | Y | N | N/A | |
| Admin commands (/activate) | Y | N | N/A | |
| Signature verification | Y (HMAC secret token) | Y (Ed25519) | N/A (polling) | |
| Bot profile management | Y (set name/desc) | N | N | |
| Multi-tenant handler | Y | N | N | Discord is per-avatar Lambda + shared gateway |

### 1.2 MCP Tool Coverage

| Tool Category | Telegram | Discord | Twitter | Notes |
|---|:---:|:---:|:---:|---|
| Platform diagnostics | `diagnose_telegram` | `discord_status` | `twitter_status` | All present |
| Send message | `telegram_send_to_chat` | `discord_send`, `discord_webhook_send` | `twitter_post`, `twitter_reply` | |
| List conversations | `telegram_list_chats`, `telegram_discover_chats` | `discord_list_guilds`, `discord_list_channels`, `discord_list_all_channels` | `twitter_get_timeline`, `twitter_get_mentions` | |
| Read messages | `telegram_get_chat_info` | `discord_get_messages`, `discord_get_channel`, `discord_get_channel_summary` | `twitter_get_tweet`, `twitter_get_activity_summary` | |
| Reactions | `react_to_message` | `discord_react`, `discord_unreact` | `twitter_like`, `twitter_unlike` | |
| Bot profile | `set_bot_name`, `set_bot_description`, `set_bot_short_description` | N | N | Gap: Discord/Twitter have no profile tools |
| Typing indicator | `send_typing_indicator` | N (via adapter only) | N/A | Gap: no MCP tool for Discord typing |
| User info | `get_user_profile_photos` | N | N | Gap: Discord/Twitter user info tools |
| Chat governance | `propose_chat_change`, `vote_on_chat_change`, `list_chat_proposals`, `check_chat_modification_limit` | N | N | Telegram-specific governance model |
| Content moderation | N | N | `twitter_set_moderation_mode`, `twitter_get_moderation_stats`, `twitter_list_pending_posts`, `twitter_approve_post`, `twitter_reject_post`, `twitter_downrank_post`, `twitter_get_simulated_feed` | Twitter-specific content store |
| Presence/status | N | `discord_set_status` | N | Discord-specific |
| Repost/share | N | N | `twitter_retweet`, `twitter_unretweet`, `twitter_quote` | Twitter-specific |
| Integration setup | N | N | `twitter_request_integration` | |

### 1.3 Usage Tracking Infrastructure

| Component | Status | Location | Notes |
|---|---|---|---|
| Entitlement schema | Shipped (M1) | `packages/admin-api/src/services/entitlements.ts` | Free/Pro/Enterprise tiers with limits |
| Runtime enforcement | Shipped (M1) | `packages/handlers/src/services/entitlement-enforcement.ts` | Atomic DynamoDB counters, energy fallback |
| Daily usage counters | Shipped (M1) | STATE_TABLE: `pk=USAGE#{avatarId}`, `sk={TYPE}#{date}` | Messages, media, voice, video |
| Energy system | Shipped (M1) | `packages/core/src/services/usage.ts` | Credit-based with timed recharge |
| Usage query API | Partial | `entitlements.ts:getUsage()` | Server-side only, not exposed in admin chat |
| Admin UI usage display | Not started | -- | No tool or API to surface usage in chat |
| Stripe integration | Not started | -- | Zero code; design in BILLING-STRATEGY.md |

### 1.4 SQS Queue Architecture

| Queue | Type | Visibility Timeout | DLQ | Alarms |
|---|---|---|---|---|
| messageQueue | FIFO | 60s | Y (maxReceiveCount: 3) | Depth > 10, DLQ > 0 |
| responseQueue | FIFO | 60s | Shared DLQ | Depth > 10 |
| mediaQueue | FIFO | 5 min | Shared DLQ | Depth > 5 |
| DLQ | FIFO | 14-day retention | -- | Messages > 0 (300s period) |

**Payload offload:** No S3 offload pattern exists. All payloads are serialized directly into SQS message bodies. SQS FIFO messages have a 256 KB limit. Large media metadata (base64 images, long context windows) could exceed this.

---

## 2. Gap Analysis

### 2.1 Discord Gaps (to reach Telegram parity)

| Gap | Severity | Effort | Description |
|---|---|---|---|
| Voice message send | High | M | `executeAction('send_voice')` falls back to text+URL instead of uploading audio file via Discord attachment API |
| Sticker send | Medium | S | No `sendSticker` implementation; Discord supports sticker references in message payloads |
| Voice message ingest | Medium | M | Incoming voice messages not parsed from Discord message attachments |
| Sticker ingest | Low | S | Sticker references in Discord messages not extracted into envelope |
| Forward metadata | Low | S | Discord referenced messages could populate `forwardMetadata` in envelope |
| Bot profile tools | Medium | M | No MCP tools for changing bot username, avatar, about text via Discord API |
| Home channel equivalent | Medium | M | No concept of a "primary channel" per guild for admin announcements |
| DM allowlisting | Low | S | No mechanism to restrict which users can DM the bot |
| Admin commands | Medium | M | No `/activate` or setup commands via Discord slash commands |
| Typing indicator tool | Low | S | Adapter supports typing but no MCP tool exposes it |
| User profile tools | Low | S | No tool to fetch Discord user info or avatar |
| Multi-tenant webhook | Low | L | Discord webhook is per-avatar; shared handler would reduce Lambda cold starts |
| Image file upload | Low | S | Media sends use embed URLs; direct file upload would improve reliability |

### 2.2 Twitter Gaps (to reach Telegram parity)

| Gap | Severity | Effort | Description |
|---|---|---|---|
| DM support | High | L | Twitter DM API v2 not integrated; no ingest or send for direct messages |
| Real-time ingestion | High | L | Polling-based (mention poller on schedule); no streaming/webhook equivalent |
| Media ingest from tweets | Medium | M | Incoming tweet media URLs not downloaded/processed into envelope media attachments |
| Bot profile tools | Medium | M | No MCP tools for updating Twitter profile name, bio, avatar |
| Edit/delete support | Low | M | Cannot edit or delete posted tweets |
| Thread continuation | Medium | M | Reply chains work but long thread composition (auto-splitting 280 chars) not automated |
| Typing indicator | N/A | -- | Not applicable for Twitter |
| Sticker/voice | N/A | -- | Not applicable for Twitter |

### 2.3 Tool Registry Gaps

| Gap | Description |
|---|---|
| Platform handler bridge incomplete | `platform-mcp-adapter.ts` wires Twitter services (postTweet, reply, like, etc.) but does NOT wire Discord services (send, list guilds, react, etc.) or Telegram services (send_to_chat, set_bot_name, etc.) to the MCP registry at runtime |
| Duplicate tool definitions | `packages/core/src/tools/index.ts` defines `publicTools` statically while `packages/mcp-server/src/registry.ts` defines the same tools dynamically; these can drift |
| Admin API migration incomplete | `packages/admin-api/src/tools/index.ts` is marked deprecated but still exports `MANUAL_TOOL_NAMES` and `UPLOAD_TOOL_NAMES` used at runtime |
| No cross-platform tool abstraction | Platform tools are registered per-platform (e.g., `discord_send` vs `telegram_send_to_chat`); no unified `send_to_platform` that dispatches based on context |
| Tool entitlement enforcement | Tool calls are counted but individual tools are not gated by tier (e.g., Pro-only tools not enforced at registry level) |

### 2.4 Usage Metering Gaps

| Gap | Description |
|---|---|
| No admin chat tool | No `get_usage_summary` or `check_usage` MCP tool for operators to query usage in the chat UI |
| No usage history API | `getUsage()` returns a single day; no aggregation endpoint for weekly/monthly trends |
| No usage alerts | No proactive notification when an avatar approaches or exceeds daily limits |
| No per-platform breakdown | Usage counters are avatar-wide; no breakdown by platform (Telegram vs Discord vs Twitter) |
| No cost attribution | Media and voice usage not translated to dollar cost for billing display |

### 2.5 SQS Payload Offload Gaps

| Gap | Description |
|---|---|
| No S3 offload for large envelopes | If an envelope with embedded media (base64), long conversation context, or multiple attachments exceeds 256 KB, the SQS send will fail |
| No DLQ inspection tools | No admin tool to list, inspect, or replay messages from the dead-letter queue |
| No DLQ alarm routing | CloudWatch alarms fire to SNS but no admin chat notification or dashboard integration |
| Media queue backpressure | No mechanism to slow media generation requests when the media queue depth alarm fires |

### 2.6 Memory Relevance Gaps

> **Status update (2026-02-21):** Semantic retrieval is now wired into the primary path. `searchMemories()` in `memory.ts` generates a query embedding and re-ranks results by cosine similarity using the hybrid scoring formula (55% semantic, 25% recency, 15% strength, 5% about-match). `createMemory()` generates embeddings on write. A `backfill_embeddings` MCP tool and `memory-migration.ts` service exist for backfilling older records. See [SEMANTIC-MEMORY-DESIGN.md](SEMANTIC-MEMORY-DESIGN.md) for the full design.

| Gap | Description |
|---|---|
| Embedding coverage not tracked in production | No visibility into what percentage of memories per avatar have embeddings; no alert when coverage drops below a threshold |
| No benchmark harness | No repeatable before/after benchmark to compare relevance and latency when changing retrieval logic or tuning hybrid weights |
| No retrieval regression suite | Unit tests cover basic semantic re-ranking (`memory.test.ts`), but no dedicated regression tests assert latency budgets, ranking stability across weight changes, or fallback correctness under partial embedding coverage |
| Backfill not automated | `backfill_embeddings` requires manual invocation per avatar; no scheduled job ensures new avatars or migrated records have full coverage |

---

## 3. Unified Tool Registry -- Proposed Architecture

### 3.1 Current Architecture

```
Admin API Chat                    Platform Handlers
     |                                  |
     v                                  v
@swarm/mcp-server                platform-mcp-adapter.ts
  ToolRegistry                     (partial bridge)
  - registerAllTools()                  |
  - AllServices interface               v
  - Platform filtering           @swarm/mcp-server
  - Category grouping              ToolRegistry (same)
```

**Problem:** The `AllServices` interface in the MCP server expects service implementations, but `platform-mcp-adapter.ts` only wires a subset (Twitter services, media, wallet). Discord and Telegram runtime services are not bridged. Admin API creates its own service implementations independently.

### 3.2 Proposed Architecture

```
                    @swarm/mcp-server
                     ToolRegistry
                    (single source)
                          |
               ┌----------+----------┐
               |                     |
         Admin API Chat         Platform Handlers
               |                     |
               v                     v
        AdminServiceFactory    PlatformServiceFactory
         (implements               (implements
          AllServices)              AllServices)
               |                     |
          Admin-scoped          Runtime-scoped
          DynamoDB access       SQS/S3/Secrets
          Secret write-only     Entitlement checks
          Audit logging         Platform adapters
```

### 3.3 Key Changes

1. **Complete `AllServices` bridge in `platform-mcp-adapter.ts`:**
   - Add `discordServices` property wiring `DiscordAdapter` methods (send, list guilds/channels, react, set status).
   - Add `telegramServices` property wiring `TelegramAdapter` methods (send_to_chat, set_bot_name, get_user_profile_photos).
   - Ensure the bridge passes the active avatar's adapter instance.

2. **Eliminate static tool lists in core:**
   - Remove `publicTools` and `defaultAvatarTools` from `packages/core/src/tools/index.ts`.
   - Replace with a `getDefaultTools(platform: Platform): string[]` function that queries the registry.

3. **Complete admin API migration:**
   - Move `MANUAL_TOOL_NAMES` and `UPLOAD_TOOL_NAMES` into tool metadata (tags or `interactivity` field) in the MCP registry.
   - Delete the deprecated `packages/admin-api/src/tools/index.ts` barrel.

4. **Add tier-gated tool metadata:**
   - Add `requiredTier?: 'free' | 'pro' | 'enterprise'` to `ToolDefinition`.
   - Registry `getForPlatform()` filters by avatar's current tier from `RuntimeContract`.

5. **Add unified `send_to_platform` abstraction (optional):**
   - A meta-tool that accepts `platform` + `channelId` + `content` and dispatches to the correct platform adapter.
   - Useful for cross-posting workflows but not strictly required for parity.

---

## 4. Usage Metering -- What to Track and How to Surface It

### 4.1 Metrics to Track

| Metric | Granularity | Storage | Current Status |
|---|---|---|---|
| Messages processed | Daily per avatar | STATE_TABLE `USAGE#{avatarId}` / `MSG#{date}` | Shipped |
| Media credits used | Daily per avatar | STATE_TABLE `USAGE#{avatarId}` / `MEDIA#{date}` | Shipped |
| Voice minutes used | Daily per avatar | STATE_TABLE `USAGE#{avatarId}` / `VOICE#{date}` | Shipped |
| Video credits used | Daily per avatar | STATE_TABLE `USAGE#{avatarId}` / `VIDEO#{date}` | Shipped |
| Tool calls made | Daily per avatar | STATE_TABLE `USAGE#{avatarId}` / `TOOLS#{date}` | Shipped |
| Energy consumed | Per operation | Separate energy ledger | Shipped |
| Per-platform breakdown | Daily per avatar per platform | **New** -- add platform dimension to usage keys | Not started |
| Cost attribution (USD) | Daily per avatar | **New** -- computed from usage x unit cost | Not started |
| Usage alerts (80%/100%) | Real-time check | **New** -- evaluated on each metered operation | Not started |

### 4.2 Admin Chat Tools (New)

**`check_usage` tool:**
- Input: optional `avatarId`, optional `dateRange` (today/week/month)
- Output: formatted usage summary with limits, remaining, percentage used
- Category: `observability`
- Platforms: all (admin context)

**`usage_alerts` tool:**
- Input: `avatarId`, `threshold` (percentage, default 80)
- Output: configure proactive alerts when usage crosses threshold
- Implementation: store alert config in STATE_TABLE, check during `checkAndIncrementMessageUsage()`

**`usage_report` tool:**
- Input: `avatarId`, `period` (week/month)
- Output: aggregated usage across days with trend indicators
- Implementation: scan USAGE# records for date range, compute totals and deltas

### 4.3 API Endpoints (for future dashboard)

While the admin UI is chat-first, prepare backend endpoints for potential dashboard widgets:

- `GET /api/avatars/{id}/usage?period=7d` -- aggregated usage
- `GET /api/avatars/{id}/usage/breakdown?period=7d` -- per-platform breakdown
- `GET /api/avatars/{id}/billing/current` -- current billing period summary

These are lower priority than the chat tools but share the same data layer.

---

## 5. Stripe Integration -- Sequence of Implementation

### 5.1 Prerequisites

- Stripe account with Products and Prices configured for Free/Pro/Enterprise
- Stripe webhook endpoint accessible (API Gateway route)
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Secrets Manager

### 5.2 Implementation Sequence

#### Phase 1: Checkout Flow (L -- 1-2 weeks)

1. **Create Stripe products and prices:**
   - Free: $0/mo (used for tracking, not charged)
   - Pro: $9/mo (or configured price)
   - Enterprise: $29/mo (or configured price)

2. **Add `subscribe` admin chat tool:**
   - Generates a Stripe Checkout Session URL for the selected plan.
   - Returns a clickable link or inline button in the chat.
   - Associates `avatarId` and `ownerId` in Checkout metadata.

3. **Add Stripe Checkout success handler:**
   - Lambda behind API Gateway route `/api/stripe/checkout-success`.
   - On success, auto-provisions entitlement in DynamoDB.
   - Sends confirmation message to admin chat via WebSocket or next chat response.

4. **CDK changes:**
   - Add Stripe webhook Lambda (`stripe-webhook.ts`).
   - Add API Gateway route for Stripe webhooks.
   - Add Secrets Manager entries for Stripe keys.

#### Phase 2: Webhook Handling (M -- 1 week)

5. **Implement Stripe webhook handler:**
   - Verify Stripe signature using `stripe.webhooks.constructEvent()`.
   - Handle events:
     - `checkout.session.completed` -- provision entitlement
     - `customer.subscription.updated` -- update tier
     - `customer.subscription.deleted` -- downgrade to free
     - `invoice.payment_failed` -- flag entitlement, notify admin
     - `invoice.paid` -- clear payment failure flags

6. **Entitlement sync logic:**
   - Map Stripe subscription status to entitlement status (active/suspended/cancelled).
   - Store `stripeCustomerId` and `stripeSubscriptionId` on the entitlement record.
   - Idempotent upsert to handle webhook retries.

#### Phase 3: Customer Portal (S -- 3-5 days)

7. **Add `manage_billing` admin chat tool:**
   - Creates a Stripe Billing Portal session.
   - Returns URL for the operator to update payment method, cancel, or change plan.

8. **Add `billing_status` admin chat tool:**
   - Fetches current subscription status from Stripe API.
   - Shows plan, next billing date, payment method status, and any issues.

#### Phase 4: Usage-Based Overages (M -- 1-2 weeks)

9. **Stripe metered billing setup:**
   - Create metered price items for media, voice, video overages.
   - Report usage to Stripe via `stripe.subscriptionItems.createUsageRecord()`.

10. **Usage reporter Lambda:**
    - Scheduled daily via EventBridge.
    - Reads DynamoDB usage counters for each avatar.
    - Computes overages (usage - plan_limit) for each metered dimension.
    - Reports to Stripe for inclusion in the next invoice.

11. **Add overage visibility in admin chat:**
    - The `check_usage` tool shows overage amounts and estimated cost.
    - The `billing_status` tool shows pending overage charges.

### 5.3 Stripe Data Model

```
EntitlementRecord (DynamoDB)
  + stripeCustomerId: string
  + stripeSubscriptionId: string
  + stripeStatus: 'active' | 'past_due' | 'canceled' | 'unpaid'
  + currentPeriodEnd: ISO8601 string
  + paymentFailedAt?: ISO8601 string
```

---

## 6. SQS Payload Offload -- When and How

### 6.1 When Offload is Needed

SQS FIFO messages have a hard 256 KB size limit. Payloads that can exceed this:

| Scenario | Typical Size | Risk |
|---|---|---|
| Envelope with long conversation context (20+ messages) | 50-150 KB | Medium |
| Envelope with base64-encoded media | 500 KB - 10 MB | High |
| Envelope with multiple media attachments (URLs + metadata) | 10-50 KB | Low |
| Response action with generated image (base64) | 1-5 MB | High |
| Response action with voice audio (base64) | 500 KB - 2 MB | High |

### 6.2 Offload Pattern: S3 Claim-Check

```
Producer                          SQS                      Consumer
   |                               |                          |
   | payload > THRESHOLD?          |                          |
   |   YES: upload to S3           |                          |
   |   put S3 key in envelope      |                          |
   |   ────────────────────────>   |                          |
   |   {_s3PayloadKey: "..."}      |  ─────────────────────>  |
   |                               |                          |
   |                               |    download from S3      |
   |                               |    reconstruct envelope  |
   |                               |    delete S3 object      |
   |                               |    process normally      |
```

### 6.3 Implementation

1. **Add `SQSPayloadOffloader` utility class in `@swarm/core`:**
   - `send(queueUrl, body, attributes, options)` -- checks size, offloads if needed.
   - `receive(sqsMessage)` -- detects claim-check, downloads, reconstructs.
   - Threshold: 200 KB (conservative; leaves room for SQS metadata overhead).
   - S3 path: `s3://{mediaBucket}/sqs-offload/{queueName}/{messageId}.json`
   - TTL: S3 lifecycle rule deletes objects after 24 hours (messages should be processed long before).

2. **Integrate into all SQS producers:**
   - `telegram-webhook-shared.ts` (envelope to messageQueue)
   - `discord-webhook.ts` (envelope to messageQueue)
   - `discord-gateway.ts` (envelope to messageQueue)
   - `message-processor.ts` (response to responseQueue, media to mediaQueue)
   - `platform-mcp-adapter.ts` (decoupled post to postQueue, media to mediaQueue)

3. **Integrate into all SQS consumers:**
   - `message-processor.ts` (reads from messageQueue)
   - `response-sender.ts` (reads from responseQueue)
   - `media-processor.ts` (reads from mediaQueue)

4. **CDK changes:**
   - Grant `s3:PutObject` on offload prefix to producer Lambdas.
   - Grant `s3:GetObject` and `s3:DeleteObject` on offload prefix to consumer Lambdas.
   - Add S3 lifecycle rule for `sqs-offload/` prefix with 1-day expiration.

### 6.4 DLQ Management

1. **Add `inspect_dlq` admin chat tool:**
   - Lists messages in the DLQ (up to 10) with timestamp, source queue, and error summary.
   - Uses SQS `ReceiveMessage` with `VisibilityTimeout: 0` (peek without consuming).

2. **Add `replay_dlq` admin chat tool:**
   - Takes a DLQ message ID, moves it back to the source queue.
   - Resets the attempt counter.
   - Logs the replay action in the audit trail.

3. **Add `purge_dlq` admin chat tool:**
   - Purges all messages from the DLQ after confirmation.
   - Requires admin-level access.

4. **DLQ alarm routing to admin chat:**
   - SNS topic subscription triggers a Lambda that posts a notification to the admin chat WebSocket.
   - "Your avatar {name} has {count} failed messages in the dead-letter queue. Use `inspect_dlq` to investigate."

---

## 7. Prioritized Task List

### P0: Critical for platform parity (Weeks 1-4)

| ID | Task | Package | Effort | Dependencies | Description |
|---|---|---|---|---|---|
| M2-001 | Discord voice message send | core | M | -- | Implement file upload for `executeAction('send_voice')` using Discord attachment API instead of embed URL fallback |
| M2-002 | Discord voice message ingest | core | M | -- | Parse voice/audio attachments from Discord messages into envelope `MediaAttachment` |
| M2-003 | Complete platform-MCP bridge for Discord | handlers | M | -- | Wire `DiscordAdapter` methods into `AllServices.discordServices` in `platform-mcp-adapter.ts` |
| M2-004 | Complete platform-MCP bridge for Telegram | handlers | M | -- | Wire `TelegramAdapter` methods into `AllServices.telegramServices` in `platform-mcp-adapter.ts` |
| M2-005 | SQS S3 payload offload utility | core | M | -- | Implement `SQSPayloadOffloader` with claim-check pattern for payloads > 200 KB |
| M2-006 | Integrate SQS offload in producers | handlers | S | M2-005 | Update all SQS `SendMessageCommand` calls to use the offloader |
| M2-007 | Integrate SQS offload in consumers | handlers | S | M2-005 | Update all SQS event handlers to detect and download offloaded payloads |
| M2-008 | CDK grants for SQS offload | infra | S | M2-005 | Add S3 permissions and lifecycle rules for `sqs-offload/` prefix |

### P1: Core billing and metering (Weeks 3-8)

| ID | Task | Package | Effort | Dependencies | Description |
|---|---|---|---|---|---|
| M2-010 | Stripe product/price setup | infra, docs | S | -- | Document and script Stripe product creation (Free/Pro/Enterprise) |
| M2-011 | Stripe webhook Lambda | handlers | M | M2-010 | Implement `stripe-webhook.ts` with signature verification and event handling |
| M2-012 | CDK for Stripe webhook | infra | S | M2-011 | API Gateway route, Lambda, Secrets Manager entries for Stripe keys |
| M2-013 | `subscribe` admin chat tool | mcp-server | M | M2-010 | Create Checkout Session, return URL in chat; provision entitlement on success |
| M2-014 | `manage_billing` admin chat tool | mcp-server | S | M2-010 | Create Billing Portal session, return URL |
| M2-015 | `billing_status` admin chat tool | mcp-server | S | M2-010 | Fetch and display current subscription status |
| M2-016 | Entitlement-Stripe sync | admin-api | M | M2-011 | Idempotent upsert of entitlement records from Stripe webhook events |
| M2-017 | `check_usage` admin chat tool | mcp-server | M | -- | Query and format daily/weekly usage summary with limits and remaining |
| M2-018 | Usage aggregation service | admin-api | M | -- | Scan DynamoDB usage records for date ranges, compute totals and trends |
| M2-019 | Per-platform usage breakdown | handlers | M | -- | Add platform dimension to usage counter keys in `entitlement-enforcement.ts` |
| M2-054 | Semantic retrieval hardening | admin-api, infra | M | -- | Add embedding coverage dashboard metric per avatar, automate backfill via scheduled EventBridge job, and add coverage-drop alerting |
| M2-055 | Retrieval benchmark harness | admin-api, docs | S | -- | Add repeatable benchmark fixture set and reporting script for relevance (MRR/nDCG) and p95 latency before/after weight or model changes |
| M2-056 | Semantic retrieval regression coverage | admin-api | M | -- | Add dedicated regression tests for ranking stability, fallback correctness under partial coverage, and latency budget assertions (p95 < agreed threshold) |

### P2: Enhanced platform features (Weeks 5-10)

| ID | Task | Package | Effort | Dependencies | Description |
|---|---|---|---|---|---|
| M2-020 | Discord sticker send | core | S | -- | Implement `sendSticker` using Discord sticker reference in message payload |
| M2-021 | Discord sticker ingest | core | S | -- | Extract sticker references from Discord messages into envelope |
| M2-022 | Discord bot profile tools | mcp-server | M | M2-003 | MCP tools: `discord_set_nickname`, `discord_set_avatar`, `discord_set_about` |
| M2-023 | Discord admin slash commands | core, handlers | M | -- | Register and handle `/activate`, `/status` slash commands for Discord bots |
| M2-024 | Discord home channel concept | handlers | M | -- | Designate a primary channel per guild for announcements and admin notifications |
| M2-025 | Discord DM allowlisting | handlers | S | -- | Configuration to restrict which users can initiate DMs with the bot |
| M2-026 | Twitter DM ingestion | core | L | -- | Integrate Twitter DM API v2 for receiving direct messages |
| M2-027 | Twitter DM sending | core | L | M2-026 | Send DMs via Twitter API v2 |
| M2-028 | Twitter bot profile tools | mcp-server | M | -- | MCP tools: `twitter_set_name`, `twitter_set_bio`, `twitter_set_avatar` |
| M2-029 | Twitter media ingest | core | M | -- | Download and process media from incoming tweet URLs into envelope attachments |
| M2-030 | Stripe usage-based overages | handlers | M | M2-011, M2-018 | Daily Lambda reports overage usage to Stripe metered billing |
| M2-031 | Overage visibility in chat | mcp-server | S | M2-030, M2-017 | Show overage amounts and estimated cost in `check_usage` tool |

### P3: Polish and operational (Weeks 8-12)

| ID | Task | Package | Effort | Dependencies | Description |
|---|---|---|---|---|---|
| M2-040 | DLQ inspection tool | mcp-server | M | -- | `inspect_dlq` admin chat tool to list and peek at failed messages |
| M2-041 | DLQ replay tool | mcp-server | M | M2-040 | `replay_dlq` admin chat tool to move messages back to source queue |
| M2-042 | DLQ purge tool | mcp-server | S | M2-040 | `purge_dlq` admin chat tool with confirmation |
| M2-043 | DLQ alarm to admin chat | infra, handlers | M | -- | SNS subscription triggers notification in admin chat WebSocket |
| M2-044 | Usage alerts (proactive) | handlers | M | M2-017 | Check usage thresholds during metered operations; send alert at 80%/100% |
| M2-045 | Eliminate static tool lists in core | core | S | M2-003, M2-004 | Remove `publicTools`/`defaultAvatarTools` arrays; derive from registry |
| M2-046 | Complete admin-api tool migration | admin-api | S | M2-045 | Remove deprecated `tools/index.ts`; move `MANUAL_TOOL_NAMES` to tool metadata |
| M2-047 | Tier-gated tool metadata | mcp-server | S | M2-013 | Add `requiredTier` field to `ToolDefinition`; filter in `getForPlatform()` |
| M2-048 | Twitter thread auto-splitting | core | M | -- | Auto-split messages > 280 chars into threaded replies |
| M2-049 | Twitter edit/delete support | core, mcp-server | M | -- | MCP tools for editing and deleting posted tweets |
| M2-050 | Discord forward metadata | core | S | -- | Populate `forwardMetadata` from Discord referenced/replied messages |
| M2-051 | Cross-platform send meta-tool | mcp-server | M | M2-003, M2-004 | Unified `send_to_platform` tool that dispatches to correct adapter |
| M2-052 | Usage dashboard API endpoints | admin-api | M | M2-018 | REST endpoints for potential future dashboard widgets |
| M2-053 | Discord multi-tenant webhook | handlers, infra | L | -- | Shared webhook handler for multiple Discord avatars (reduces cold starts) |

---

## Dependency Graph (Critical Path)

```
M2-005 (SQS offload utility)
  ├── M2-006 (producers)
  ├── M2-007 (consumers)
  └── M2-008 (CDK grants)

M2-010 (Stripe setup)
  ├── M2-011 (webhook handler)
  │     ├── M2-012 (CDK)
  │     ├── M2-016 (entitlement sync)
  │     └── M2-030 (overage reporting)
  │           └── M2-031 (overage visibility)
  ├── M2-013 (subscribe tool)
  ├── M2-014 (manage billing tool)
  └── M2-015 (billing status tool)

M2-003 (Discord MCP bridge)
  ├── M2-022 (Discord profile tools)
  ├── M2-045 (eliminate static lists)
  │     └── M2-046 (admin-api migration)
  │           └── M2-047 (tier-gated tools)
  └── M2-051 (cross-platform tool)

M2-004 (Telegram MCP bridge)
  ├── M2-045 (eliminate static lists)
  └── M2-051 (cross-platform tool)

M2-017 (check_usage tool)
  ├── M2-031 (overage visibility)
  └── M2-044 (usage alerts)

M2-018 (usage aggregation)
  ├── M2-030 (overage reporting)
  └── M2-052 (dashboard API)

M2-054 (semantic retrieval hardening)
  (independent -- wiring shipped; M2-055 and M2-056 can start in parallel)

M2-055 (benchmark harness)

M2-056 (regression coverage)

M2-040 (DLQ inspect)
  ├── M2-041 (DLQ replay)
  └── M2-042 (DLQ purge)
```

---

## Effort Estimates

| Size | Definition | Approximate Duration |
|---|---|---|
| S | Small -- isolated change, < 200 LOC, no new services | 1-2 days |
| M | Medium -- new service or integration, 200-800 LOC, tests required | 3-5 days |
| L | Large -- new subsystem, external API integration, > 800 LOC | 1-2 weeks |

**Total estimated effort:**
- P0 (8 tasks): ~4-5 weeks of work (parallelizable to 2-3 calendar weeks)
- P1 (13 tasks): ~8-10 weeks of work (parallelizable to 5-6 calendar weeks)
- P2 (12 tasks): ~8-10 weeks of work (parallelizable to 5-6 calendar weeks)
- P3 (14 tasks): ~6-8 weeks of work (parallelizable to 4-5 calendar weeks)

**Recommended team allocation:**
- 1 engineer on platform adapters (Discord/Twitter parity -- M2-001/002/020-029)
- 1 engineer on billing infrastructure (Stripe + metering -- M2-010-019/030-031)
- 1 engineer on plumbing (SQS offload + tool registry unification + DLQ -- M2-003-008/040-047)
- 1 engineer on memory relevance (operational hardening + benchmark + regression -- M2-054-056; all three are now parallelizable since wiring is shipped)

---

## Open Questions

1. **Twitter DM priority:** Twitter DM API v2 has restrictive rate limits and requires elevated access. Should we defer DMs to M3 or pursue it in M2?

2. **Discord multi-tenant webhook:** The per-avatar Discord webhook model works but increases cold start costs. Is the operational benefit of a shared handler worth the M2 investment?

3. **Stripe pricing model:** The $0/$9/$29 pricing in BILLING-STRATEGY.md is tentative. Should we validate with users before building checkout flows?

4. **SQS offload threshold:** 200 KB is conservative. Should we profile actual payload sizes to set an optimal threshold? Could we avoid offload entirely by stripping base64 media earlier in the pipeline?

5. **Cross-platform tool:** Is a unified `send_to_platform` meta-tool valuable, or do operators prefer platform-specific tools for clarity?

6. **Semantic retrieval quality bar:** Semantic retrieval is live in the primary path. What minimum embedding coverage percentage per avatar is required before declaring M2-054 complete? What p95 latency budget should the benchmark harness (M2-055) enforce?
