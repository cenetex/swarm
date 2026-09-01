# Cloudflare-Native Hosted Swarm

This is the target architecture for the paid hosted tier. Users choose **Local** or **Hosted 24/7**; infrastructure providers remain an internal implementation detail.

The hosted product is a hybrid dApp. Solana provides user identity and may provide entitlement or payment proofs. Secrets, messages, model calls, and always-on execution remain in a shared off-chain runtime. A browser-only or fully on-chain runtime cannot safely retain credentials or keep Telegram and Discord agents alive after the browser closes.

An avatar is not a private runtime record. It is a public, portable project by default. Its content-addressed `swarm.avatar/v1` artifact can move between hosts, while the hosted runtime provides discovery, indexing, credentials, channels, and execution. See [Portable Public Avatars](./PORTABLE-PUBLIC-AVATARS.md).

## Product Model

### Local

- Runs while the native app is open.
- Uses local SQLite, local encrypted secrets, and local filesystem blobs.
- Good for free use, privacy-first workflows, development, and self-hosting.

### Hosted

- Runs 24/7 for a paid subscription.
- Uses bring-your-own AI credentials by default, so model cost is paid directly by the user.
- Does not expose runtime endpoints, infrastructure choices, or raw stored credentials.
- Uses shared Cloudflare services for the core runtime and specialized compute only where required.

## Cloudflare Service Map

| Swarm Need                 | Service                   | Notes                                                                                  |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Admin UI                   | Cloudflare Pages          | Static app and public landing/chat pages.                                              |
| API and webhooks           | Workers                   | SIWS, OAuth callbacks, billing, Telegram webhooks, and chat routes.                    |
| App state and catalog      | D1                        | Public discovery index plus tenant-keyed runtime state.                                 |
| Media/blobs                | R2                        | Hosted mirror for portable revisions, generated media, exports, and attachments.        |
| Background work            | Queues                    | Message processing, integration retries, and media jobs.                               |
| Multi-step jobs            | Workflows                 | Onboarding, long retry ladders, and approval/post pipelines.                           |
| Periodic work              | Cron Triggers             | Claim due jobs and enqueue work instead of performing entire jobs in cron.             |
| Per-avatar serialization   | Durable Objects           | Locks, realtime status, ordering, and duplicate-loop prevention.                       |
| Platform secrets           | Cloudflare secrets        | Global service configuration only.                                                     |
| User secrets               | Encrypted D1 rows         | Envelope-encrypt before storage; never create one platform secret per user.            |
| Discord gateway            | Shared persistent process | One multi-tenant Fly machine or equivalent; never one machine per avatar.              |
| Linux/browser/code sandbox | Ascii Box                 | Internal provider only and quota-gated.                                                |

## Request Topology

```text
Wallet / hosted PWA
  |-- SIWS challenge + HttpOnly session
  |-- OpenRouter OAuth PKCE
  v
Cloudflare Worker
  |-- D1: accounts, identities, sessions, avatar state, jobs, usage
  |-- encrypted D1 rows: AI and integration credentials
  |-- R2: media and exports
  |-- Queue -> per-avatar Durable Object -> model/integration calls
  `-- shared Discord gateway relay -> Queue
