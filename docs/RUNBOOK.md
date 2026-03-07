# Operational Runbook: Telegram Webhook Failures & DLQ Recovery

> AWS Swarm -- Multi-tenant avatar platform on AWS serverless.
>
> Need the fast setup/repair flow first? Start with [PLAYBOOK-TELEGRAM-QUICKSTART.md](./PLAYBOOK-TELEGRAM-QUICKSTART.md).

Replace the following placeholders throughout this document with values for your environment:

| Placeholder | Description |
|---|---|
| `REGION` | AWS region (e.g. `us-east-1`) |
| `ACCOUNT_ID` | AWS account ID |
| `ENVIRONMENT` | Stack environment (`staging` or `production`) |
| `AVATAR_ID` | The specific avatar identifier (e.g. `rati`) |
| `SUFFIX` | Optional name suffix on resources (e.g. `-a1b2c3`, or empty string) |

---

## 1. Incident Response Overview

### Alarm Notification Channels

All CloudWatch alarms route to an SNS topic. Subscriptions are configured in CDK (`alarmTopic` prop) and typically deliver to:

- **Email** -- subscribed operators receive alarm state-change notifications.
- **PagerDuty / Slack** -- add an SNS subscription for your preferred webhook endpoint.

Alarms defined per avatar (in `SharedHandlers`):

| Alarm | Metric | Threshold |
|---|---|---|
| `AVATAR_ID-ENVIRONMENT-messages-queue-depth` | Visible messages in message queue | > 10 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-responses-queue-depth` | Visible messages in response queue | > 10 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-media-queue-depth` | Visible messages in media queue | > 5 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-dlq-depth` | Messages in DLQ | > 1 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-dlq-age` | Age of oldest DLQ message | > 300 s for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-message-processor-errors` | Message processor Lambda errors | > 1 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-response-sender-errors` | Response sender Lambda errors | > 1 for 1 period (5 min) |
| `AVATAR_ID-ENVIRONMENT-media-processor-errors` | Media processor Lambda errors | > 1 for 1 period (5 min) |

Shared handler alarms follow the pattern `swarm-ENVIRONMENT-*`.

### Severity Classification

| Severity | Criteria | Response Time |
|---|---|---|
| **P1 -- Critical** | All messages failing; DLQ growing for every avatar; webhook Lambda returning 5xx to Telegram | 15 minutes |
| **P2 -- High** | Single avatar not receiving or responding to messages; DLQ growing for one avatar | 1 hour |
| **P3 -- Medium** | Intermittent failures; occasional DLQ messages; media generation delays | 4 hours |
| **P4 -- Low** | Cosmetic log errors; stale cache entries; non-blocking warnings | Next business day |

### Escalation Contacts

| Role | How to Reach | Notes |
|---|---|---|
| On-call engineer | SNS topic `swarm-alarms-{ENVIRONMENT}` (auto-notifies subscribed operators) | First responder for all alarms. Current on-call roster is maintained in the GitHub team `@cenetex/swarm-ops`. |
| Platform lead | `hello@ratimics.com` | P1/P2 escalation. Owns architecture decisions and deployment approvals. |
| AWS account owner | `hello@ratimics.com` | Infrastructure, billing, and IAM issues. Staging: `022118847419`, Prod: `332730082708`. |

> **Where is the on-call list?** The current on-call rotation is tracked via the `@cenetex/swarm-ops` GitHub team. SNS topic `swarm-alarms-{ENVIRONMENT}` delivers alarm notifications to all subscribed operators (email by default; add PagerDuty or Slack webhook subscriptions as needed).

### Escalation Procedure by Severity

| Severity | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| **P0 — Outage** | SNS alarm auto-pages on-call engineer | On-call engineer begins incident response within 15 min | If unresolved in 30 min, escalate to Platform Lead (`hello@ratimics.com`) |
| **P1 — Critical** | On-call engineer investigates (15 min response) | If root cause requires infra/billing changes, escalate to AWS Account Owner | Post status update to GitHub issue |
| **P2 — High** | On-call engineer investigates (1 hr response) | If architecture decision needed, loop in Platform Lead | Document findings in GitHub issue |
| **P3 — Medium** | Investigate during business hours | No escalation unless trending toward P2 | Track in GitHub issue |
| **P4 — Low** | Next business day | Address during regular ops review | Track in GitHub issue |

