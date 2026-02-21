# Telegram Operations Quickstart Playbook

> Fast path for onboarding or repairing one Telegram avatar in about 10 minutes.
>
> For full incident response and DLQ recovery, use [RUNBOOK.md](./RUNBOOK.md).

## When To Use This

- A new avatar needs Telegram webhook setup verification.
- An existing avatar stopped responding and needs quick diagnosis and repair.

## Prerequisites

- AWS credentials with access to the Swarm stack and Secrets Manager.
- `AWS_REGION` set (helper scripts default to `us-east-1`).
- `jq` installed.
- Admin API internal test access (`x-internal-test-key`) available for your environment.

If your environment disables internal test access, run equivalent checks via authenticated admin API calls and use [RUNBOOK.md](./RUNBOOK.md) for CLI fallback.

## 0. Set Context

```bash
ENV=staging
AVATAR_ID=my-avatar
export AWS_REGION=us-east-1
```

## 1. Check Avatar And Integration State

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}" '{}' GET | jq '{avatarId, enabled, platforms}'
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/integrations" '{}' GET | jq
```

## 2. Diagnose Telegram Wiring (Read-Only)

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/diagnose" '{}' GET | \
  jq '{stepState, reasonCodes, issues, platformEnabled, tokenPresent, webhookSecretPresent, webhook}'
```

Quick interpretation:

- `stepState=verified`: Telegram wiring looks healthy.
- `stepState=repairable`: run repair path below.
- `stepState=blocked`: missing required setup (usually token/config).

## 3. Run Repair Safely

Dry run first:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" '{"dryRun":true}' POST | \
  jq '{action, reason, idempotent, reasonCodes}'
```

Apply repair:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"repairOnPendingUpdates":true,"repairOnLastError":true}' POST | \
  jq '{action, rotatedSecret, status, onboardingStep}'
```

Force secret rotation when `invalid_secret` persists:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"rotateSecret":true}' POST | \
  jq '{action, rotatedSecret, status}'
```

## 4. Verify With Logs And Consolidated Snapshot

```bash
./scripts/avatar-logs.sh "$ENV" "$AVATAR_ID" --since 30m --subsystem telegram --limit 100 | \
  jq '{count:(.events|length), latest:(.events[0] // null)}'
```

```bash
./scripts/avatar-inspect.sh "$ENV" "$AVATAR_ID" --fast-since 2h --cloudwatch-since 2h | \
  jq '{integrations, logs:{fastCount:(.logs.fast.logs|length), cloudwatchCount:(.logs.cloudwatch.events|length)}}'
```

## 5. Validate Telegram-Side Webhook State

```bash
TOKEN=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_bot_token/default" \
  --query SecretString --output text)

curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | \
  jq '.result | {url, pending_update_count, last_error_date, last_error_message}'
```

## Common Fixes

### Missing Bot Token (`tokenPresent=false`)

```bash
read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN && echo
BODY=$(jq -cn --arg key "telegram_bot_token" --arg value "$TELEGRAM_BOT_TOKEN" '{key:$key, value:$value}')
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/secrets" "$BODY" POST | jq
unset TELEGRAM_BOT_TOKEN BODY
```

### Webhook Secret Mismatch (`invalid_secret`)

Run:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" '{"rotateSecret":true}' POST | jq
```

### Pending Updates Or Last Webhook Error

Run:

```bash
./scripts/test-api.sh "$ENV" "avatars/${AVATAR_ID}/telegram/repair" \
  '{"repairOnPendingUpdates":true,"repairOnLastError":true}' POST | jq
```

## Escalate To Full Runbook

- Full Telegram and DLQ recovery: [RUNBOOK.md](./RUNBOOK.md)
- Monitoring/alarm interpretation: [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md)
