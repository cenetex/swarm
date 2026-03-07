# Monitoring & Alerting Operator Guide

> AWS Swarm -- Quick-reference guide for operators monitoring the platform.
>
> This guide complements the detailed [Operational Runbook](./RUNBOOK.md).
> For incident response procedures, DLQ recovery, and full CLI command reference, see the runbook.

Replace the following placeholders throughout this document with values for your environment:

| Placeholder | Description |
|---|---|
| `REGION` | AWS region (e.g. `us-east-1`) |
| `ENVIRONMENT` | Stack environment (`staging` or `production`) |

---

## 1. Dashboard Walkthrough

The `swarm-ops-{ENVIRONMENT}` CloudWatch dashboard provides a unified operational view of the platform. It is defined in CDK at `packages/infra/src/constructs/ops-dashboard.ts`.

**How to access:** AWS Console > CloudWatch > Dashboards > `swarm-ops-ENVIRONMENT`

Or via CLI:

```bash
aws cloudwatch list-dashboards --region REGION \
  --dashboard-name-prefix swarm-ops
```

The dashboard defaults to a **6-hour** time window with **5-minute** metric periods.

### Row 1: Lambda Invocations & Errors

| Widget (left) | Widget (right) |
|---|---|
| **Shared Handlers - Invocations** | **Shared Handlers - Errors** |

Both widgets track 5 Lambda functions:

| Function | Label | Purpose |
|---|---|---|
| MessageProcessor | `MessageProcessor` | Processes inbound messages through the AI pipeline |
| ResponseSender | `ResponseSender` | Delivers AI responses to Telegram/Discord |
| MediaProcessor | `MediaProcessor` | Downloads and processes media attachments |
| TweetSender | `TweetSender` | Posts tweets and threads to Twitter/X |
| TelegramWebhook | `TelegramWebhook` | Receives inbound Telegram updates |

**What to look for:**

- **Spikes in errors** -- A sudden increase in the Errors widget indicates a processing failure. Cross-reference with the specific function's CloudWatch Logs.
- **Drop to zero invocations** -- If TelegramWebhook invocations drop to zero while users report messages are not being received, the webhook endpoint may be unreachable. Check `getWebhookInfo` (see RUNBOOK.md Section 2).
- **High error-to-invocation ratio** -- A ratio above 10% sustained for more than 15 minutes indicates a systemic issue (e.g., API key expired, DynamoDB throttling).
- **Invocation pattern** -- Normal traffic follows chat hours with natural peaks and valleys. Flat-line high invocations may indicate a retry storm.

### Row 2: SQS Queue Depths & DLQ

| Widget (left) | Widget (right) |
|---|---|
| **SQS Queue Depths (Shared)** | **DLQ Message Counts** |

**Left widget -- Queue depths:**

| Queue | Label | Normal Depth | Concern Threshold |
|---|---|---|---|
| Messages | `Messages` | 0-2 | > 10 sustained |
| Responses | `Responses` | 0-2 | > 10 sustained |
| Media | `Media` | 0-2 | > 5 sustained |
| Posts | `Posts` | 0-2 | > 10 sustained |

Normal behavior: queue depths briefly spike to 1-3 during burst conversations, then drain within seconds as consumers process them.

Abnormal behavior: steadily climbing queue depth means the consumer Lambda is failing, throttled, or has reached its concurrency limit.

**Right widget -- DLQ counts:**

| DLQ | Label | Normal | Action |
|---|---|---|---|
| Shared FIFO DLQ | `Shared FIFO DLQ` | 0 | Any non-zero value requires investigation |
| Scheduler DLQ | `Scheduler DLQ` | 0 | Any non-zero value requires investigation |
| Admin Response DLQ | `Admin Response DLQ` | 0 | Only present if AdminApi is deployed |
| Admin Chat DLQ | `Admin Chat DLQ` | 0 | Only present if AdminApi is deployed |
| Admin Dream DLQ | `Admin Dream DLQ` | 0 | Only present if AdminApi is deployed |
| Admin Consolidation DLQ | `Admin Consolidation DLQ` | 0 | Only present if AdminApi is deployed |