### Alarm Routing Configuration

All CloudWatch alarms route to SNS topic **`swarm-alarms-{ENVIRONMENT}`** (defined in `packages/infra/src/constructs/shared.ts`).

**Current subscriptions** (configured via CDK `alarmNotificationEmail` or `adminEmails`):
- **Email:** `hello@ratimics.com` (subscribed automatically by CDK when `alarmNotificationEmail` is set)

**To add additional notification channels:**

```bash
# Add a Slack incoming webhook
aws sns subscribe \
  --region us-east-1 \
  --topic-arn "arn:aws:sns:us-east-1:ACCOUNT_ID:swarm-alarms-ENVIRONMENT" \
  --protocol https \
  --notification-endpoint "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"

# Add PagerDuty integration
aws sns subscribe \
  --region us-east-1 \
  --topic-arn "arn:aws:sns:us-east-1:ACCOUNT_ID:swarm-alarms-ENVIRONMENT" \
  --protocol https \
  --notification-endpoint "https://events.pagerduty.com/integration/YOUR_KEY/enqueue"
```

Account IDs: Staging = `022118847419`, Production = `332730082708`.

---

## 2. Telegram Webhook Failures

### Architecture Recap

```
Telegram --> API Gateway (HTTP API) --> /webhook/telegram/{avatarId}
    --> telegram-webhook-shared Lambda
        --> Validates secret token (X-Telegram-Bot-Api-Secret-Token header)
        --> Falls back to adapter IP/signature verification
        --> Evaluates whether to respond
        --> Enqueues to SQS FIFO (MessageGroupId: avatarId#conversationId)
```

The webhook Lambda is `swarm-ENVIRONMENT-telegram-webhook` (shared multi-tenant handler).

### Symptom: Messages Not Being Received

Users report the bot is not responding in Telegram. No new messages appear in CloudWatch Logs for the webhook Lambda.

### Diagnosis Steps

**Step 1: Check if Telegram is sending updates at all.**

```bash
# Get the bot token from Secrets Manager
aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_bot_token/default" \
  --query SecretString --output text

# Check webhook status with Telegram
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq .
```

Look for:
- `url` -- should be `https://<API_DOMAIN>/webhook/telegram/AVATAR_ID`
- `has_custom_certificate` -- should be `false`
- `pending_update_count` -- if > 0, Telegram is queuing updates (webhook is failing)
- `last_error_date` / `last_error_message` -- most recent delivery failure reason

**Step 2: Check webhook Lambda invocations.**

```bash
# Check recent invocations (last 30 minutes)
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --start-time $(( $(date +%s) - 1800 ))000 \
  --filter-pattern "request_received" \
  --limit 20
```

If no invocations at all, the problem is upstream (Telegram cannot reach the endpoint).

**Step 3: Check API Gateway metrics.**

```bash
# Check API Gateway 4xx/5xx errors (last 1 hour)
aws cloudwatch get-metric-statistics \
  --region REGION \
  --namespace "AWS/ApiGateway" \
  --metric-name "5XXError" \
  --dimensions Name=ApiId,Value=<API_ID> \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum
```

**Step 4: Check for validation errors in the webhook Lambda.**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "validation_error" \
  --limit 20
```

Look for `invalid_secret` (secret token mismatch) or `invalid_signature` (IP/adapter check failure).

### Common Causes and Resolutions

#### Cause 1: Webhook URL Not Registered with Telegram

The webhook URL must be set via the Telegram Bot API for each avatar.

**Diagnosis:**

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq '.result.url'
```

If the URL is empty or wrong:

**Resolution:**

```bash
# Set the webhook (replace with your actual API domain)
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<API_DOMAIN>/webhook/telegram/AVATAR_ID" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"edited_message\",\"channel_post\",\"my_chat_member\",\"callback_query\"]"
```

Get the webhook secret:

```bash
aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_webhook_secret/default" \
  --query SecretString --output text
```

#### Cause 2: Secret Token Mismatch

The webhook Lambda verifies the `X-Telegram-Bot-Api-Secret-Token` header using timing-safe comparison. If the secret stored in Secrets Manager differs from the one registered with Telegram, all updates are rejected with a 401.

