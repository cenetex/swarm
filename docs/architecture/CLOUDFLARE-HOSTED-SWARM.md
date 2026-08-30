# Cloudflare-Native Hosted Swarm

This is the target architecture for the paid hosted tier. Users choose **Local** or **Hosted 24/7**; infrastructure providers remain an internal implementation detail.

The hosted product is a hybrid dApp. Solana provides user identity and may provide entitlement or payment proofs. Secrets, messages, model calls, and always-on execution remain in a shared off-chain runtime. A browser-only or fully on-chain runtime cannot safely retain credentials or keep Telegram and Discord agents alive after the browser closes.

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
| App state                  | D1                        | Start with a shared tenant-keyed database; shard by cohort as measured limits require. |
| Media/blobs                | R2                        | Generated images, exports, and attachments.                                            |
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
3. `GET /api/auth/openrouter` creates a one-use PKCE S256 transaction bound to the account and current session. Only a hash of OAuth state is stored.
4. The PKCE verifier is envelope-encrypted while pending. The callback consumes it once before exchanging the authorization code.
5. The returned user-owned OpenRouter key is envelope-encrypted immediately. API responses expose connection status, never credential values.
6. `DELETE /api/auth/openrouter` removes the encrypted AI credential and provider selection.

The dedicated hosted UI is served from the same Worker origin. It starts OAuth through the authenticated route, reads only connection status, and never renders or accepts the exchanged credential. The write-only manual-key route remains a compatibility surface for trusted non-hosted clients; it is not part of normal hosted onboarding.

### Hosted workspace presentation

The hosted UI is one chat-first workspace rather than a dashboard of independent cards. On desktop, a narrow management rail holds account, runtime, provider, and avatar controls beside one continuous conversation surface. On smaller screens, chat remains visible first and the same controls move behind a single **Manage** action. Assistant responses use flat transcript rows; only user-authored turns receive a restrained visual accent. New connectors should extend the management rail instead of adding new top-level panels around chat.

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

This slice does not activate a paid entitlement and does not report a tenant as subscribed or active.

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
4. **Webhook runtime:** port Telegram ingress onto the same Queue and account-isolation rules.
5. **Entitlement and quotas:** connect Stripe checkout/portal and optional on-chain entitlement; enforce request, token, storage, and concurrency limits before model calls.
6. **Persistent channels:** adapt the existing multi-tenant Discord gateway to encrypted credential lookup and Cloudflare Queue delivery.
7. **Media and scheduling:** move blobs to R2 and scheduled jobs to D1 plus Cron/Workflows.
8. **Operational hardening:** KMS-backed root-key wrapping, secret re-encryption jobs, audit reporting, data export/deletion, monitoring, and administrative kill switches.
9. **Burst compute:** use an external sandbox only for workloads that truly need a Linux computer.

## Cost Guardrails

- Do not provision one always-on VM or container per $9 customer.
- Prefer shared Workers, D1, R2, and Queues with strict per-account limits.
- Use Durable Objects for coordination, not idle compute or outbound Discord sockets.
- Store user secrets in encrypted rows, not one platform secret per user.
- Keep logs concise, redact authorization material, and use short retention.
- Apply TTLs and quotas to every sandbox workload.
- Reject over-quota work before making an AI or third-party API call.

## Known Caveats

- The current implementation processes browser chat only. Telegram, Discord, media, tools, and scheduling still use other runtimes.
- Hosted status may report `available`; it must not report an active tenant runtime until entitlement state is connected in #1814.
- D1 is not DynamoDB. Access patterns must be deliberate, and broad scans should be avoided.
- Durable Objects are appropriate for coordination and inbound realtime clients, not arbitrary long-running processes.
- Discord gateway connections require a persistent specialized service.
- A public paid launch should move wrapping-key custody from a Worker secret to a dedicated KMS while preserving the envelope and key-version format.
