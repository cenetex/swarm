# Preview Environment

A shared, manually-driven preview env for testing aws-swarm changes against real AWS without burning prod or maintaining a permanent staging account. Replaces the staging environment retired 2026-05-01 (#1642).

> **Status (2026-05-01):** scaffolded only. Config block is in `cdk.context.json` under `environments._preview_template`. Not deployable until the placeholder ARNs are provisioned and the block is renamed to `preview`. Tracked in #1643 (E2E re-targeting decision) and #1645 (this scaffold).

## Why this shape

Single shared "preview" env, not per-PR ephemeral. Reasons:

- Per-PR ephemeral envs require: wildcard cert, dynamic R53 records, PR-open/close webhook handler, ~10-15min CloudFront cold-start per env, per-env Privy app provisioning (Stripe webhooks have a hard endpoint cap). That's a 2-3 week project. Not yet justified.
- Shared preview is good enough for ~80% of staging's use case (manual smoke testing of an unmerged branch against real AWS) at ~10% of the always-on cost.

## Account & isolation

- **Account:** `022118847419` (the empty former-staging account)
- **Stack hash:** `preview01` — every stack carries `-preview-preview01` suffix
- **Domain:** `preview-swarm.rati.chat` (single, manually managed Route53 record + ACM cert)
- **Secrets path:** `swarm/preview/*` in Secrets Manager
- **DDB tables / S3 buckets:** named with the stackHash suffix, isolated from other envs

## Cost stance

- WAF disabled (`enableWaf: false`)
- Discord gateway disabled (`enableDiscordGateway: false`)
- No `useExistingResources` import — preview always creates fresh resources, deletes them on teardown
- Expected idle cost: ~$15-30/mo. Tear down between active testing windows to drop to ~$0.

## Provisioning checklist (before first deploy)

In account `022118847419`:

1. ACM certificate for `preview-swarm.rati.chat` (or wildcard `*.preview.swarm.rati.chat` if multi-preview is needed later)
2. Secrets Manager entries (sandbox / non-prod credentials only):
   - `swarm/preview/openrouter-api-key`
   - `swarm/preview/replicate-api-key`
   - `swarm/preview/helius-api-key`
   - `swarm/preview/web-search-api-key`
   - `swarm/preview/privy-app-secret` (Privy sandbox app)
   - `swarm/preview/privy-jwt-verification-key`
3. New Privy app in sandbox mode → `privyAppId` value
4. Route53 record placeholder (gets aliased after first CloudFront deploy)
5. Update `cdk.context.json`: replace placeholder ARNs in `_preview_template`, rename to `preview`

## Deploy

Once provisioned:

```bash
# From a clean checkout of main (or a feature branch you want to preview)
cd packages/infra
pnpm cdk deploy --all -c environment=preview --profile staging
```

Deploys all 6 domain stacks (Core, Messaging, Media, Station, Api, Frontend) against account `022118847419`.

## Teardown

```bash
cd packages/infra
pnpm cdk destroy --all -c environment=preview --profile staging
```

Drops everything. Re-deploy when needed.

## What this env is NOT for

- **Production smoke tests** — those run on tag deploy via `prod-smoke` job in `deploy.yml`
- **Long-running canaries** — preview is meant to be torn down between sessions; canaries stay in prod
- **Persistent test data** — DDB tables are throwaway. Don't seed anything you can't recreate
- **Per-PR isolation** — last writer wins; coordinate manually

## Future: per-PR ephemeral envs (option B)

If shared preview gets contended (multiple devs stomping on each other on the same week), graduate to per-PR ephemeral envs. The CDK app already supports parametric `stackHash` (each PR could get one), but you'll need:
- Wildcard cert `*.preview.swarm.rati.chat`
- PR-open / PR-close webhook handler that runs `cdk deploy` / `cdk destroy`
- Pre-warmed CloudFront distribution pool to dodge the 10-15min cold-start
- Solution for Privy/Stripe per-env (likely shared sandbox creds across all preview-* envs)

Tracked as a deferred follow-up in #1643's resolution.