**Diagnosis:** Look for `"reason":"invalid_secret"` in CloudWatch Logs.

**Resolution:**

1. Retrieve the current secret from Secrets Manager:

```bash
aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_webhook_secret/default" \
  --query SecretString --output text
```

2. Re-register the webhook with the correct secret:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<API_DOMAIN>/webhook/telegram/AVATAR_ID" \
  -d "secret_token=<CORRECT_SECRET>"
```

3. Or, update the secret in Secrets Manager to match what Telegram has:

```bash
aws secretsmanager put-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_webhook_secret/default" \
  --secret-string "<NEW_SECRET>"
```

Note: The webhook Lambda caches the secret for 5 minutes (`WEBHOOK_SECRET_TTL_MS = 300000`). After updating, wait up to 5 minutes or redeploy the Lambda to force cache invalidation.

#### Cause 3: Lambda Cold Start Timeout

The webhook Lambda has a 30-second timeout. Cold starts with Secrets Manager and DynamoDB initialization can be slow.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "Task timed out" \
  --limit 10
```

**Resolution:**

- Check if the Lambda has provisioned concurrency configured. If cold starts are frequent, add provisioned concurrency in CDK.
- Check if DynamoDB or Secrets Manager is throttled (look for `ThrottlingException` in logs).
- Temporary: Telegram retries failed deliveries, so transient cold-start timeouts usually self-resolve.

#### Cause 4: API Gateway Throttling

The admin API has burst limit of 100 and rate limit of 50 requests/second.

**Diagnosis:** Check API Gateway `429` responses:

```bash
aws cloudwatch get-metric-statistics \
  --region REGION \
  --namespace "AWS/ApiGateway" \
  --metric-name "4XXError" \
  --dimensions Name=ApiId,Value=<API_ID> \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum
```

**Resolution:**

- Increase throttling limits in CDK (`DefaultRouteSettings`).
- Check if a single avatar is generating an abnormally high volume (potential abuse).

#### Cause 5: Avatar Not Active

The webhook handler checks avatar status. Only `active` avatars process messages; `draft`, `paused`, or `deleted` avatars are silently ignored.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "avatar_inactive" \
  --limit 10
```

**Resolution:** Activate the avatar through the admin UI or by updating the avatar's status in DynamoDB:

```bash
# Check current status
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key '{"pk":{"S":"AVATAR#AVATAR_ID"},"sk":{"S":"CONFIG"}}' \
  --projection-expression "#s" \
  --expression-attribute-names '{"#s":"status"}'
```

#### Cause 6: Chat Not Allowed (Home Channel Registry)

For group chats, the webhook checks if the chat is registered as a home channel. Messages from unregistered chats are dropped with `chat_blocked` in the logs.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "chat_blocked" \
  --limit 10
```

**Resolution:** Use the `/activate` command in the Telegram group (must be sent by a superadmin, the bot owner, or an allowed DM user). Alternatively, add the bot to the group -- the webhook handler auto-registers the first group as a home channel.

---

## 3. SQS DLQ Recovery

### Architecture Recap

All queues share a single DLQ per avatar (or per shared stack):

| Queue | DLQ Name | maxReceiveCount | FIFO |
|---|---|---|---|
| Messages | `AVATAR_ID-dlq.fifo` or `swarm-ENVIRONMENT-dlq.fifo` | 3 | Yes |
| Responses | (same DLQ) | 3 | Yes |
| Media | (same DLQ) | 3 | Yes |
| Posts | (same DLQ, shared stack only) | 5 | Yes |

DLQ retention is **14 days**. Messages that fail processing 3 times (or 5 for post queue) are moved to the DLQ.

### Symptom: Messages in DLQ (Alarm Fires)

The `AVATAR_ID-ENVIRONMENT-dlq-depth` alarm fires when >= 1 message appears in the DLQ.

### Diagnosis

**Step 1: Check DLQ depth.**

```bash
# Per-avatar DLQ
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/AVATAR_ID-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed

# Shared DLQ
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
```

**Step 2: Inspect DLQ messages (non-destructive peek).**