DLQ should always be empty. Any messages in the DLQ mean a message has exhausted its retry attempts (3 retries for most queues, 5 for posts).

### Row 3: Admin API (Conditional)

This row only appears when the AdminApi stack is deployed.

| Widget (left) | Widget (right) |
|---|---|
| **Admin API - Invocations** | **Admin API - Errors** |

Tracked functions:

| Function | Label | Purpose |
|---|---|---|
| ChatWorker | `ChatWorker` | Processes admin chat messages |
| ResponseSender | `ResponseSender` | Delivers admin chat responses |
| DreamWorker | `DreamWorker` | Handles dream/consolidation tasks |
| OpenAICompat | `OpenAICompat` | OpenAI-compatible API endpoint |

---

## 2. Alert Interpretation Guide

All 10 configured alarms follow the naming pattern `swarm-{ENVIRONMENT}-shared-*`. They are defined in `packages/infra/src/constructs/shared-handlers.ts`.

All alarms share these settings:
- **Evaluation period:** 5 minutes
- **Datapoints to alarm:** 1 of 1
- **Treat missing data:** NOT_BREACHING
- **Notification:** SNS topic `swarm-alarms-{ENVIRONMENT}`

### Queue Depth Alarms

| Alarm Name | Metric | Threshold | Urgency |
|---|---|---|---|
| `swarm-ENVIRONMENT-shared-messages-queue-depth` | Messages queue visible messages | > 10 | **High** -- Message consumers are failing or throttled |
| `swarm-ENVIRONMENT-shared-responses-queue-depth` | Responses queue visible messages | > 10 | **High** -- Response sender failing (Telegram rate limit? bot blocked?) |
| `swarm-ENVIRONMENT-shared-media-queue-depth` | Media queue visible messages | > 5 | **Medium** -- Media processor stuck (download failure, missing API key) |
| `swarm-ENVIRONMENT-shared-posts-queue-depth` | Posts queue visible messages | > 10 | **Medium** -- Tweet/post sender failing (API error, rate limit) |

### DLQ Alarms

| Alarm Name | Metric | Threshold | Urgency |
|---|---|---|---|
| `swarm-ENVIRONMENT-shared-dlq-depth` | Shared FIFO DLQ visible messages | >= 1 | **Critical** -- Messages failed max retries. Investigate immediately. |
| `swarm-ENVIRONMENT-shared-scheduler-dlq-depth` | Scheduler DLQ visible messages | >= 1 | **Medium** -- Scheduled tasks are failing |

### Lambda Error Alarms

| Alarm Name | Metric | Threshold | Urgency |
|---|---|---|---|
| `swarm-ENVIRONMENT-shared-message-processor-errors` | MessageProcessor Lambda errors | >= 1 | **High** -- AI API timeout, DynamoDB throttle, or code bug |
| `swarm-ENVIRONMENT-shared-response-sender-errors` | ResponseSender Lambda errors | >= 1 | **High** -- Platform API failure (Telegram, Discord) |
| `swarm-ENVIRONMENT-shared-media-processor-errors` | MediaProcessor Lambda errors | >= 1 | **Medium** -- Media download/processing failure |
| `swarm-ENVIRONMENT-shared-tweet-sender-errors` | TweetSender Lambda errors | >= 1 | **Medium** -- Twitter API failure or rate limit |

---

## 3. Response Procedures

### DLQ Alarm (Critical)

**Alarm:** `swarm-ENVIRONMENT-shared-dlq-depth` or `swarm-ENVIRONMENT-shared-scheduler-dlq-depth`

1. **Check DLQ message count:**

   ```bash
   aws sqs get-queue-attributes \
     --region REGION \
     --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
     --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
   ```

2. **Inspect messages (non-destructive peek):**

   ```bash
   aws sqs receive-message \
     --region REGION \
     --queue-url "https://sqs.REGION.amazonaws.com/ACCOUNT_ID/swarm-ENVIRONMENT-dlq.fifo" \
     --max-number-of-messages 5 \
     --visibility-timeout 0 \
     --attribute-names All
   ```

