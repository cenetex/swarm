# Cloudflare Hosted Worker Runbook

This runbook deploys the browser-chat hosted runtime and its dedicated OAuth setup UI to an isolated Cloudflare Worker. It does not change `swarm.rati.chat`, the existing static site, or the AWS production system.

The normal release path is the **Deploy Cloudflare Hosted Worker** GitHub Actions workflow. Do not deploy production from a developer machine.

## What the deployment creates

Each environment uses its own resources:

- one Worker;
- one D1 database;
- one private R2 bucket;
- one Queue used by both the producer and consumer;
- one Durable Object namespace created with the Worker deployment;
- one versioned static asset bundle served from the same Worker origin;
- one cleanup cron that runs every 15 minutes.

Use `preview` first. Production uses a separate set of resources and a separate protected GitHub environment.

## One-time Cloudflare setup

Create the preview resources while authenticated to the correct Cloudflare account:

```bash
pnpm --filter @swarm/cloudflare exec wrangler d1 create swarm-hosted-preview
pnpm --filter @swarm/cloudflare exec wrangler r2 bucket create swarm-hosted-preview
pnpm --filter @swarm/cloudflare exec wrangler queues create swarm-hosted-preview
```

Save the D1 UUID printed by the first command. Repeat with `swarm-hosted-production` only when the preview environment has passed its functional checks.

The Durable Object namespace and cron are created from `packages/cloudflare/wrangler.json` during the first Worker deployment. R2 buckets are private by default and should remain private.

Create a narrowly scoped Cloudflare API token for GitHub Actions. Scope it to the single Swarm account and grant only the Worker, D1, R2, and Queue access needed by Wrangler. Never store this token in the repository.

## Protected GitHub environments

Create two GitHub environments:

- `cloudflare-preview`
- `cloudflare-production`

Require a reviewer for `cloudflare-production`.

Set these secrets in each environment:

| Secret                           | Purpose                                         |
| -------------------------------- | ----------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`          | Cloudflare account used by Wrangler.            |
| `CLOUDFLARE_API_TOKEN`           | Narrow deployment token.                        |
| `SWARM_USER_SECRET_KEK`          | Active base64url-encoded 32-byte wrapping key.  |
| `SWARM_USER_SECRET_PREVIOUS_KEK` | Optional previous wrapping key during rotation. |

Set these environment variables:

| Variable                                 | Preview example                   | Purpose                                                  |
| ---------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `SWARM_CF_WORKER_NAME`                   | `swarm-hosted-preview`            | Worker name.                                             |
| `SWARM_CF_D1_DATABASE_NAME`              | `swarm-hosted-preview`            | D1 name.                                                 |
| `SWARM_CF_D1_DATABASE_ID`                | UUID from `wrangler d1 create`    | D1 identifier.                                           |
| `SWARM_CF_R2_BUCKET_NAME`                | `swarm-hosted-preview`            | Private R2 bucket.                                       |
| `SWARM_CF_QUEUE_NAME`                    | `swarm-hosted-preview`            | Queue name.                                              |
| `SWARM_PUBLIC_URL`                       | Worker `workers.dev` HTTPS origin | SIWS domain, OAuth callback origin, and smoke target.    |
| `SWARM_USER_SECRET_KEY_VERSION`          | `preview_v1`                      | Active wrapping-key version; letters, numbers, or `_`.   |
| `SWARM_USER_SECRET_PREVIOUS_KEY_VERSION` | Empty normally                    | Optional previous version during rotation.               |
| `SWARM_OPENROUTER_MODEL`                 | `openai/gpt-4o-mini`              | Optional default model.                                  |
| `SWARM_HOSTED_CHAT_RATE_LIMIT`           | `20`                              | Optional messages per account per minute, from 1 to 100. |

The public URL must be one HTTPS origin with no path. Before DNS cutover it should be the exact `workers.dev` origin assigned to that Worker.

Generate a wrapping key without printing it to the terminal and save it directly as a GitHub environment secret:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | gh secret set SWARM_USER_SECRET_KEK --env cloudflare-preview
```