```bash
# Receive messages WITHOUT deleting (visibility timeout keeps them invisible temporarily)
aws sqs receive-message \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
  --max-number-of-messages 5 \
  --visibility-timeout 0 \
  --attribute-names All \
  --message-attribute-names All
```

Examine the message body to determine:
- **Which queue it came from**: Look at the `MessageGroupId` (format: `avatarId#conversationId` for message/response queues).
- **What kind of payload**: Message queue items contain an `envelope` field; response queue items contain `actions` and `platform`.
- **The correlation ID**: Check `messageAttributes.correlationId` to trace the full request lifecycle.

**Step 3: Check the corresponding processor logs.**

Use the correlation ID from the DLQ message to find related log entries:

```bash
# Search message processor logs by correlation ID
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 86400 ))000 \
  --filter-pattern '"CORRELATION_ID_VALUE"' \
  --limit 20

# Search response sender logs
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-response-sender" \
  --start-time $(( $(date +%s) - 86400 ))000 \
  --filter-pattern '"CORRELATION_ID_VALUE"' \
  --limit 20
```

### Common DLQ Causes

#### Cause 1: AI API Timeout or Error (Transient)

The message processor calls the LLM via OpenRouter. If the API is slow or returns 5xx, the Lambda fails and the message is retried up to 3 times before landing in the DLQ.

The message processor includes a **circuit breaker** (`failureThreshold: 3, cooldownMs: 30000`) that trips open after 3 consecutive LLM failures, fast-failing subsequent requests for 30 seconds.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "LLM API error" \
  --limit 20

# Check circuit breaker state
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "circuit_breaker" \
  --limit 10
```

**Resolution:** These are safe to redrive once the LLM provider is healthy again. See the Redrive Procedure below.

#### Cause 2: Missing Avatar Config in DynamoDB

The message processor fetches avatar config from the `STATE_TABLE`. If the config is missing (deleted avatar, replication lag, corrupted data), processing fails.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "Missing avatarId" \
  --limit 10

# Check if avatar config exists
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key '{"pk":{"S":"AVATAR#AVATAR_ID"},"sk":{"S":"CONFIG"}}'
```

**Resolution:** If the avatar was deleted intentionally, purge the DLQ messages (do not redrive). If the config is missing by mistake, re-sync from the admin table or re-create via the admin UI, then redrive.

#### Cause 3: Entitlement Limit Exceeded (Permanent Failure)

The message processor enforces daily usage limits. When the limit is exceeded, the message is **not retried** (the handler `continue`s without adding to `batchItemFailures`). However, if the entitlement check itself fails (DynamoDB error), it could cause a retry loop.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "limit_exceeded" \
  --limit 10
```

**Resolution:** Do **not** redrive entitlement-rejected messages. They will fail again. Purge them from the DLQ.

#### Cause 4: Malformed Message Payload

Invalid JSON or schema-validation failures are permanent errors. The handler reports them as `batchItemFailures` so they land in the DLQ after exhausting retries.

**Diagnosis:** Look for `parse_error` or `Invalid message queue item schema` in the processor logs.

**Resolution:** Purge these messages from the DLQ. Investigate the source (webhook handler) to determine why malformed payloads were enqueued.

#### Cause 5: Missing Secrets (OPENROUTER_API_KEY)

The message processor requires an `OPENROUTER_API_KEY` in the avatar's secrets. If missing, the LLM call throws `OPENROUTER_API_KEY not found in secrets`.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "OPENROUTER_API_KEY not found" \
  --limit 10
```

**Resolution:** Set the secret via the admin UI or directly:

```bash
aws secretsmanager put-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/openrouter_api_key/default" \
  --secret-string "<API_KEY>"
```

Then redrive the DLQ messages.

### Redrive Procedure

Before redriving, ensure the root cause is resolved. Redriving messages into a still-broken pipeline wastes compute and re-populates the DLQ.

**Step 1: Verify the processor is healthy.**

Send a test message through the pipeline or check recent successful invocations:

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 600 ))000 \
  --filter-pattern "response_generated" \
  --limit 5
```

**Step 2: Start the DLQ redrive.**

AWS SQS supports native DLQ redrive (since 2023). Use the console or CLI:

```bash
# Start redrive from DLQ back to source queue (shared stack)
aws sqs start-message-move-task \
  --region REGION \
  --source-arn "arn:aws:sqs:REGION:ACCOUNT_ID:swarm-ENVIRONMENT-dlq.fifo"