3. **Check the message body** for error details and correlation ID.

4. **Cross-reference** with RUNBOOK.md Section 3 ("SQS DLQ Recovery") for the 5 common DLQ causes and resolution steps.

5. **Decide action:**
   - **Redrive** -- if the cause was transient (e.g., temporary API outage, now resolved).
   - **Purge** -- if the messages are permanently unprocessable (e.g., malformed payload).
   - **Escalate** -- if the root cause is unclear or requires code changes.

### Queue Depth Alarm (High)

**Alarms:** `*-messages-queue-depth`, `*-responses-queue-depth`, `*-media-queue-depth`, `*-posts-queue-depth`

1. **Check the consumer Lambda for errors:**

   ```bash
   aws logs filter-log-events \
     --region REGION \
     --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
     --start-time $(( $(date +%s) - 1800 ))000 \
     --filter-pattern "ERROR" \
     --limit 20
   ```

2. **Check for DynamoDB throttling:**
   CloudWatch > DynamoDB > Table metrics > ThrottledRequests

3. **Check for AI API outage:**
   Visit the OpenRouter status page or check for `circuit_breaker_open` log events:

   ```bash
   aws logs filter-log-events \
     --region REGION \
     --log-group-name "/aws/lambda/swarm-ENVIRONMENT-message-processor" \
     --start-time $(( $(date +%s) - 1800 ))000 \
     --filter-pattern "circuit_breaker" \
     --limit 10
   ```

4. **If transient:** Wait for the backlog to drain naturally. Monitor the queue depth widget for a declining trend.

5. **If persistent:** Check Lambda concurrency limits and consider increasing reserved concurrency:

   ```bash
   aws lambda get-function-concurrency \
     --region REGION \
     --function-name swarm-ENVIRONMENT-message-processor
   ```

### Lambda Error Alarm (High/Medium)

**Alarms:** `*-message-processor-errors`, `*-response-sender-errors`, `*-media-processor-errors`, `*-tweet-sender-errors`

1. **Go to CloudWatch Logs** for the specific function:

   ```bash
   aws logs tail \
     --region REGION \
     "/aws/lambda/swarm-ENVIRONMENT-<function-name>" \
     --follow --since 15m
   ```

2. **Filter for ERROR level log entries:**

   ```bash
   aws logs filter-log-events \
     --region REGION \
     --log-group-name "/aws/lambda/swarm-ENVIRONMENT-<function-name>" \
     --start-time $(( $(date +%s) - 1800 ))000 \
     --filter-pattern "ERROR" \
     --limit 20
   ```

3. **Look for a correlation ID** to trace the full request lifecycle (see Section 6 below).

4. **Common error patterns:**

   | Log Pattern | Meaning | Action |
   |---|---|---|
   | `AI API timeout` | LLM provider slow or down | Transient, usually self-resolves. Check OpenRouter status. |
   | `DynamoDB throttling` | Table capacity exceeded | Check DynamoDB table capacity settings and auto-scaling config. |
   | `Platform API error 429` | Rate limited by Telegram/Twitter | Will retry automatically. If sustained, check sending frequency. |
   | `Platform API error 403` | Bot blocked or token revoked | Check bot token validity. Re-register webhook if needed. See RUNBOOK.md Section 2. |
   | `circuit_breaker_tripped` | LLM provider outage | No action needed; circuit breaker will auto-close when provider recovers. |
   | `ENOMEM` or `Runtime.ExitError` | Lambda out of memory | Increase function memory allocation in CDK. |

---

## 4. Escalation Paths

