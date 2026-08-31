# Cloudflare Hosted Worker Runbook

This runbook deploys the browser-chat, Telegram, and X hosted runtime and its dedicated connector UI to an isolated Cloudflare Worker. Production is staged on `next.swarm.rati.chat`, then can replace the existing `swarm.rati.chat` static site through a reversible Worker route.

The normal release path is the **Deploy Cloudflare Hosted Worker** GitHub Actions workflow. Do not deploy production from a developer machine.

## What the deployment creates

Each environment uses its own resources:

- one Worker;
- one D1 database;
- one private R2 bucket;
- one Queue used by both the producer and consumer;
- one Durable Object namespace created with the Worker deployment;
- one versioned static asset bundle served from the same Worker origin;
- one one-minute cron that polls X mentions and also runs bounded cleanup work.

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
| `SWARM_X_API_KEY`                | X app API key used only for OAuth signing.      |
| `SWARM_X_API_SECRET`             | X app API secret used only inside the Worker.   |

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

## X app setup

Create one X developer app for each hosted environment. Give it read and write access and enable OAuth 1.0a three-legged authorization. Add the exact callback URL for that environment:

```text
https://<hosted-origin>/api/auth/x/callback
```

For production before cutover, the callback is:

```text
https://next.swarm.rati.chat/api/auth/x/callback
```

Save the OAuth 1.0a **API Key** as `SWARM_X_API_KEY` and its **API Key Secret** as
`SWARM_X_API_SECRET` in the matching protected GitHub environment. Do not use the OAuth 2.0 Client ID,
Client Secret, Bearer Token, Access Token, or Access Token Secret for these values. Do not store user access
tokens in GitHub. The Worker exchanges the short-lived request credential on the callback, encrypts the
resulting user token and token secret with the hosted keyring, and scopes them to the owning account and avatar.

The connector uses `GET /2/users/{id}/mentions` and `POST /2/tweets`. X API usage is billed by X under the developer app account, so configure spending limits and usage alerts in the X developer console before production enablement. Existing mentions are used only to establish the initial cursor and are not backfilled; new mentions are checked once per minute.

Mobile wallet sign-in needs no third-party project ID. The desktop requests a five-minute, one-use pairing from the Worker. The QR contains only the public pairing ID inside the official Phantom or Solflare in-app-browser link. A separate poll token stays in desktop memory, is stored only as a hash in D1, and is required before the Worker can issue the desktop session cookie. The phone signs a domain-bound SIWS message with the visible pairing code; it does not submit a Solana transaction.

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

The deployment workflow supplies `SWARM_USER_SECRET_KEK`, `SWARM_X_API_KEY`, and `SWARM_X_API_SECRET` through Wrangler's encrypted secrets file. They must never appear in the rendered plain variables.

## Deploy preview

1. Open GitHub Actions.
2. Select **Deploy Cloudflare Hosted Worker**.
3. Select `preview` and leave the production confirmation empty.
4. Run the workflow.

The workflow validates the package and asks X for a short-lived request token using the protected API Key pair
and the exact environment callback. This probe never prints or stores the returned token. If X rejects the
credentials, OAuth 1.0a settings, or callback, the workflow stops before changing the Worker. It then renders a
temporary configuration from protected values, applies D1 migrations, uploads the wrapping key with the Worker,
deploys, and checks:

```text
GET /health
GET /api/hosting/status
GET /
```

A successful status response must report a configured and available hosted runtime with no active entitlement. This means the infrastructure is ready; it does not mean billing or a paid subscription is active.

After the automated checks pass, complete one manual preview flow:

1. open the Worker root URL without a session and confirm the public registry loads;
2. confirm `/sitemap.xml` and `/api/public/avatars` work without a session;
3. open **Studio** and connect a Solana wallet;
4. sign the domain-bound session message;
5. create a default avatar before connecting a model, confirm it is public and listed, and download its portable artifact;
6. confirm the anonymous project page exposes the same revision and never exposes a credential or private chat;
7. select **Connect OpenRouter securely** and complete OpenRouter OAuth;
8. confirm the UI reports connected without displaying a credential;
9. send a browser-chat message and wait for the Queue job to complete;
10. create a test bot with BotFather, paste its token into **Telegram**, and confirm the
   token field clears without the token appearing in any later response;
11. open the ownership link, send `/start`, return to Swarm, and refresh Telegram status;
12. add the bot to a test group from the generated group link and confirm the group appears under **Bound groups**;
13. mention the bot, reply to its response, and use `/ask`; confirm replies attach to the source message and
    the source receives acknowledgement and completion reactions;
14. in a forum supergroup, send addressed prompts in two topics and confirm each response stays in its source topic;
15. send a photo with an addressed caption and confirm the caption is handled without downloading the photo;
16. pause and enable the group in Swarm, confirming paused groups receive no response; use **Copy command for
    an existing group** to bind a group where the bot is already present;