```

This moves all messages from the DLQ back to their original source queues.

**Step 3: Monitor the redrive.**

```bash
# Check redrive status
aws sqs list-message-move-tasks \
  --region REGION \
  --source-arn "arn:aws:sqs:REGION:ACCOUNT_ID:swarm-ENVIRONMENT-dlq.fifo"
```

**Step 4: After redrive, verify the DLQ is empty.**

```bash
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages
```

If messages reappear in the DLQ, the root cause is not resolved.

### Purging DLQ Messages (When Redrive Is Not Appropriate)

For permanent failures (entitlement limits, deleted avatars, malformed payloads):

```bash
aws sqs purge-queue \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo"
```

Warning: `purge-queue` deletes **all** messages in the DLQ, not just specific ones. If you need selective removal, use `receive-message` + `delete-message` in a loop.

---

## 4. Message Processing Failures

### 4.1 MessageProcessor Errors

**Lambda:** `swarm-ENVIRONMENT-message-processor`
**Timeout:** 180 seconds (shared), 60 seconds (per-avatar)
**Memory:** 1024 MB
**Concurrency:** 20 reserved (shared)
**Batch size:** 10 (shared), 1 (per-avatar)
**Reporting:** Partial batch failures (`reportBatchItemFailures: true`)

#### AI API Failures

**Symptom:** `LLM API error: 429` or `LLM API error: 502/503` in logs. Circuit breaker may trip.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "LLM API error" \
  --limit 20
```

**Resolution:**
- **429 (rate limit):** Check OpenRouter dashboard for quota. Reduce concurrency or add delay.
- **502/503 (provider down):** Wait for provider recovery. The circuit breaker will auto-recover after 30 seconds half-open.
- **Timeout:** The LLM call has a 90-second timeout (`LLM_TIMEOUT_MS`). If consistently timing out, consider switching to a faster model in the avatar config.

#### DynamoDB Errors

**Symptom:** `Failed to process message` with DynamoDB throttling or conditional check errors.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "ProvisionedThroughputExceededException" \
  --limit 10
```

**Resolution:**
- Check DynamoDB consumed capacity in CloudWatch. If consistently throttled, the table may need capacity adjustments (though PAY_PER_REQUEST mode should auto-scale).
- Check for hot partitions (many messages for a single avatar/conversation).

### 4.2 ResponseSender Errors

**Lambda:** `swarm-ENVIRONMENT-response-sender`
**Timeout:** 60 seconds (shared), 30 seconds (per-avatar)

#### Telegram API Rate Limits

**Symptom:** `send_failed` events; Telegram returns 429 Too Many Requests.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-response-sender" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "send_failed" \
  --limit 20
```

**Resolution:**
- Telegram rate limits are ~30 messages/second to the same chat, ~20 messages/minute to the same group.
- The response sender retries via SQS (message goes back to the queue after visibility timeout).
- If persistent, reduce response frequency in avatar behavior config (`responseDelayMs`, `cooldownMinutes`).

#### Bot Blocked by User

**Symptom:** Telegram API returns 403 Forbidden ("bot was blocked by the user").

**Resolution:**
- This is expected when a user blocks the bot in a DM. The response sender logs it and marks the response as handled.
- No action needed. These messages will eventually succeed (the sender handles the 403 gracefully) or land in the DLQ.
- DLQ messages from blocked users should be purged, not redriven.

#### DM Defense-in-Depth Block

**Symptom:** `dm_redirect_sent` in response sender logs instead of the expected persona reply.

The response sender has a secondary check: if the conversation ID looks like a private Telegram chat (positive numeric ID) and the user is not in the `allowedDmUserIds` list, it sends a redirect message instead.

**Resolution:** If this is unexpected, check the avatar's `allowedDmUsers` / `allowedDmUserIds` configuration in the STATE_TABLE.

### 4.3 MediaProcessor Errors

**Lambda:** `swarm-ENVIRONMENT-media-processor`
**Timeout:** 5 minutes
**Memory:** 1024 MB

#### Media Download Failures

**Symptom:** `job_failed` with network errors when downloading generated media from Replicate.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-media-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "job_failed" \
  --limit 10