Use a different key for production.

## Validate before deployment

Pull requests run a Wrangler dry run. The same check is available locally and does not contact Cloudflare or mutate resources:

```bash
pnpm --filter @swarm/cloudflare deploy:dry-run
```

The dry run must show these bindings:

- `SWARM_STATE`
- `SWARM_BLOBS`
- `SWARM_QUEUE`
- `SWARM_AVATAR_COORDINATORS`
- `SWARM_ASSETS`

## Deploy preview

1. Open GitHub Actions.
2. Select **Deploy Cloudflare Hosted Worker**.
3. Select `preview` and leave the production confirmation empty.
4. Run the workflow.

The workflow validates the package, renders a temporary configuration from protected values, applies D1 migrations, uploads the wrapping key with the Worker, deploys, and checks:

```text
GET /health
GET /api/hosting/status
GET /
```

A successful status response must report a configured and available hosted runtime with no active entitlement. This means the infrastructure is ready; it does not mean billing or a paid subscription is active.

After the automated checks pass, complete one manual preview flow:

1. open the Worker root URL and connect a Solana wallet;
2. sign the domain-bound session message;
3. select **Connect OpenRouter securely** and complete OpenRouter OAuth;
4. confirm the UI reports connected without displaying a credential;
5. create an avatar;
6. send a browser-chat message and wait for the Queue job to complete;
7. disconnect OpenRouter and confirm the connected state clears;
8. confirm that another wallet cannot read that avatar, job, or history.

The normal hosted flow is OAuth Authorization Code with PKCE S256. Do not ask a hosted user to paste an OpenRouter key. The callback exchanges the code inside the Worker, encrypts the resulting user credential for that account, and returns only connection status to the browser.

## Deploy production resources

Production deployment is allowed only from `main`. Select `production` and enter exactly `DEPLOY_PRODUCTION`. GitHub environment approval should provide a second human check.

This deploys the production Worker to its `workers.dev` origin. It still does not route `swarm.rati.chat` traffic.

## Rollback

Use the Cloudflare Worker deployment history to select the previous known-good version. Wrangler also supports `wrangler deployments list` and `wrangler rollback <VERSION_ID>`, but production rollback should run from a protected operator environment, not a developer machine.

Worker rollback does not undo D1 migrations or stored data. The hosted migrations are additive, so the previous code should continue to work. Never delete or rename D1, R2, Queue, or Durable Object bindings during an emergency rollback.

If the new Worker cannot pass smoke checks:

1. leave `swarm.rati.chat` unchanged;
2. roll the Worker code back;
3. inspect Cloudflare Worker and Queue logs;
4. confirm the D1 migration list and binding names;
5. fix forward in a new pull request.

## Rotate the wrapping key

Do not replace the active key without retaining the old key:

1. copy the current active version into `SWARM_USER_SECRET_PREVIOUS_KEY_VERSION`;
2. copy the current active key into `SWARM_USER_SECRET_PREVIOUS_KEK`;
3. set a new `SWARM_USER_SECRET_KEY_VERSION`;
4. generate a new `SWARM_USER_SECRET_KEK`;
5. run the deployment workflow and complete the preview smoke flow.

The workflow uploads the old key as `SWARM_USER_SECRET_KEK_<old-version>`. Wrangler preserves older secrets that are not included in a later deployment. Keep every old wrapping key until all matching D1 envelopes have been re-encrypted. Automated re-encryption and KMS-backed key custody remain operational-hardening work.

## Later DNS cutover

DNS and route changes need a separate issue and review. The Worker serves a dedicated hosted UI, but the existing `swarm.rati.chat` site remains unchanged until a separate cutover is approved.

Possible cutover options must be reviewed separately. The smallest API-only route set remains:

```text
swarm.rati.chat/api/*
swarm.rati.chat/health
```

Keep the existing static site in place unless the approved cutover explicitly replaces it. Before adding any routes, change the production `SWARM_PUBLIC_URL` to the exact final HTTPS origin, deploy again, repeat wallet/OAuth/chat isolation checks, and prepare a route-level rollback.

## References

- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
