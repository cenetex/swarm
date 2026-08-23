# Cloudflare Hosted Worker Runbook

This runbook deploys the browser-chat hosted runtime and its dedicated OAuth setup UI to an isolated Cloudflare Worker. Production is staged on `next.swarm.rati.chat`, then can replace the existing `swarm.rati.chat` static site through a reversible Worker route.

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
| `SWARM_CF_STAGING_DOMAIN`                | Empty in preview                  | Required production Custom Domain, `next.swarm.rati.chat`. |
| `SWARM_CF_ZONE_NAME`                     | Empty in preview                  | Required production Cloudflare zone, `rati.chat`.        |
| `SWARM_CF_PRIMARY_ROUTE`                 | Empty before cutover              | Optional final route, exactly `swarm.rati.chat/*`.       |
| `SWARM_PUBLIC_URL`                       | Worker `workers.dev` HTTPS origin | SIWS domain, OAuth callback origin, and smoke target.    |
| `SWARM_USER_SECRET_KEY_VERSION`          | `preview_v1`                      | Active wrapping-key version; letters, numbers, or `_`.   |
| `SWARM_USER_SECRET_PREVIOUS_KEY_VERSION` | Empty normally                    | Optional previous version during rotation.               |
| `SWARM_OPENROUTER_MODEL`                 | `openrouter/free`                 | Optional default model.                                  |
| `SWARM_HOSTED_CHAT_RATE_LIMIT`           | `20`                              | Optional messages per account per minute, from 1 to 100. |

The public URL must be one HTTPS origin with no path. Preview uses its exact `workers.dev` origin. Production uses `https://next.swarm.rati.chat` before cutover and `https://swarm.rati.chat` only when the primary route is activated. The configuration renderer rejects mismatched public origins and routes.

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

Wallet selection must immediately start the selected adapter connection. The hosted UI includes explicit Phantom and Solflare adapters and displays connection errors on the page. Browser wallet extensions are isolated per browser: if a wallet is not detected, open the preview in the browser where that extension is installed, or use the wallet's mobile browser.

Solflare starts its connection UI in a full-page frame from `https://connect.solflare.com`. The hosted Content Security Policy allows that exact origin, while still blocking arbitrary third-party frames. The opener policy uses `same-origin-allow-popups` so a selected wallet can finish its own cross-origin popup handshake without giving unrelated sites permission to frame Swarm.

Preview chat defaults to OpenRouter's zero-cost `openrouter/free` router. A paid model can be selected with `SWARM_OPENROUTER_MODEL`. Provider failures must remain safe but useful: expired authorization, missing credits, unavailable models, rejected input, and temporary outages have separate user messages. Logs may contain the HTTP status and Swarm request ID, but never the OpenRouter key, prompt, response body, wallet address, or account ID.

## Deploy production resources

Production deployment is allowed only from `main`. Select `production` and enter exactly `DEPLOY_PRODUCTION`. GitHub environment approval should provide a second human check.

For the first production deployment:

1. leave `SWARM_CF_PRIMARY_ROUTE` empty;
2. set `SWARM_CF_STAGING_DOMAIN=next.swarm.rati.chat`;
3. set `SWARM_CF_ZONE_NAME=rati.chat`;
4. set `SWARM_PUBLIC_URL=https://next.swarm.rati.chat`;
5. deploy and complete the wallet, OAuth, avatar, queued-chat, disconnect, and tenant-isolation checks.

Production disables the `workers.dev` hostname. The Worker is available only through its configured domains and routes.

## Cut over `swarm.rati.chat`

The current `swarm.rati.chat` record remains proxied to GitHub Pages. Do not delete or replace it during the first cutover. A Worker Route runs in front of that origin and can be removed without a DNS change.

After `next.swarm.rati.chat` passes the production checks:

1. set `SWARM_CF_PRIMARY_ROUTE=swarm.rati.chat/*`;
2. set `SWARM_PUBLIC_URL=https://swarm.rati.chat`;
3. deploy production from `main` with the required confirmation;
4. confirm `/`, `/health`, `/api/hosting/status`, static assets, wallet sign-in, OAuth, and one queued response on the primary hostname;
5. retain the `next.swarm.rati.chat` Custom Domain for diagnostics and rollback work.

The deployment workflow automatically removes the primary route if its post-deploy smoke check fails. It never deletes the existing static-site DNS record.

## Rollback

Use the Cloudflare Worker deployment history to select the previous known-good version. Wrangler also supports `wrangler deployments list` and `wrangler rollback <VERSION_ID>`, but production rollback should run from a protected operator environment, not a developer machine.

Worker rollback does not undo D1 migrations or stored data. The hosted migrations are additive, so the previous code should continue to work. Never delete or rename D1, R2, Queue, or Durable Object bindings during an emergency rollback.

If the new Worker cannot pass smoke checks:

1. remove `swarm.rati.chat/*` from the production Worker's routes in Cloudflare; the existing GitHub Pages origin resumes immediately;
2. clear `SWARM_CF_PRIMARY_ROUTE` and restore `SWARM_PUBLIC_URL=https://next.swarm.rati.chat` in the protected GitHub environment;
3. deploy production again so the Worker configuration matches the staging hostname;
4. inspect Cloudflare Worker and Queue logs;
5. confirm the D1 migration list and binding names;
6. fix forward in a new pull request.

## Rotate the wrapping key

Do not replace the active key without retaining the old key:

1. copy the current active version into `SWARM_USER_SECRET_PREVIOUS_KEY_VERSION`;
2. copy the current active key into `SWARM_USER_SECRET_PREVIOUS_KEK`;
3. set a new `SWARM_USER_SECRET_KEY_VERSION`;
4. generate a new `SWARM_USER_SECRET_KEK`;
5. run the deployment workflow and complete the preview smoke flow.

The workflow uploads the old key as `SWARM_USER_SECRET_KEK_<old-version>`. Wrangler preserves older secrets that are not included in a later deployment. Keep every old wrapping key until all matching D1 envelopes have been re-encrypted. Automated re-encryption and KMS-backed key custody remain operational-hardening work.

## References

- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