```

**Resolution:** Transient network failures are safe to redrive. Persistent failures may indicate a Replicate API issue.

#### Entitlement / Energy Limit

**Symptom:** `limit_exceeded` with `subsystem: entitlements` in media processor logs.

The media processor checks daily media credits and energy burst pool before generating. If both are exhausted, the job is rejected and a text message ("Daily media generation limit reached") is sent instead.

**Resolution:** Do not redrive these. The user needs to wait until their daily limit resets or purchase more energy.

#### Avatar ID Mismatch

**Symptom:** `avatar_mismatch` in media processor logs.

Per-avatar media processors validate that the job's `avatarId` matches their own `AVATAR_ID` environment variable.

**Resolution:** This indicates a routing issue. Check if the media queue is being consumed by the correct Lambda. In the shared handler setup, this check is more lenient.

#### Replicate API Key Missing

**Symptom:** Errors about missing `REPLICATE_API_KEY` or empty secrets.

**Diagnosis:**

```bash
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-media-processor" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "Replicate" \
  --limit 10
```

**Resolution:** The media processor attempts to fall back to a system-level Replicate key (`REPLICATE_API_KEY_SECRET_ARN`). If both per-avatar and system keys are missing, image/video generation will fail. Set the system key or add a per-avatar key.

---

## 5. Common AWS CLI Commands

### Lambda Logs

```bash
# View recent errors for any handler
aws logs filter-log-events \
  --region REGION \
  --log-group-name "/aws/lambda/FUNCTION_NAME" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --filter-pattern "ERROR" \
  --limit 20

# Tail logs in real time
aws logs tail \
  --region REGION \
  "/aws/lambda/FUNCTION_NAME" \
  --follow \
  --since 5m

# Search by correlation ID across all handlers
for fn in telegram-webhook message-processor response-sender media-processor; do
  echo "=== swarm-ENVIRONMENT-$fn ==="
  aws logs filter-log-events \
    --region REGION \
    --log-group-name "/aws/lambda/swarm-ENVIRONMENT-$fn" \
    --start-time $(( $(date +%s) - 86400 ))000 \
    --filter-pattern '"CORRELATION_ID"' \
    --limit 5
done
```

### SQS Queue Operations

```bash
# Check message queue depth
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-messages.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Check response queue depth
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-responses.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Check DLQ depth
aws sqs get-queue-attributes \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Peek at DLQ messages (non-destructive)
aws sqs receive-message \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
  --max-number-of-messages 5 \
  --visibility-timeout 0 \
  --attribute-names All \
  --message-attribute-names All

# Redrive DLQ (native SQS redrive)
aws sqs start-message-move-task \
  --region REGION \
  --source-arn "arn:aws:sqs:REGION:ACCOUNT_ID:swarm-ENVIRONMENT-dlq.fifo"

# Check redrive progress
aws sqs list-message-move-tasks \
  --region REGION \
  --source-arn "arn:aws:sqs:REGION:ACCOUNT_ID:swarm-ENVIRONMENT-dlq.fifo"

# Purge DLQ (deletes ALL messages -- use with caution)
aws sqs purge-queue \
  --region REGION \
  --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo"
