# Canary Alerting System

## Overview

The staging canary monitoring system now sends alerts to **multiple independent channels** to ensure notification redundancy. If one channel (e.g., Telegram) is unavailable, alerts still reach operators through other channels.

This addresses the single point of failure in the previous Telegram-only alerting approach.

## Supported Channels

### 1. Telegram (Original)
- **Status**: Optional but recommended
- **Configuration**: `CANARY_TELEGRAM_BOT_TOKEN`, `CANARY_TELEGRAM_CHAT_ID`
- **Use Case**: Real-time alerts for on-call engineer

### 2. SNS Email (New)
- **Status**: Optional but recommended
- **Configuration**: `CANARY_SNS_TOPIC_ARN` or `CANARY_ALERT_EMAILS`
- **Use Case**: Email digest for non-real-time followup and audit trail
- **Reliability**: Highest — AWS SNS is a core service with 99.99% uptime SLA

### 3. GitHub Issues (New)
- **Status**: Optional
- **Configuration**: `CANARY_GITHUB_TOKEN` (uses `GITHUB_TOKEN` by default)
- **Use Case**: Incident tracking and automated escalation
- **Behavior**: Creates a new issue on consecutive failures; issue can be auto-closed on recovery

## Alert Behavior

### Consecutive Failure Detection

The canary only alerts **on 2+ consecutive failures** to reduce noise (false alarms):

1. **First failure** (Status == `failure`, but previous != `failure`):
   - ✋ Suppressed — no alerts sent
   - Logged as: `"First failure — suppressing alert"`

