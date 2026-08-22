# Cloudflare-Native Hosted Swarm

> Superseded for the default paid hosted tier by `docs/architecture/AWS-MANAGED-SWARM.md`.
> Cloudflare can still host static/web surfaces and edge routing, but managed 24/7 Swarm instances now target the AWS managed EC2-pool model.

This was the earlier Cloudflare-native target architecture for the paid hosted tier: users choose **Local** or **Hosted**. Provider choices stay internal.

## Product Model

### Local

- Runs while the native app is open.
- Uses local SQLite, local encrypted secrets, and local filesystem blobs.
- Good for free use, privacy-first workflows, development, and self-hosting.

### Hosted

- Runs 24/7 for a paid subscription.
- Users do not see provider names, runtime endpoints, shell commands, or provider API keys.
- Hosted core runs on Cloudflare. Specialized sandbox compute can use Ascii Box behind our backend.

## Cloudflare Service Map

| Swarm Need | Cloudflare Product | Notes |
| --- | --- | --- |
| Admin UI | Pages | Static app and public landing/chat pages. |
| API and webhooks | Workers | Auth callbacks, Stripe webhooks, Telegram webhooks, chat routes. |
| App state | D1 | Use many small tenant DBs or shards; keep each under D1 limits. |
| Media/blobs | R2 | No egress-fee media path; store generated images, exports, attachments. |
| Background work | Queues | Message processing, integration retries, media jobs. |
| Multi-step jobs | Workflows | Onboarding, long retry ladders, approval/post pipelines. |
| Periodic work | Cron Triggers | Wake due avatars/jobs; enqueue work rather than doing everything in cron. |
| Per-avatar serialization | Durable Objects | One coordinator per avatar/workspace for locks, realtime status, and duplicate-loop prevention. |
| Platform secrets | Cloudflare secrets | Global provider keys only. |
| User secrets | Encrypted D1/R2 rows | Envelope-encrypt before storage; do not create one Cloudflare secret per user. |
| Linux/browser/code sandbox | Ascii Box | Internal provider only, quota-gated. |

## Migration Shape

1. Add a platform contract in `@swarm/core`.
2. Keep `@swarm/local` as the local adapter.
3. Add `@swarm/cloudflare` as the hosted adapter.
4. Move shared business logic out of Express/Lambda-shaped handlers and behind the platform contract.
5. Port read-only hosted routes to Workers first: health, auth status, billing status, avatar list.
6. Port write routes with D1 transactions and Durable Object coordination.
7. Move background processing to Queues and Workflows.
8. Move media/blob paths to R2.
9. Add the Hosted subscription gate and hosted-mode UI.
10. Use Ascii Box only for workloads that truly need a Linux computer.

## Cost Guardrails

- Do not provision one always-on VM/container per $9 customer.
- Prefer shared Workers/D1/R2/Queues usage with strict per-account limits.
- Use Durable Objects for coordination, not idle compute.
- Store user secrets in encrypted rows/blobs, not one platform secret per user.
- Keep logs concise and retention short.
- Use Ascii Box with TTLs and quotas; never leave user sandboxes unbounded.

## Known Caveats

- D1 is not DynamoDB. Access patterns must be deliberate; avoid broad scans.
- D1 database size limits imply tenant sharding or per-tenant DBs as the product grows.
- Durable Objects are great for coordination and realtime, not for arbitrary long-running processes.
- Outbound persistent gateway workloads, such as Discord gateway, may remain on a specialized service until a Cloudflare-native replacement is proven.
- Cloudflare Containers may be useful later for bursty Linux tasks, but they should not become the default per-user hosted architecture.

## First Slice

The initial implementation adds:

- `@swarm/core` hosted platform contracts.
- `@swarm/cloudflare` adapter scaffold for D1 state, R2 blobs, Queues, platform secrets, and Worker health.
- D1 migration for a generic `swarm_kv` table.
- Fail-closed stubs for encrypted user secrets, scheduling, and Durable Object coordination.

That gives the repo a concrete migration target without changing current production traffic.