```

### Telegram Bot Operations

```bash
# Get bot token
TOKEN=$(aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_bot_token/default" \
  --query SecretString --output text)

# Check webhook status
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq .

# Set webhook with secret
SECRET=$(aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_webhook_secret/default" \
  --query SecretString --output text)

curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=https://<API_DOMAIN>/webhook/telegram/AVATAR_ID" \
  -d "secret_token=${SECRET}" \
  -d "allowed_updates=[\"message\",\"edited_message\",\"channel_post\",\"my_chat_member\",\"callback_query\"]"

# Delete webhook (stop receiving updates)
curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook"

# Get bot info
curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq .
```

### DynamoDB Operations

```bash
# Check avatar config
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key '{"pk":{"S":"AVATAR#AVATAR_ID"},"sk":{"S":"CONFIG"}}'

# Check avatar status
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key '{"pk":{"S":"AVATAR#AVATAR_ID"},"sk":{"S":"CONFIG"}}' \
  --projection-expression "#s" \
  --expression-attribute-names '{"#s":"status"}'

# Check daily usage counters
DATE=$(date +%Y-%m-%d)
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key "{\"pk\":{\"S\":\"USAGE#AVATAR_ID\"},\"sk\":{\"S\":\"MESSAGES#${DATE}\"}}"

# Check runtime entitlement limits
aws dynamodb get-item \
  --region REGION \
  --table-name "<STATE_TABLE>" \
  --key '{"pk":{"S":"LIMITS#AVATAR_ID"},"sk":{"S":"RUNTIME"}}'
```

### Secrets Manager Operations

```bash
# List all secrets for an avatar
aws secretsmanager list-secrets \
  --region REGION \
  --filters Key=name,Values=swarm/AVATAR_ID

# Get a specific secret value
aws secretsmanager get-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/telegram_bot_token/default" \
  --query SecretString --output text

# Update a secret value
aws secretsmanager put-secret-value \
  --region REGION \
  --secret-id "swarm/AVATAR_ID/openrouter_api_key/default" \
  --secret-string "<NEW_VALUE>"
```

---

## 6. CloudWatch Dashboard Guide

### Where to Find the Dashboard

CloudWatch dashboards are created per-environment. Navigate to:

**Console:** CloudWatch > Dashboards > `swarm-ENVIRONMENT`

Or use the CLI:

```bash
aws cloudwatch list-dashboards --region REGION
```

### Key Metrics to Monitor

| Metric | Source | Normal | Abnormal |
|---|---|---|---|
| **Webhook invocations** | Lambda `Invocations` metric for `swarm-ENVIRONMENT-telegram-webhook` | Steady stream matching Telegram activity | Zero invocations (webhook broken) or sudden spike (potential abuse) |
| **Message queue depth** | SQS `ApproximateNumberOfMessagesVisible` for messages queue | 0-2 (quickly drained) | > 10 sustained (consumer is behind or failing) |
| **Response queue depth** | SQS `ApproximateNumberOfMessagesVisible` for responses queue | 0-2 | > 10 sustained |
| **DLQ depth** | SQS `ApproximateNumberOfMessagesVisible` for DLQ | 0 | Any non-zero value triggers alarm |
| **Message processor duration** | Lambda `Duration` for message processor | 2-30 seconds | > 60 seconds (LLM slow), timeouts at 180 seconds |
| **Message processor errors** | Lambda `Errors` for message processor | 0 | > 0 indicates processing failures |
| **Response sender errors** | Lambda `Errors` for response sender | 0 | > 0 indicates delivery failures |
| **LLM circuit breaker** | Custom metric / log event `circuit_breaker_tripped` | Closed (healthy) | Open (LLM provider down) |

### Normal vs Abnormal Patterns

**Normal traffic pattern:**
- Webhook invocations correlate with active chat hours (typically higher during daytime in the bot's target timezone).
- Queue depths briefly spike to 1-3 during burst conversations, then drain within seconds.
- DLQ is empty.
- Message processor P99 latency is under 30 seconds.

**Abnormal patterns to investigate:**
- Queue depth climbing steadily: consumer Lambda is failing or throttled.
- DLQ growing: root cause investigation needed (see Section 3).
- Webhook invocations drop to zero while Telegram `getWebhookInfo` shows `pending_update_count > 0`: webhook endpoint unreachable.
- Message processor duration spiking with `circuit_breaker_open` logs: LLM provider outage.

---

## 7. Preventive Measures

### Regular Webhook Health Checks

Run a canary script on a schedule (e.g., every 5 minutes via CloudWatch Events or external monitoring) to verify Telegram webhook connectivity:

```bash
#!/bin/bash
# canary-webhook-check.sh
# Run for each active avatar to verify webhook is registered and healthy.

REGION="us-east-1"
AVATAR_ID="$1"

TOKEN=$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_bot_token/default" \
  --query SecretString --output text 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "WARN: No bot token found for ${AVATAR_ID}"
  exit 1
fi

INFO=$(curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo")
URL=$(echo "$INFO" | jq -r '.result.url // empty')
PENDING=$(echo "$INFO" | jq -r '.result.pending_update_count // 0')
LAST_ERROR=$(echo "$INFO" | jq -r '.result.last_error_message // empty')

if [ -z "$URL" ]; then
  echo "CRITICAL: Webhook URL not set for ${AVATAR_ID}"
  exit 2
fi

if [ "$PENDING" -gt 100 ]; then
  echo "WARN: ${AVATAR_ID} has ${PENDING} pending updates. Last error: ${LAST_ERROR}"
  exit 1
fi

echo "OK: ${AVATAR_ID} webhook healthy (pending: ${PENDING})"
exit 0
```

### DLQ Monitoring Schedule

- **Automated:** CloudWatch alarms fire on DLQ depth >= 1 (configured in CDK).
- **Daily review:** Check all DLQs once per day as part of ops routine:

```bash
# Quick check of all DLQs
for queue_url in $(aws sqs list-queues --region REGION --queue-name-prefix "swarm-" --query 'QueueUrls[?contains(@, `dlq`)]' --output text); do
  depth=$(aws sqs get-queue-attributes --region REGION --queue-url "$queue_url" --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text)
  if [ "$depth" != "0" ]; then
    echo "DLQ: $queue_url -- $depth messages"
  fi
done
```

### Capacity Planning

| Resource | Current Config | Scale Trigger |
|---|---|---|
| Message processor concurrency | 20 reserved (shared) | If queue depth alarm fires frequently, increase `reservedConcurrentExecutions` in CDK |
| Message queue visibility timeout | 180 seconds | Must be >= Lambda timeout to prevent duplicate processing |
| Response queue visibility timeout | 180 seconds | Must be >= response sender Lambda timeout |
| Media queue visibility timeout | 5 minutes | Must be >= media processor Lambda timeout |
| DLQ retention | 14 days | Increase if you need longer forensic windows |
| Lambda memory | 1024 MB (processors) | Monitor memory utilization; increase if seeing OOM errors |
| API Gateway throttle | 100 burst / 50 rate | Increase if legitimate traffic exceeds limits |

### Correlation ID Tracing

Every request generates a correlation ID that propagates through the entire pipeline:

1. **Webhook Lambda** -- extracts from `x-correlation-id` header or uses `requestContext.requestId` (source: `packages/core/src/utils/correlation.ts`).
2. **SQS message** -- correlation ID is attached as a message attribute (`correlationId`).
3. **Message Processor** -- extracts from SQS record attributes and sets in logger context.
4. **Response Sender** -- extracts from SQS record attributes and sets in logger context.

To trace a single user message from ingress to delivery:

```bash
CORRELATION_ID="<value from webhook logs>"

echo "=== Webhook ==="
aws logs filter-log-events --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-telegram-webhook" \
  --filter-pattern "\"$CORRELATION_ID\"" --limit 10

echo "=== Message Processor ==="
aws logs filter-log-events --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
  --filter-pattern "\"$CORRELATION_ID\"" --limit 10

echo "=== Response Sender ==="
aws logs filter-log-events --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-response-sender" \
  --limit 10 \
  --filter-pattern "\"$CORRELATION_ID\""

echo "=== Media Processor ==="
aws logs filter-log-events --region REGION \
  --log-group-name "/aws/lambda/swarm-ENVIRONMENT-media-processor" \
  --filter-pattern "\"$CORRELATION_ID\"" --limit 10
```

### Secret Rotation

- **Telegram bot tokens** -- cached for 5 minutes in the webhook Lambda. After rotation in Secrets Manager, allow up to 5 minutes for the new token to take effect.
- **Webhook secrets** -- cached for 5 minutes. After rotation, you must also re-register the webhook with Telegram using the new secret.
- **OpenRouter API keys** -- not cached at the SDK level, but the message processor caches avatar runtime (including secrets) per-avatar for the Lambda lifetime. A fresh Lambda invocation picks up new secrets.

### Post-Incident Checklist

After resolving any P1/P2 incident:

1. Verify all DLQs are empty (or contain only messages intentionally not redriven).
2. Verify all active avatars have healthy Telegram webhooks (`pending_update_count` near 0).
3. Verify message and response queue depths are draining normally.
4. Verify no CloudWatch alarms are in ALARM state.
5. Document the incident: root cause, timeline, resolution, and any follow-up actions.
6. If the incident revealed a monitoring gap, create a GitHub issue to add coverage.