| Severity | Response Time | Criteria | Action |
|---|---|---|---|
| **P1 Critical** | 15 minutes | DLQ filling, all consumers down, webhook returning 5xx to Telegram | SNS alarm auto-notifies on-call. Begin incident response. Escalate to Platform Lead (`hello@ratimics.com`) if unresolved in 30 min. |
| **P2 High** | 30 minutes | Single consumer failing, queue backing up, one avatar not responding | On-call investigates. Post findings to GitHub issue. Escalate to Platform Lead if architecture decision needed. |
| **P3 Medium** | 2 hours | Intermittent errors, non-critical function (media, tweets), scheduler DLQ | Monitor trend. Investigate during business hours. Track in GitHub issue. |
| **P4 Low** | Next business day | Cosmetic log errors, stale cache, non-impacting warnings | Log for review in next daily ops check. Track in GitHub issue. |

### Escalation Contacts

| Role | How to Reach | Notes |
|---|---|---|
| On-call engineer | SNS topic `swarm-alarms-{ENVIRONMENT}` auto-notifies; check `@cenetex/swarm-ops` GitHub team for current roster | First responder for P1/P2 |
| Platform lead | `hello@ratimics.com` | P1 escalation, architecture decisions, deployment approvals |
| AWS account owner | `hello@ratimics.com` | Infrastructure and billing issues (Staging: `022118847419`, Prod: `332730082708`) |

### Escalation Flow

```
CloudWatch Alarm
  → SNS topic: swarm-alarms-{ENVIRONMENT}
    → Email: hello@ratimics.com (auto-subscribed via CDK)
    → (Optional) Slack / PagerDuty webhook (add via SNS subscription)

P0/P1: On-call engineer responds (15 min) → Platform Lead if unresolved in 30 min
P2:    On-call engineer responds (30 min) → Platform Lead if architecture decision needed
P3:    Investigate during business hours → no escalation unless trending to P2
P4:    Next business day → track in GitHub issue
```

> **Adding notification channels:** Subscribe your Slack or PagerDuty webhook to the `swarm-alarms-{ENVIRONMENT}` SNS topic. The topic ARN follows the pattern `arn:aws:sns:us-east-1:{ACCOUNT_ID}:swarm-alarms-{ENVIRONMENT}`. See [RUNBOOK.md Section 1](./RUNBOOK.md) for `aws sns subscribe` examples.

---

## 5. Correlation ID Tracing

AWS Swarm propagates correlation IDs through the full message processing pipeline:

```
Telegram Webhook --> SQS message attribute --> MessageProcessor --> ResponseSender
```

Each stage logs the correlation ID in structured JSON log entries.

### Tracing a Request End-to-End

1. **Get the correlation ID** from any log entry (it appears in the `correlationId` or `correlation_id` field of structured log output).

2. **Search across all handler log groups** using CloudWatch Logs Insights:

   ```
   fields @timestamp, @message, @logStream
   | filter @message like "CORRELATION_ID_HERE"
   | sort @timestamp asc
   | limit 100
   ```

   Select all relevant log groups:
   - `/aws/lambda/swarm-ENVIRONMENT-telegram-webhook`
   - `/aws/lambda/swarm-ENVIRONMENT-message-processor`
   - `/aws/lambda/swarm-ENVIRONMENT-response-sender`
   - `/aws/lambda/swarm-ENVIRONMENT-media-processor`

3. **Alternatively, use the CLI** to search across functions:

   ```bash
   for fn in telegram-webhook message-processor response-sender media-processor; do
     echo "=== swarm-ENVIRONMENT-$fn ==="
     aws logs filter-log-events \
       --region REGION \
       --log-group-name "/aws/lambda/swarm-ENVIRONMENT-$fn" \
       --start-time $(( $(date +%s) - 86400 ))000 \
       --filter-pattern '"CORRELATION_ID_HERE"' \
       --limit 5
   done
   ```

4. **Interpret the trace.** A healthy request produces log entries in this order:
   1. `request_received` (TelegramWebhook) -- inbound message accepted
   2. `message_enqueued` (TelegramWebhook) -- SQS send success
   3. `processing_started` (MessageProcessor) -- AI pipeline begins
   4. `processing_complete` (MessageProcessor) -- AI response generated
   5. `response_enqueued` (MessageProcessor) -- response sent to response queue
   6. `delivery_started` (ResponseSender) -- platform API call initiated
   7. `delivery_complete` (ResponseSender) -- response delivered

   A gap in this sequence indicates where the failure occurred.