2. **Consecutive failure** (Status == `failure`, and previous == `failure`):
   - 🚨 Full alert sent to **all configured channels in parallel**
   - Each channel attempt is independent (one channel's failure does not block others)

### Alert Success Criteria

An alert is considered **successful** if **at least one channel** successfully delivers the notification.

- If 1+ channels succeed → exit code `0`
- If all channels fail (or none configured) → exit code `1`

## Configuration

### GitHub Actions Secrets

Add the following secrets to your GitHub repository or organization:

| Secret | Type | Example | Required |
|--------|------|---------|----------|
| `CANARY_TELEGRAM_BOT_TOKEN` | String | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` | No |
| `CANARY_TELEGRAM_CHAT_ID` | String | `123456789` or `-1001234567890` (group) | No (if using Telegram) |
| `CANARY_SNS_TOPIC_ARN` | String | `arn:aws:sns:us-east-1:123456789:swarm-alerts` | No |
| `CANARY_ALERT_EMAILS` | String | `on-call@example.com,ops@example.com` | No (if using SNS email) |
| `CANARY_GITHUB_TOKEN` | String | (auto-provided by GitHub Actions) | No (GitHub Issues only) |

### Minimum Setup

To satisfy the acceptance criteria (at least 2 channels), configure **at least 2** of:
- Telegram (`CANARY_TELEGRAM_BOT_TOKEN` + `CANARY_TELEGRAM_CHAT_ID`)
- SNS (`CANARY_SNS_TOPIC_ARN` or `CANARY_ALERT_EMAILS`)
- GitHub Issues (automatic via `CANARY_GITHUB_TOKEN`)

### SNS Topic Setup (Optional)

If using SNS email delivery:

```bash
# Create an SNS topic (if not already existing)
aws sns create-topic \
  --name swarm-canary-alerts \
  --region us-east-1

# Subscribe email addresses
aws sns subscribe \
  --topic-arn "arn:aws:sns:us-east-1:123456789:swarm-canary-alerts" \
  --protocol email \
  --notification-endpoint "on-call@example.com"

# Confirm subscription (check email for confirmation link)
```

Store the topic ARN in `CANARY_SNS_TOPIC_ARN` secret.

## Workflow Implementation

The canary workflow is in `.github/workflows/telegram-canary.yml`:

```yaml
- name: Check for consecutive failures
  if: failure()
  id: check-consecutive
  run: |
    # Determine if this is 2+ consecutive failures
    # Output: is_consecutive=true|false

- name: Send canary alerts (Telegram, SNS, GitHub Issues)
  if: failure() && steps.check-consecutive.outputs.is_consecutive == 'true'
  run: bun run scripts/send-canary-alerts.ts ...
  env:
    CANARY_TELEGRAM_BOT_TOKEN: ...
    CANARY_SNS_TOPIC_ARN: ...
    # etc.
```

## Alert Script

**Location**: `scripts/send-canary-alerts.ts`

**Invocation**:
```bash
bun run scripts/send-canary-alerts.ts \
  --health-outcome success|failure \
  --chat-outcome success|failure \
  --is-consecutive-failure true|false
```

**Output**:
- Sends alerts to all configured channels in parallel
- Reports success/failure for each channel to `stderr`
- Exits with `0` if at least one channel succeeded; `1` otherwise

**Environment Variables** (all optional):
- `CANARY_TELEGRAM_BOT_TOKEN`
- `CANARY_TELEGRAM_CHAT_ID`
- `CANARY_SNS_TOPIC_ARN`
- `CANARY_ALERT_EMAILS`
- `CANARY_GITHUB_TOKEN`
- `GITHUB_RUN_ID` (from GitHub Actions)
- `GITHUB_RUN_NUMBER` (from GitHub Actions)
- `GITHUB_REPOSITORY` (from GitHub Actions)
- `GITHUB_SERVER_URL` (from GitHub Actions)

## Testing Alerts

### Test Telegram Alert
```bash
CANARY_TELEGRAM_BOT_TOKEN=xxx \
CANARY_TELEGRAM_CHAT_ID=yyy \
bun run scripts/send-canary-alerts.ts \
  --health-outcome failure \
  --chat-outcome failure \
  --is-consecutive-failure true
```

### Test SNS Alert
```bash
CANARY_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:123456789:topic" \
GITHUB_RUN_ID=12345 \
GITHUB_RUN_NUMBER=123 \
GITHUB_REPOSITORY="owner/repo" \
GITHUB_SERVER_URL="https://github.com" \
bun run scripts/send-canary-alerts.ts \
  --health-outcome failure \
  --chat-outcome failure \
  --is-consecutive-failure true
```

### Test First Failure Suppression
```bash
bun run scripts/send-canary-alerts.ts \
  --health-outcome failure \
  --chat-outcome success \
  --is-consecutive-failure false
# Should exit 0 and suppress alerts
```

## Alert Content Examples

### Telegram Alert
```
*Staging Canary FAILED* (2+ consecutive)

Run: [#123](https://github.com/owner/repo/actions/runs/12345)
Health: ❌ `failure`
Chat: ✅ `success`
```

### Email Alert (SNS)
```
Subject: 🚨 Staging Canary FAILED (Consecutive Failure)

Status Update:
  Health Check: ❌ FAILURE
  Chat Completions: ✅ SUCCESS

Workflow Details:
  Run: #123
  Repository: owner/repo
  URL: https://github.com/owner/repo/actions/runs/12345
```

### GitHub Issue
```
Title: 🚨 Canary Alert: Consecutive Staging Failures

Body:
## Canary Failure Detected

**Status:**
- Health Check: ❌ FAILURE
- Chat Completions: ✅ SUCCESS

**Workflow:**
- Run: #123
- Logs: [View Run](...)

Labels: status:incident, priority:p1, type:ops
```

## Monitoring Dashboard

Track canary alert effectiveness:

1. **Telegram**: Check the pinned message in your canary alert chat
2. **Email**: Search inbox for `[Canary Alert]` tag
3. **GitHub**Issues**: Query: `is:issue label:status:incident created:today`

## Incident Response

When you receive a canary alert:

1. **Immediate (< 5 min)**: Acknowledge receipt in all channels (react emoji on Telegram, reply on GitHub, etc.)
2. **Triage (< 15 min)**: Determine whether issue is environment-specific or widespread
3. **Investigation (< 30 min)**: Check relevant CloudWatch logs (see [docs/RUNBOOK.md](./RUNBOOK.md))
4. **Resolution**: Fix root cause or rollback deployment
5. **Verification**: Re-run canary manually to confirm recovery
6. **Closeout**: Close GitHub issue; update status in postmortem (if applicable)

## Future Extensions

Possible future channels:
- **PagerDuty**: For scheduled on-call escalation
- **Slack** / **Discord**: For team chat integrations
- **Datadog** / **New Relic**: For APM-integrated incident tracking
- **Custom Webhooks**: For internal ticketing systems

To add a new channel:
1. Create a new `async function alert<ChannelName>(options)` in `send-canary-alerts.ts`
2. Add corresponding environment variable checks
3. Return an `AlertResult` object
4. Add to the `Promise.all()` array in `main()`
5. Update GitHub Actions workflow with new secrets (if needed)
6. Document in this file

## Troubleshooting

### "Telegram not configured (missing token or chat ID)"
- **Fix**: Add `CANARY_TELEGRAM_BOT_TOKEN` and `CANARY_TELEGRAM_CHAT_ID` secrets to GitHub
- **Verify**: `gh secret list | grep CANARY`

### "SNS request failed: ... UnauthorizedOperation"
- **Fix**: Ensure GitHub Actions role has `sns:Publish` permission
- **Verify**: Check IAM role policy in CloudFormation

### "GitHub API error: 401 Unauthorized"
- **Fix**: Regenerate GitHub token (ensure `repo:write` scope)
- **Verify**: Token works: `curl -H "Authorization: token $TOKEN" https://api.github.com/user`

### Only one channel succeeds; others fail
- **Expected**: Script requires at least one success. Multiple channels provide **redundancy**, not **consensus**.
- **Status**: Alert still sent successfully. Investigate failed channels separately.

### All channels fail
- **Status**: Zero alerts sent; script exits with code `1`
- **Remedy**: Check all channel configurations; re-run canary manually to debug