17. remove the bot from the group and refresh Swarm; confirm membership is shown as unavailable;
18. confirm an unbound private user, an unenabled group, and ordinary unmentioned group messages receive no response;
19. disconnect Telegram, then confirm Bot API `getWebhookInfo` no longer reports the Swarm webhook;
20. connect a test X account from **X**, confirm the callback returns to Studio with only the username, and verify no token appears in the page or API response;
21. mention the connected X account from another account, wait for the next one-minute poll, and confirm exactly one reply appears in the same conversation;
22. repeat the poll and confirm the same mention is not processed twice; revoke X access and confirm Studio changes to **Reconnect** after the next check;
23. reconnect, then disconnect X and confirm the encrypted X access-token rows and connector metadata are removed;
24. disconnect OpenRouter and confirm the connected state clears;
25. confirm that another wallet cannot read that avatar, connector, group list, job, history, or private artifact;
26. import the downloaded artifact into a clean preview environment and confirm the revision ID is unchanged.

The hosted interface is chat-first. At desktop widths, account, provider, and avatar controls live in the workspace rail. At mobile widths, open **Manage** to reach those controls and confirm that closing it returns directly to the active conversation without horizontal overflow.

The normal hosted flow is OAuth Authorization Code with PKCE S256. Do not ask a hosted user to paste an OpenRouter key. The callback exchanges the code inside the Worker, encrypts the resulting user credential for that account, and returns only connection status to the browser.

Wallet selection must immediately start the selected adapter connection. The hosted UI includes explicit Phantom and Solflare adapters and displays connection errors on the page. Browser wallet extensions are isolated per browser: if a wallet is not detected, open the preview in the browser where that extension is installed, or use the wallet's mobile browser.

Solflare starts its connection UI in a full-page frame from `https://connect.solflare.com`. The hosted Content Security Policy allows that exact origin, while still blocking arbitrary third-party frames. The opener policy uses `same-origin-allow-popups` so a selected wallet can finish its own cross-origin popup handshake without giving unrelated sites permission to frame Swarm.

Preview chat defaults to OpenRouter's zero-cost `openrouter/free` router. A paid model can be selected with `SWARM_OPENROUTER_MODEL`. Provider failures must remain safe but useful: expired authorization, missing credits, unavailable models, rejected input, and temporary outages have separate user messages. Logs may contain the HTTP status and Swarm request ID, but never the OpenRouter key, prompt, response body, wallet address, or account ID.

Telegram uses the Bot API webhook secret header and an opaque path. The BotFather token, webhook secret,
and binding codes must never appear in Worker logs. D1 metadata may contain the bot id and username but
must contain only hashes for binding codes. A delivery in `unknown` state is intentionally not retried;
check Telegram before deciding on any manual resend. Use **Repair and refresh links** to register the
webhook again and rotate expired binding links without asking the user to paste the token again.

Telegram v2 registers `message`, `edited_message`, `my_chat_member`, and `message_reaction` updates. The
connector uses `reply_parameters`, `message_thread_id`, `sendChatAction`, and `setMessageReaction`; reactions
and typing are best effort and must not change the final delivery state. A bot with group joining disabled is
rejected during setup with instructions to use BotFather `/setjoingroups`. Incoming binary media is ignored;
only text and captions are accepted in this release.

X uses OAuth 1.0a user context. D1 stores only account-scoped metadata, durable mention IDs, cursors, and
delivery state; request-token secrets and access credentials stay in the encrypted hosted secret store. A
`reauth_required` status means X returned 401 or 403 and the owner must reconnect. `x_rate_limited` waits for
the next scheduled check. A reply in `unknown` state is intentionally not retried because the POST may have
reached X. Check the source conversation before attempting any manual recovery. Logs may include the opaque
integration ID and safe error code, but never an X token, post text, username, wallet, account ID, or avatar ID.

If OAuth start returns `x_app_configuration_rejected`, check all three items together:

1. the GitHub environment contains the OAuth 1.0a API Key and API Key Secret from the same X app;
2. OAuth 1.0a user authentication is enabled with read and write permission; and
3. the callback allowlist contains the exact URL, including protocol and path, with no added trailing slash.

OAuth start failures also return a safe `stage` and numeric `upstreamStatus`. `signing` means the Worker could
not create the OAuth signature, `network` with status `0` means the Worker did not receive an HTTP response,
and `response` means X replied with the displayed status. Provider response bodies remain private.

## Deploy production resources

Production deployment is allowed only from `main`. Select `production` and enter exactly `DEPLOY_PRODUCTION`. GitHub environment approval should provide a second human check.

For the first production deployment:

1. leave `SWARM_CF_PRIMARY_ROUTE` empty;
2. set `SWARM_CF_STAGING_DOMAIN=next.swarm.rati.chat`;
3. set `SWARM_CF_ZONE_NAME=rati.chat`;
4. set `SWARM_PUBLIC_URL=https://next.swarm.rati.chat`;
5. deploy every migration through `0008_hosted_x.sql` and confirm a QR can be approved from both Phantom and Solflare;
6. complete public catalog, portable restore, OpenRouter OAuth, X OAuth, Telegram and X messaging, disconnect, and tenant-isolation checks.

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