---

## 6. Normal vs Abnormal Patterns

Quick reference for interpreting dashboard state at a glance.

### Normal Operation

- Webhook invocations correlate with chat hours (higher during daytime in the bot's target timezone).
- Queue depths briefly spike to 1-3 during burst conversations, then drain within seconds.
- DLQ widgets show flat zero lines.
- MessageProcessor P99 latency is under 30 seconds.
- Error widgets show occasional isolated spikes (1-2 errors) that do not repeat.

### Abnormal Patterns

| Pattern | Meaning | Investigate |
|---|---|---|
| Queue depth climbing steadily | Consumer Lambda failing or throttled | Check Lambda errors and concurrency |
| DLQ count growing | Messages exhausting retries | See DLQ alarm procedure (Section 3) |
| Webhook invocations drop to zero | Webhook endpoint unreachable | Run `getWebhookInfo` (RUNBOOK.md Section 2) |
| Duration spike + `circuit_breaker_open` logs | LLM provider outage | Wait for auto-recovery; check status page |
| High invocations but no queue activity | Messages being rejected at webhook | Check for validation errors in webhook logs |
| All functions showing errors simultaneously | Shared dependency down (DynamoDB, Secrets Manager) | Check AWS Health Dashboard and service metrics |

---

## 7. Daily Operations Checklist

A quick daily health check routine:

1. **Dashboard scan** -- Open `swarm-ops-ENVIRONMENT`. Visually confirm no error spikes or queue buildup in the last 24 hours.

2. **Alarm state check:**

   ```bash
   aws cloudwatch describe-alarms \
     --region REGION \
     --alarm-name-prefix "swarm-ENVIRONMENT-shared" \
     --state-value ALARM
   ```

   If this returns any results, investigate per Section 3 procedures.

3. **DLQ sweep:**

   ```bash
   for queue_url in $(aws sqs list-queues \
     --region REGION \
     --queue-name-prefix "swarm-" \
     --query 'QueueUrls[?contains(@, `dlq`)]' \
     --output text); do
     depth=$(aws sqs get-queue-attributes \
       --region REGION \
       --queue-url "$queue_url" \
       --attribute-names ApproximateNumberOfMessages \
       --query 'Attributes.ApproximateNumberOfMessages' \
       --output text)
     if [ "$depth" != "0" ]; then
       echo "DLQ: $queue_url -- $depth messages"
     fi
   done
   ```

4. **Webhook health** (for each active avatar):

   ```bash
   TOKEN=$(aws secretsmanager get-secret-value \
     --region REGION \
     --secret-id "swarm/AVATAR_ID/telegram_bot_token/default" \
     --query SecretString --output text)
   curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq '{url: .result.url, pending: .result.pending_update_count, last_error: .result.last_error_message}'
   ```

   Healthy: `pending` is 0, `last_error` is null.

---

## 8. Cross-References

| Topic | Location |
|---|---|
| Incident response procedures | [RUNBOOK.md Section 1](./RUNBOOK.md) |
| Telegram webhook failures | [RUNBOOK.md Section 2](./RUNBOOK.md) |
| SQS DLQ recovery (detailed) | [RUNBOOK.md Section 3](./RUNBOOK.md) |
| Message processing failures | [RUNBOOK.md Section 4](./RUNBOOK.md) |
| AWS CLI command reference | [RUNBOOK.md Section 5](./RUNBOOK.md) |
| CloudWatch dashboard metrics | [RUNBOOK.md Section 6](./RUNBOOK.md) |
| Preventive measures | [RUNBOOK.md Section 7](./RUNBOOK.md) |
| Dashboard CDK source | `packages/infra/src/constructs/ops-dashboard.ts` |
| Alarm CDK source | `packages/infra/src/constructs/shared-handlers.ts` |
| SNS topic CDK source | `packages/infra/src/constructs/shared.ts` |
