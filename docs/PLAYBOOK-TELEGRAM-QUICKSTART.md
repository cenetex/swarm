# Telegram Operations Quickstart Playbook

> Fast path for onboarding or repairing one Telegram avatar in about 10 minutes.
>
> For full incident response and DLQ recovery, use [RUNBOOK.md](./RUNBOOK.md).

## When To Use This

- A new avatar needs Telegram webhook setup verification.
- An existing avatar stopped responding and needs quick diagnosis and repair.

## Quick Triage

Start here. Match the symptom, then jump to the indicated step.

| Symptom | Likely cause | Go to |
|---|---|---|
| Bot not responding at all | Webhook not registered, token missing, or avatar inactive | [Step 2](#2-diagnose-telegram-wiring-read-only) |
| Bot was working, then stopped | Secret mismatch or webhook URL changed after deploy | [Step 2](#2-diagnose-telegram-wiring-read-only), then [Webhook Secret Mismatch](#webhook-secret-mismatch-invalid_secret) |
| `invalid_secret` in logs | Webhook secret in Secrets Manager differs from what Telegram has | [Webhook Secret Mismatch](#webhook-secret-mismatch-invalid_secret) |
| `pending_update_count` growing | Telegram is queuing updates because the webhook is failing | [Step 5](#5-validate-telegram-side-webhook-state), then [Pending Updates](#pending-updates-or-last-webhook-error) |
| Bot replies in some chats but not others | Group chat not registered as home channel | [RUNBOOK.md Section 2, Cause 6](./RUNBOOK.md#cause-6-chat-not-allowed-home-channel-registry) |
| Multiple avatars broken at once | Shared infrastructure issue or deploy regression | [Bulk Repair](#bulk-repair) |

## Prerequisites

- AWS credentials with access to the Swarm stack and Secrets Manager.
- `AWS_REGION` set (helper scripts default to `us-east-1`).
- `jq` installed.
- Admin API internal test access (`x-internal-test-key`) available for your environment.

The helper scripts (`test-api.sh`, `avatar-logs.sh`, `avatar-inspect.sh`) auto-discover the API Gateway URL and internal test key from CloudFormation stack outputs. They require valid AWS credentials with `cloudformation:DescribeStacks` and `secretsmanager:GetSecretValue` permissions. You can also set `SWARM_ADMIN_API_URL` and `SWARM_INTERNAL_TEST_KEY` environment variables directly to skip discovery.

If your environment disables internal test access, run equivalent checks via authenticated admin API calls and use [RUNBOOK.md](./RUNBOOK.md) for CLI fallback.

## 0. Set Context

```bash
ENV=staging          # or "production"
AVATAR_ID=my-avatar  # the avatar identifier (e.g. "rati", "agent-1-6yan")
export AWS_REGION=us-east-1
```

## 1. Check Avatar And Integration State

```bash
# Verify the avatar exists and is enabled
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}" '{}' GET | jq '{avatarId, enabled, platforms}'

# Check all integration statuses (telegram, twitter, etc.)
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/integrations" '{}' GET | jq
```

If `enabled` is `false` or the avatar is not found, the bot will silently ignore all messages. Activate through the admin UI before continuing.

## 2. Diagnose Telegram Wiring (Read-Only)

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/diagnose" '{}' GET | \
  jq '{stepState, reasonCodes, issues, platformEnabled, tokenPresent, webhookSecretPresent, webhook}'
```

Interpretation:

| `stepState` | Meaning | Next action |
|---|---|---|
| `verified` | Telegram wiring looks healthy | Jump to [Step 5](#5-validate-telegram-side-webhook-state) to confirm from Telegram's side |
| `repairable` | Issues detected that auto-repair can fix | Continue to [Step 3](#3-run-repair-safely) |
| `blocked` | Missing required setup (usually bot token) | See [Missing Bot Token](#missing-bot-token-tokenpresentfalse) in Common Fixes |

Check `reasonCodes` for specifics. Common codes: `missing_token`, `missing_webhook_secret`, `webhook_url_mismatch`, `invalid_secret`, `pending_updates`.

## 3. Run Repair Safely

Always dry-run first to see what the repair would do:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" '{"dryRun":true}' POST | \
  jq '{action, reason, idempotent, reasonCodes}'
```

If `action` is `"would_repair"`, apply the repair:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"repairOnPendingUpdates":true,"repairOnLastError":true}' POST | \
  jq '{action, rotatedSecret, status, onboardingStep}'
```

If `action` is `"skipped"`, the system sees no repair needed. Double-check with [Step 5](#5-validate-telegram-side-webhook-state).

Force secret rotation when `invalid_secret` persists after a normal repair:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"rotateSecret":true}' POST | \
  jq '{action, rotatedSecret, status}'
```

Note: After secret rotation, the webhook Lambda caches the old secret for up to 5 minutes. Expect a brief window where Telegram updates may be rejected.

## 4. Verify With Logs And Consolidated Snapshot

Check recent Telegram-subsystem logs for the avatar:

```bash
./scripts/avatar-logs.sh "$ENV" "$AVATAR_ID" --since 30m --subsystem telegram --limit 100 | \
  jq '{count:(.events|length), latest:(.events[0] // null)}'
```

Get a full consolidated snapshot (avatar config, integration statuses, recent logs):

```bash
./scripts/avatar-inspect.sh "$ENV" "$AVATAR_ID" --fast-since 2h --cloudwatch-since 2h | \
  jq '{integrations, logs:{fastCount:(.logs.fast.logs|length), cloudwatchCount:(.logs.cloudwatch.events|length)}}'
```

## 5. Validate Telegram-Side Webhook State

Query Telegram directly to see what it thinks the webhook configuration is:

```bash
TOKEN=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_bot_token/default" \
  --query SecretString --output text)

curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | \
  jq '.result | {url, pending_update_count, last_error_date, last_error_message}'
```

What to check:

- **`url`** -- should point to your API Gateway endpoint: `https://<API_DOMAIN>/webhook/telegram/<AVATAR_ID>`.
- **`pending_update_count`** -- should be 0 or very low. If growing, the webhook is failing.
- **`last_error_message`** -- if present, describes the most recent delivery failure.

## 6. End-To-End Smoke Test

After repair, confirm the full pipeline works by sending a test message to the bot in Telegram and verifying a response arrives. Then check the logs to confirm the message flowed through all stages:

```bash
# Wait 30-60 seconds after sending a message, then check for recent activity
./scripts/avatar-logs.sh "$ENV" "$AVATAR_ID" --since 5m --limit 20 | \
  jq '[.events[] | {event, subsystem, level}]'
```

You should see events flowing through: `request_received` (webhook) -> `message_enqueued` (SQS) -> `response_generated` (processor) -> `send_success` (sender).

If the message is not reaching the webhook at all, re-check [Step 5](#5-validate-telegram-side-webhook-state). If it reaches the webhook but fails during processing, escalate to [RUNBOOK.md Section 4](./RUNBOOK.md#4-message-processing-failures).

---

## Common Fixes

### Missing Bot Token (`tokenPresent=false`)

```bash
read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN && echo
BODY=$(jq -cn --arg key "telegram_bot_token" --arg value "$TELEGRAM_BOT_TOKEN" '{key:$key, value:$value}')
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/secrets" "$BODY" POST | jq
unset TELEGRAM_BOT_TOKEN BODY
```

After setting the token, re-run [Step 3](#3-run-repair-safely) to register the webhook.

### Webhook Secret Mismatch (`invalid_secret`)

Rotate the secret and re-register the webhook in one step:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" '{"rotateSecret":true}' POST | jq
```

Wait up to 5 minutes for the Lambda secret cache to expire, then verify with [Step 6](#6-end-to-end-smoke-test).

### Pending Updates Or Last Webhook Error

Clear pending updates and re-register the webhook:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"repairOnPendingUpdates":true,"repairOnLastError":true}' POST | jq
```

### Avatar Not Active

If Step 1 showed `enabled: false`, activate the avatar through the admin UI chat, then re-run diagnosis. The webhook handler silently drops messages for inactive avatars.

---

## Bulk Repair

When multiple avatars are affected (e.g., after a deploy that changed the API domain), use the bulk repair script:

```bash
# Dry run -- reports what would change for all avatars
SWARM_ADMIN_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com \
SWARM_INTERNAL_TEST_KEY=... \
  node scripts/repair-telegram-webhooks.mjs --dry-run

# Apply repairs (requires explicit confirmation)
SWARM_ADMIN_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com \
SWARM_INTERNAL_TEST_KEY=... \
  node scripts/repair-telegram-webhooks.mjs --apply --yes
```

You can also scope to specific avatars with `--only avatar-1,avatar-2` or limit concurrency with `--concurrency 3`.

For a pre-deploy audit of webhook state across all avatars:

```bash
SWARM_ADMIN_API_URL=... SWARM_INTERNAL_TEST_KEY=... \
  node scripts/report-telegram-webhook-mismatches.mjs
```

---

## Escalate To Full Runbook

- Full Telegram and DLQ recovery: [RUNBOOK.md](./RUNBOOK.md)
- Monitoring/alarm interpretation: [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md)