```

Telegram and browser chat enter through HTTP. Discord's outbound Gateway WebSocket stays in one shared persistent relay until a Cloudflare-native implementation proves both reliable and cheaper.

## Authentication and BYOK

The hosted Worker implements the first secure vertical slice:

1. `POST /api/auth/challenge` creates a ten-minute, domain-bound Sign In With Solana challenge. Challenge creation is rate-limited by source and wallet.
2. `POST /api/auth/verify` atomically consumes the challenge, verifies the Ed25519 signature, and issues a seven-day `HttpOnly; Secure; SameSite=Lax` session cookie.
3. A wallet-authenticated owner can enroll a discoverable passkey through `/api/auth/passkey/register/*`. Registration requires user verification and is bound to the configured WebAuthn RP ID and exact hosted origin.
4. A returning owner can sign in through `/api/auth/passkey/authenticate/*` without entering an account name. The Worker consumes the one-use challenge, finds the credential by its opaque ID, verifies the signature and user-presence flags, updates the counter, and issues the same protected session cookie for the existing wallet-backed account.
5. A passkey-authenticated owner can link another Solana wallet through `/api/auth/wallet/link/*`. The Worker requires the protected passkey session plus a fresh, one-use, domain-bound signature from the wallet being linked. An unused wallet joins the current account, an existing same-account link is idempotent, and a wallet owned by another account is rejected instead of merging account data.
6. `GET /api/auth/openrouter` creates a one-use PKCE S256 transaction bound to the account and current session. Only a hash of OAuth state is stored.
7. The PKCE verifier is envelope-encrypted while pending. The callback consumes it once before exchanging the authorization code.
8. The returned user-owned OpenRouter key is envelope-encrypted immediately. API responses expose connection status, never credential values.
9. `DELETE /api/auth/openrouter` removes the encrypted AI credential and provider selection.

Passkey rows contain only credential public keys, opaque credential/user IDs, device metadata, transports, and signature counters. Biometric data stays on the authenticator. Challenge handles are random and stored only as hashes; challenges expire after ten minutes and are consumed on the first verification attempt. Wallet sign-in remains the recovery path.

Migration `0009_passkeys.sql` adds passkey credentials, one-use challenges, and session-provider metadata. The production RP ID is the stable zone (`rati.chat`), while verification still requires the exact active origin. This lets passkeys survive the planned move from `next.swarm.rati.chat` to `swarm.rati.chat` without allowing an unrelated origin.

The dedicated hosted UI is served from the same Worker origin. Passkey sign-in is the primary signed-out action. Wallet recovery opens a responsive Phantom or Solflare QR on phones and desktops; the browser-wallet fallback is desktop-only. It starts OAuth through the authenticated route, reads only connection status, and never renders or accepts the exchanged credential. The write-only manual-key route remains a compatibility surface for trusted non-hosted clients; it is not part of normal hosted onboarding.

### Public registry and owner Studio

The hosted root is an anonymous public registry. Each public avatar has a shareable project page showing its public prompt, shared memory summary, capabilities, controller, revision, portable download, and NFT-ready metadata. Search engines receive a dynamic sitemap of listed avatars.

The owner surface lives at `/studio`. On desktop, a narrow management rail holds account, runtime, provider, portability, and avatar controls beside one continuous conversation surface. On smaller screens, chat remains visible first and the same controls move behind one **Manage** action. Creation and restore do not require an AI provider connection; model-backed chat does.

## Hosted Telegram

Telegram is the second hosted connector after OpenRouter. It uses the same account, encrypted-secret,
Queue, and Durable Object boundaries as hosted browser chat:

1. An authenticated avatar owner pastes a BotFather token once. The Worker calls `getMe`, claims the
   Telegram bot id so it cannot be shared between tenants, and registers an opaque HTTPS webhook.
2. The token and Telegram webhook secret are encrypted with account-and-avatar context. API responses,
   browser storage, and logs never receive the token again.
3. The owner opens a one-use Telegram deep link and sends `/start` in a private chat. That Telegram user
   becomes the connector owner. A separate, expiring `startgroup` link enables groups only when used by
   that owner.
4. Private messages are accepted only from the bound owner. Groups are quiet by default and respond only
   to mentions, bot-addressed commands, or replies to the bot.
5. The public webhook validates Telegram's secret header, reserves `update_id` in D1, and enqueues accepted
   work. It does not call the model before returning.
6. Every Telegram chat maps to a separate hosted thread. The Queue consumer takes the avatar lease, loads
   only that thread's history, decrypts the user's OpenRouter key for the model call, and sends the result
   through Telegram.
7. Delivery is marked `sending` before the outbound request. A request with an unknown network outcome is
   recorded as `unknown` and is not retried, preventing accidental duplicate replies. Definite rate limits
   and pre-delivery failures use bounded retries.
8. Disconnect first invalidates the Telegram webhook, then removes every avatar-scoped Telegram secret and
   all connector metadata. If Telegram is unavailable, removing the local webhook secret still makes later
   calls to the old endpoint fail closed.
9. Accepted messages retain the Telegram message id and forum topic id. The Queue consumer sends a typing
   action, adds best-effort acknowledgement and completion reactions, and replies directly to the source
   message inside the same topic. Reaction failures never block the text response.
10. Text captions follow the same mention and reply rules as text messages. Binary photo, file, voice, and
    video content is not downloaded or sent to the model.
11. Telegram membership updates mark groups unavailable after the bot leaves or is removed. The hosted owner
    can list, pause, enable, or forget group bindings. An owner-only bind command supports groups where the bot
    is already present and the `startgroup` picker cannot add it again.
12. `/ask`, `/help`, and `/status` are registered with Telegram. Every forum topic maps to a separate hosted
    thread, while ordinary unaddressed group messages remain ignored for privacy.

Migration `0005_hosted_telegram.sql` adds bot ownership, enabled-chat mappings, deduplication, jobs, and
delivery state. Bot tokens and binding codes remain in the existing encrypted secret table, not these
metadata tables. Migration `0007_hosted_telegram_v2.sql` adds membership/activity state, reply and topic
delivery metadata, and per-topic hosted thread mappings.

## Hosted Web Chat

The first hosted message path is now implemented for browser chat:

1. The signed-in user creates or selects an avatar through `/api/avatars`.
2. `POST /api/chat` checks the feature flag, session, avatar owner, message limit, Queue and Durable Object bindings, and the user's OpenRouter key.
3. D1 stores one user message and one job for the client request id. A replay returns the existing job instead of calling the model again.
4. The Queue consumer asks the avatar's Durable Object for a short lease. Only one job for that account and avatar can hold the lease.
5. The consumer decrypts the account's OpenRouter key only for the provider call. It loads recent D1 history, calls the configured model, and stores one assistant message.
6. The admin UI polls `/api/jobs/{jobId}`. Completed jobs return the stored answer and history. Failed jobs return a short safe message with no provider response or credential data.

Model failures retry at most three times with increasing Queue delay. Initial Queue sends also stop after three attempts. Exhausted work enters the `dead` state instead of waiting forever. A request is limited to 4,000 characters, model context is capped at 20 stored messages, and the default account limit is 20 new messages per minute.

Migration `0003_hosted_chat_runtime.sql` adds account-keyed avatars, threads, messages, jobs, and rate-limit rows. Every read and write includes the authenticated account id. The browser's supplied history and avatar text are not trusted as stored state.

Migration `0006_portable_public_avatars.sql` adds public slugs, visibility, listing state, current revision pointers, and immutable revision rows. New avatars are public and listed by default. Private avatars remain owner-only. D1 and R2 are runtime mirrors; owners must keep or permanently anchor the canonical artifact outside the Cloudflare account for full disaster recovery.

Required chat bindings:

| Binding                        | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `SWARM_QUEUE`                  | Carries `swarm.hosted.chat.request` work.                      |
| `SWARM_AVATAR_COORDINATORS`    | Durable Object namespace for per-avatar leases.                |
| `SWARM_OPENROUTER_MODEL`       | Optional model override; defaults to the zero-cost `openrouter/free` router. |
| `SWARM_OPENROUTER_CHAT_URL`    | Optional OpenRouter-compatible chat endpoint for tests/stacks. |
| `SWARM_HOSTED_CHAT_RATE_LIMIT` | Optional messages-per-minute override, clamped to 1–100.       |
| `SWARM_CF_STAGING_DOMAIN`      | Production Custom Domain used before primary-host cutover.     |
| `SWARM_CF_ZONE_NAME`           | Cloudflare zone used to validate production routes.            |
| `SWARM_CF_PRIMARY_ROUTE`       | Optional approved primary route in exact `hostname/*` form.    |

### Authoritative hosted lifecycle

Billing and runtime availability use one provider-neutral lifecycle shared by core, the Worker, local mode,
and Studio. Checkout only records `checkout-pending`; it cannot record payment. A payment provider sends an
HMAC-authenticated event to `/api/webhooks/hosting/billing`, and a runtime provider sends provisioning and
health events to `/api/webhooks/hosting/runtime`. Provider event ids are durable and idempotent, and older
events cannot undo a later cancellation or failure.

`paid` requires provider evidence. `active` additionally requires a provisioned runtime id and a successful
health check no older than five minutes. The minute reconciliation job stops work after cancellation or
payment failure and moves stale runtimes back to health-checking. Queue workers repeat the same check before
calling a model, so already queued work cannot continue on stale evidence.

Migration `0011_hosted_lifecycle.sql` stores the lifecycle and processed provider event ids. The migration must
be applied before enabling strict enforcement. `SWARM_HOSTED_LIFECYCLE_REQUIRED=1` makes accounts without a
lifecycle row fail closed; the default remains `0` only for a staged migration of existing hosted accounts.
Accounts that have entered the lifecycle always use the evidence-backed gate regardless of this rollout flag.

Required control-plane secrets:

| Binding                           | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `SWARM_BILLING_WEBHOOK_SECRET`    | Verifies authoritative billing events.                     |
| `SWARM_RUNTIME_CALLBACK_SECRET`   | Verifies provisioning and runtime-health events.           |
| `SWARM_HOSTED_LIFECYCLE_REQUIRED` | Set to `1` after migration/backfill to block missing state. |

The Worker deployment configuration and protected manual release workflow are documented in
[`docs/CLOUDFLARE-HOSTED-RUNBOOK.md`](../CLOUDFLARE-HOSTED-RUNBOOK.md). Production first uses the
`next.swarm.rati.chat` Custom Domain. The final `swarm.rati.chat/*` Worker Route is activated only
when its hostname matches the canonical SIWS and OAuth origin. The existing proxied GitHub Pages
record stays in place as the route-level rollback origin.

### Secret envelope

Every stored secret receives a random 256-bit data-encryption key. AES-256-GCM encrypts the secret, and a versioned root key wraps the data key with separate authenticated context. The context includes account, optional tenant, and secret name, preventing ciphertext from being moved between tenants or purposes.

Required production bindings:

| Binding                               | Purpose                                                              |
| ------------------------------------- | -------------------------------------------------------------------- |
| `SWARM_PUBLIC_URL`                    | Canonical HTTPS origin used for SIWS and OAuth callbacks.            |
| `SWARM_USER_SECRET_KEK`               | Base64url-encoded 32-byte active wrapping key.                       |
| `SWARM_USER_SECRET_KEY_VERSION`       | Active key version, for example `v1`.                                |
| `SWARM_USER_SECRET_KEK_<OLD_VERSION>` | Optional old wrapping keys retained while ciphertext is rotated.     |
| `SWARM_HOSTED_ENABLED=1`              | Enables hosted availability reporting after required bindings exist. |
| `SWARM_OPENROUTER_RETURN_PATH`        | Optional same-origin UI return path after OAuth.                     |

Production requests fail closed when the canonical public URL or encryption material is missing. Old wrapping keys may decrypt existing envelopes during a controlled re-encryption migration; remove them after rotation completes.

Desktop wallet sign-in uses a short-lived cross-device pairing. The Worker returns a public pairing ID for the Phantom or Solflare browse QR and a separate desktop-only poll token. D1 stores hashes of both. The phone opens Swarm inside its wallet, signs a SIWS message containing the visible pairing code, and marks the pairing approved. Only the desktop poll token can consume that approval and receive the HttpOnly session cookie. Pairings expire after five minutes and can be consumed once. Installed browser adapters remain a fallback. No seed phrase, transaction, or session credential is placed in the QR.

## Migration Roadmap

1. **Foundation — implemented:** provider-neutral hosted plans, D1/R2/Queue adapters, SIWS sessions, encrypted user secrets, and OpenRouter PKCE.
2. **Hosted web app — implemented:** same-origin wallet sign-in, OAuth connect/status/disconnect, avatar creation, and Queue-backed browser chat without browser-visible AI credentials.
3. **Web chat runtime — implemented:** tenant-owned avatars and history, idempotent Queue jobs, per-avatar serialization, bounded model retries, and safe failed jobs.
4. **Webhook runtime — implemented:** Telegram ingress, owner/group binding, per-chat and per-topic history, direct replies, typing/reactions, group controls, safe delivery state, and Queue processing.
5. **Portable public projects — implemented:** default-public registry, strict content-addressed artifacts, owner export/import, R2 mirrors, NFT-ready metadata, and blank-environment restore proof.
6. **Entitlement lifecycle — implemented:** provider-neutral billing, provisioning, health evidence, reconciliation, and model-work gating. A customer-facing checkout/portal adapter can now feed the signed billing webhook.
7. **Persistent channels:** adapt the existing multi-tenant Discord gateway to encrypted credential lookup and Cloudflare Queue delivery.
8. **Media and scheduling:** move blobs to R2 and scheduled jobs to D1 plus Cron/Workflows.
9. **Operational hardening:** permanent artifact anchoring, owner-authorized NFT minting, KMS-backed root-key wrapping, secret re-encryption jobs, audit reporting, monitoring, and kill switches.
10. **Burst compute:** use an external sandbox only for workloads that truly need a Linux computer.

## Cost Guardrails

- Do not provision one always-on VM or container per $9 customer.
- Prefer shared Workers, D1, R2, and Queues with strict per-account limits.
- Use Durable Objects for coordination, not idle compute or outbound Discord sockets.
- Store user secrets in encrypted rows, not one platform secret per user.
- Keep logs concise, redact authorization material, and use short retention.
- Apply TTLs and quotas to every sandbox workload.
- Reject over-quota work before making an AI or third-party API call.

## Known Caveats

- The current implementation processes browser chat and text/caption Telegram conversations. Telegram binary
  media, Discord, tools, and scheduling still use other runtimes.
- A concrete checkout/portal provider adapter is still required for a public paid launch; it must feed the provider-neutral signed billing webhook instead of writing paid state directly.
- D1 is not DynamoDB. Access patterns must be deliberate, and broad scans should be avoided.
- Durable Objects are appropriate for coordination and inbound realtime clients, not arbitrary long-running processes.
- Discord gateway connections require a persistent specialized service.
- A public paid launch should move wrapping-key custody from a Worker secret to a dedicated KMS while preserving the envelope and key-version format.
