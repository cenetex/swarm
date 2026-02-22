# Discord Gateway Architecture and Deployment Guide

This document describes the Discord integration architecture, deployment procedures, configuration options, and troubleshooting for the AWS Swarm platform.

## Table of Contents

- [Current Deployment Status](#current-deployment-status)
- [Architecture](#architecture)
  - [Integration Modes](#integration-modes)
  - [Key Components](#key-components)
  - [Message Flow (Bot Mode)](#message-flow-bot-mode)
  - [Gateway Intents](#gateway-intents)
  - [Multi-Tenant Design](#multi-tenant-design)
  - [Bot Token Resolution](#bot-token-resolution)
- [Deployment Guide](#deployment-guide)
- [Configuration Reference](#configuration-reference)
- [Verification Commands](#verification-commands)
- [Troubleshooting](#troubleshooting)
  - [Troubleshooting Matrix](#troubleshooting-matrix)
  - [Detailed Troubleshooting](#detailed-troubleshooting)
- [Security](#security)
- [Keeping This Document Current](#keeping-this-document-current)

---

## Current Deployment Status

| Environment | `enableDiscordGateway` | Status | Notes |
|-------------|------------------------|--------|-------|
| **prod** | `true` | Enabled | Re-enabled via PR #313 with SQS queue preflight check. Previously disabled due to startup crashes caused by a stale `MESSAGE_QUEUE_URL`. |
| **staging** | not set (defaults to `false`) | Disabled | Not configured in `cdk.context.json`. To enable, add `"enableDiscordGateway": true` to the staging environment config. |

**Source of truth:** `packages/infra/cdk.context.json` under the `environments` key. The flag defaults to `false` in `packages/infra/bin/swarm.ts` (line 112) when not explicitly set.

**CDK guardrail:** When the gateway is disabled, the `AdminApiStack` emits a CDK warning during `cdk synth`/`cdk diff`. Set `DISCORD_GATEWAY_GUARDRAIL_STRICT=true` in CI to promote this to an error and block deployments.

**Runtime guardrail:** The admin API checks the `DISCORD_GATEWAY_ENABLED` environment variable at runtime. When `false`, activation-readiness checks and the Discord service report that bot/hybrid mode is unavailable.

---

## Architecture

### Integration Modes

The Discord integration supports three modes of operation:

| Mode | Direction | Description |
|------|-----------|-------------|
| **Webhook** | Outbound only | Posts messages via Discord webhook URL. Supports custom avatar name and image per message. No inbound message handling. |
| **Bot** | Bidirectional | Full Discord Gateway WebSocket connection. Receives messages, reacts, handles slash commands, and sends replies. |
| **Hybrid** | Both | Uses webhook for outbound messages (custom avatar appearance) and bot for inbound message reception. |

### Key Components

| Component | Path | Responsibility |
|-----------|------|----------------|
| **DiscordAdapter** | `packages/core/src/platforms/discord.ts` | Message parsing, interaction handling, Ed25519 signature verification, action execution |
| **Gateway Utils** | `packages/core/src/platforms/discord-gateway-utils.ts` | Intent validation logging, gateway close code handling, reconnect delay computation |
| **Discord Rate Limiter** | `packages/core/src/platforms/discord-rate-limiter.ts` | Per-channel and global rate limit tracking for Discord REST API calls |
| **Gateway Worker** | `packages/handlers/src/discord/discord-gateway-shared.ts` | Persistent WebSocket to Discord, multi-tenant (groups avatars by bot token), heartbeat management, session resume, exponential backoff reconnect, SQS queue preflight check |
| **Gateway Worker Construct** | `packages/infra/src/constructs/discord-gateway-worker.ts` | ECS Fargate service: 512 CPU / 1024 MiB memory, health check via `pgrep`, circuit breaker with rollback |
| **Dockerfile** | `packages/handlers/Dockerfile.discord-gateway` | Multi-stage build: builds core + mcp-server + handlers, runs `node dist/discord-gateway-shared.js` |
| **Discord Service** | `packages/admin-api/src/services/discord.ts` | REST operations: connection status, send message, list guilds/channels, gateway-enabled checks |
| **Ops Dashboard** | `packages/infra/src/constructs/ops-dashboard.ts` | CloudWatch dashboard widget and drift alarm for gateway task count |

### Message Flow (Bot Mode)

The following describes the end-to-end flow when a user sends a message in Discord and an avatar responds:

```
Discord User
    |
    v
1. User sends message in Discord channel
    |
    v
2. Discord Gateway delivers MESSAGE_CREATE event via WebSocket
    |
    v
3. GatewayConnection routes event to all avatar bindings for that bot token
    |
    v
4. buildDiscordEnvelope() parses the raw event into a SwarmEnvelope
    |
    v
5. Idempotency check: discord:{avatarId}:{messageId}
    |  (skip if already processed)
    v
6. Message evaluator determines if a response is needed
    |  (checks: @mentions, replies to bot, DMs, channel filters)
    v
7. Enqueued to SQS FIFO with MessageGroupId for ordering
    |
    v
8. MessageProcessor Lambda picks up the envelope and runs the agent pipeline
    |
    v
9. ResponseSender delivers the reply via webhook URL or bot API
    |
    v
Discord Channel
```

### Gateway Intents

The gateway connection requests the following privileged and non-privileged intents:

| Intent | Value | Purpose |
|--------|-------|---------|
| `GUILDS` | 1 | Receive guild create/update/delete events, channel management |
| `GUILD_MESSAGES` | 512 | Receive message events in guild channels |
| `DIRECT_MESSAGES` | 4096 | Receive message events in DMs |
| `MESSAGE_CONTENT` | 32768 | Access message text content (privileged intent, must be enabled in Developer Portal) |

**Combined bitmask:** `1 + 512 + 4096 + 32768 = 37377`

### Multi-Tenant Design

The gateway worker is designed to handle multiple avatars efficiently:

- On startup, discovers all Discord-enabled avatars from the DynamoDB state table.
- Groups avatars by bot token. Avatars sharing the same bot token share a single WebSocket connection.
- Refreshes avatar discovery every **60 seconds** to pick up newly created or modified avatars.
- Emits health logs every **5 minutes** with connection status, avatar counts, and uptime.

### Bot Token Resolution

Bot tokens are resolved using a two-step fallback strategy with caching:

1. **JSON secrets blob** (preferred): Reads `{SECRET_PREFIX}/{avatarId}/secrets` from AWS Secrets Manager and extracts the `discord_bot_token` key from the JSON object.
2. **Individual secret** (fallback): Reads `{SECRET_PREFIX}/{avatarId}/discord_bot_token/default` as a plain string value.
3. **Cache**: Avatar configs are cached with a **5-minute** TTL; bot tokens are cached with a **15-minute** TTL. Cache stats are logged on every refresh cycle.

---

## Deployment Guide

### Prerequisites

- AWS account with CDK deployed (shared stack, API stack)
- Discord Developer account
- Avatar already created in the Swarm platform

### Step-by-Step Setup

#### 1. Create Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications).
2. Click **New Application** and give it a name.
3. Note the **Application ID** and **Public Key** from the General Information page.

#### 2. Create Bot User

1. Navigate to the **Bot** section in the left sidebar.
2. Click **Add Bot** (if not already created).
3. Click **Reset Token** to generate a new bot token.
4. Copy the token immediately -- it will not be shown again.

#### 3. Configure Privileged Gateway Intents

In the **Bot** section, scroll down to **Privileged Gateway Intents** and enable:

- **MESSAGE CONTENT INTENT** -- required for reading message text.

Without this intent enabled, the bot will connect successfully but receive empty message content.

#### 4. Generate OAuth2 Invite URL

1. Navigate to **OAuth2 > URL Generator**.
2. Select scopes:
   - `bot`
   - `applications.commands`
3. Select bot permissions:
   - Send Messages
   - Read Messages / View Channels
   - Add Reactions
   - Use Slash Commands
   - Attach Files
4. Copy the generated URL and open it in your browser to invite the bot to your server.

#### 5. Store Bot Token in Secrets Manager

Store the bot token as part of a JSON secrets blob in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name "swarm/{avatarId}/secrets" \
  --secret-string '{"discord_bot_token": "YOUR_BOT_TOKEN_HERE"}'
```

Or update an existing secret:

```bash
aws secretsmanager put-secret-value \
  --secret-id "swarm/{avatarId}/secrets" \
  --secret-string '{"discord_bot_token": "YOUR_BOT_TOKEN_HERE"}'
```

Alternatively, use the Admin UI chat interface:

```
> Set secret discord_bot_token for avatar myagent
```

#### 6. Configure Avatar

Set the following on the avatar's Discord configuration:

- `discord.enabled` = `true`
- `discord.mode` = `'bot'` (or `'hybrid'` if also using webhooks)
- `discord.useGateway` = `true`
- `discord.applicationId` = your application ID (for slash commands)
- `discord.publicKey` = your public key (for interaction verification)

#### 7. Enable the Gateway in CDK Context

Ensure the gateway worker is enabled in the environment config within `packages/infra/cdk.context.json`:

```json
{
  "environments": {
    "prod": {
      "enableDiscordGateway": true
    }
  }
}
```

Or pass it as a CDK context override:

```bash
npx cdk deploy -c enableDiscordGateway=true
```

The flag is read in `packages/infra/bin/swarm.ts` and defaults to `false` when not set.

Deploy via the standard CI/CD pipeline by pushing to `main`, or trigger a manual deployment through GitHub Actions.

#### 8. Verify Deployment

Check CloudWatch logs for the gateway worker. A successful startup shows:

```
[INFO] Gateway connected - received READY event
[INFO] Heartbeat ACK received (latency: XXms)
[INFO] Discovered N avatar(s) across M bot token(s)
```

The worker also performs a **queue preflight check** on startup (`verifyQueueReachable()`), which fails fast with an actionable error if the SQS message queue does not exist or is unreachable.

### Environment Variables

The gateway worker ECS task requires the following environment variables (all set automatically by the CDK construct):

| Variable | Description | Example |
|----------|-------------|---------|
| `STATE_TABLE` | DynamoDB table for avatar discovery | `swarm-state-prod` |
| `MESSAGE_QUEUE_URL` | SQS FIFO queue URL for message delivery | `https://sqs.us-east-1.amazonaws.com/123456789012/swarm-prod-messages.fifo` |
| `ACTIVITY_TABLE` | DynamoDB table for activity logging | `swarm-activity-prod` |
| `SECRET_PREFIX` | Prefix for Secrets Manager keys | `swarm` (default) |
| `ENVIRONMENT` | Deployment environment | `staging` or `prod` |

### Resource Naming Conventions

| Resource | Name Pattern | Example (prod) |
|----------|-------------|----------------|
| ECS Cluster | `swarm-discord-{env}` | `swarm-discord-prod` |
| State Table | `swarm-state-{env}` | `swarm-state-prod` |
| Activity Table | `swarm-activity-{env}` | `swarm-activity-prod` |
| Message Queue | `swarm-{env}-messages.fifo` | `swarm-prod-messages.fifo` |
| Response Queue | `swarm-{env}-responses.fifo` | `swarm-prod-responses.fifo` |
| Log Group | CDK-generated (auto-named) | Check CloudFormation outputs or ECS task definition |
| CloudWatch Alarm | `swarm-discord-gateway-drift-{env}` | `swarm-discord-gateway-drift-prod` |

---

## Configuration Reference

### DiscordConfig Interface

```typescript
interface DiscordConfig {
  /** Whether Discord integration is enabled for this avatar */
  enabled: boolean;

  /** Integration mode */
  mode: 'webhook' | 'bot' | 'hybrid';

  /** Discord webhook URL for outbound messages (webhook and hybrid modes) */
  webhookUrl?: string;

  /** Discord Application ID (required for slash commands) */
  applicationId?: string;

  /** Discord Application Public Key (required for interaction signature verification) */
  publicKey?: string;

  /** Enable WebSocket gateway connection for this avatar */
  useGateway?: boolean;

  /** Gateway intent bitmask (default: 37377 = GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT) */
  intents?: number;

  /** Reply when the bot is @mentioned in a channel */
  respondToMentions?: boolean;

  /** Reply to direct messages */
  respondInDMs?: boolean;

  /** Channel ID whitelist. If set, bot only responds in these channels. Empty = all channels. */
  allowedChannels?: string[];

  /** Guild (server) ID whitelist. If set, bot only operates in these guilds. Empty = all guilds. */
  allowedGuilds?: string[];
}
```

### Configuration Examples

**Bot mode (recommended for most use cases):**

```json
{
  "enabled": true,
  "mode": "bot",
  "useGateway": true,
  "applicationId": "1234567890",
  "publicKey": "abc123...",
  "respondToMentions": true,
  "respondInDMs": true
}
```

**Hybrid mode (custom avatar appearance for outbound):**

```json
{
  "enabled": true,
  "mode": "hybrid",
  "useGateway": true,
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "applicationId": "1234567890",
  "respondToMentions": true,
  "allowedChannels": ["111222333444555666"]
}
```

**Webhook-only mode (outbound posting, no inbound):**

```json
{
  "enabled": true,
  "mode": "webhook",
  "webhookUrl": "https://discord.com/api/webhooks/..."
}
```

---

## Verification Commands

Copy-paste AWS CLI commands for verifying the gateway deployment. Replace `{env}` with `prod` or `staging`.

### ECS Service and Task Status

```bash
# List ECS services in the Discord cluster
aws ecs list-services \
  --cluster swarm-discord-{env} \
  --query 'serviceArns' --output table

# Describe the gateway service (running count, desired count, events)
aws ecs describe-services \
  --cluster swarm-discord-{env} \
  --services "$(aws ecs list-services --cluster swarm-discord-{env} --query 'serviceArns[0]' --output text)" \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount,events:events[:3]}' \
  --output yaml

# List running tasks
aws ecs list-tasks \
  --cluster swarm-discord-{env} \
  --desired-status RUNNING \
  --query 'taskArns' --output table

# Describe a specific task (health status, last status, started at)
aws ecs describe-tasks \
  --cluster swarm-discord-{env} \
  --tasks "$(aws ecs list-tasks --cluster swarm-discord-{env} --desired-status RUNNING --query 'taskArns[0]' --output text)" \
  --query 'tasks[0].{lastStatus:lastStatus,healthStatus:healthStatus,startedAt:startedAt,stoppedReason:stoppedReason}' \
  --output yaml
```

### CloudWatch Logs

The log group name is CDK-generated (not a fixed pattern). Find it from the task definition:

```bash
# Get the log group from the active task definition
TASK_DEF=$(aws ecs describe-services \
  --cluster swarm-discord-{env} \
  --services "$(aws ecs list-services --cluster swarm-discord-{env} --query 'serviceArns[0]' --output text)" \
  --query 'services[0].taskDefinition' --output text)

LOG_GROUP=$(aws ecs describe-task-definition \
  --task-definition "$TASK_DEF" \
  --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' \
  --output text)

echo "Log group: $LOG_GROUP"

# Tail recent logs (last 30 minutes)
aws logs tail "$LOG_GROUP" --since 30m --follow

# Search for errors in the last hour
aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --start-time "$(date -d '1 hour ago' +%s000 2>/dev/null || date -v-1H +%s000)" \
  --filter-pattern "ERROR" \
  --query 'events[].message' --output text
```

### SQS Queue Metrics

```bash
# Check message queue depth and in-flight count
aws sqs get-queue-attributes \
  --queue-url "https://sqs.us-east-1.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/swarm-{env}-messages.fifo" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed \
  --output table

# Check DLQ depth
aws sqs get-queue-attributes \
  --queue-url "https://sqs.us-east-1.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/swarm-{env}-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages \
  --output table
```

### CloudWatch Alarm Status

```bash
# Check Discord gateway drift alarm
aws cloudwatch describe-alarms \
  --alarm-names "swarm-discord-gateway-drift-{env}" \
  --query 'MetricAlarms[0].{state:StateValue,reason:StateReason,updated:StateUpdatedTimestamp}' \
  --output yaml
```

### CloudFormation Export Check

```bash
# Verify the gateway-enabled export
aws cloudformation list-exports \
  --query "Exports[?Name=='swarm-discord-gateway-enabled-{env}'].Value" \
  --output text
```

---

## Troubleshooting

### Troubleshooting Matrix

| Symptom | Likely Cause | Diagnosis Command | Resolution |
|---------|-------------|-------------------|------------|
| No ECS tasks running | Gateway disabled (`enableDiscordGateway=false`) | `aws cloudformation list-exports --query "Exports[?Name=='swarm-discord-gateway-enabled-{env}'].Value"` | Set `enableDiscordGateway: true` in `cdk.context.json` and redeploy |
| Task starts then immediately stops | Startup crash (missing env vars, bad queue URL, import errors) | Tail CloudWatch logs (see [Verification Commands](#cloudwatch-logs)) | Check logs for the specific error. Common: stale `MESSAGE_QUEUE_URL` -- redeploy with CDK to get correct URL |
| Task running but bot offline in Discord | Invalid or expired bot token | Check logs for `4004` close code (Authentication failed) | Rotate token in Secrets Manager; worker picks it up within 15 min (token cache TTL) |
| Bot online but not responding | MESSAGE_CONTENT intent not enabled | Check logs for empty message content warnings | Enable MESSAGE CONTENT INTENT in Discord Developer Portal |
| Bot online but not responding (specific channels) | Channel/guild filter mismatch | Check avatar's `allowedChannels`/`allowedGuilds` config | Update avatar config to include the target channel/guild, or clear filters |
| Messages received but no replies | SQS/Lambda processing failure | Check message queue depth and MessageProcessor Lambda logs | Inspect SQS DLQ for failed messages; check Lambda error logs |
| Duplicate replies | Gateway reconnect replaying events without resume | Check logs for session resume failures | Verify idempotency key format `discord:{avatarId}:{messageId}`; check dedup window |
| Circuit breaker tripped | Repeated task failures (3+ consecutive) | `aws ecs describe-services --cluster swarm-discord-{env} ...` | Fix root cause, then force new deployment: `aws ecs update-service --cluster swarm-discord-{env} --service <svc> --force-new-deployment` |
| Queue preflight failure | SQS queue does not exist or IAM permissions missing | Check logs for `verifyQueueReachable` error | Ensure SharedHandlers stack is deployed; check IAM policy on task role |
| Disallowed intents (close code 4014) | Bot requesting intents not enabled in Developer Portal | Check logs for `4014` close code | Enable required intents in Discord Developer Portal > Bot > Privileged Gateway Intents |

### Detailed Troubleshooting

#### Container Crashes at Startup

**Symptoms:** ECS task starts and immediately exits. Circuit breaker may trigger after repeated failures.

**Diagnosis:**
1. Find the log group (see [CloudWatch Logs](#cloudwatch-logs) commands above).
2. Look for error messages in the first few log lines.
3. Check for `verifyQueueReachable` failures, which indicate the SQS queue URL is stale or the queue does not exist.

**Common causes:**
- Missing environment variables (`STATE_TABLE`, `MESSAGE_QUEUE_URL`, etc.) -- redeploy with CDK
- Stale `MESSAGE_QUEUE_URL` from a previous stack -- redeploy to get the current queue URL from CDK
- Invalid or expired bot token in Secrets Manager
- Insufficient IAM permissions for the task role (DynamoDB, SQS, Secrets Manager access)
- Node.js module resolution errors (check Dockerfile build)

#### Gateway Disabled (Expected Behavior)

**Symptoms:** No ECS tasks running for the Discord cluster. Admin API reports "Discord gateway is not deployed in this environment."

**This is expected when `enableDiscordGateway` is `false` or not set.** The CDK stack emits a `CfnOutput` named `DiscordGatewayEnabled` with value `"false"`.

**To enable:**
1. Add `"enableDiscordGateway": true` to the target environment in `packages/infra/cdk.context.json`
2. Commit and push to `main` to trigger CI/CD deployment
3. Verify with: `aws cloudformation list-exports --query "Exports[?Name=='swarm-discord-gateway-enabled-{env}'].Value"`

#### Bot Not Responding to Messages

**Symptoms:** Bot appears online in Discord but does not respond to messages.

**Diagnosis:**
1. Verify **MESSAGE CONTENT INTENT** is enabled in the Discord Developer Portal.
2. Check `allowedChannels` and `allowedGuilds` filters -- the bot may be filtering out the channel.
3. Confirm the message evaluator criteria: the bot responds to @mentions, replies to its own messages, and DMs (depending on config).
4. Check SQS queue metrics for messages being enqueued (see [SQS Queue Metrics](#sqs-queue-metrics)).
5. Check MessageProcessor Lambda logs for processing errors.

#### Duplicate Messages

**Symptoms:** Bot sends the same response multiple times.

**Diagnosis:**
1. Check the SQS deduplication window (5-minute default for FIFO queues).
2. Verify the idempotency key format: `discord:{avatarId}:{messageId}`.
3. Look for gateway reconnections that may replay events without proper session resume.

#### Gateway Disconnects

**Expected behavior.** The Discord Gateway will periodically disconnect for maintenance or load balancing. The gateway worker handles this automatically:

- Attempts session resume first (replays missed events).
- Falls back to fresh connection if resume fails.
- Uses exponential backoff with jitter: starts at 1 second, caps at **30 seconds**.
- Logs reconnection attempts at INFO level.

No action is required unless disconnects happen continuously (check for invalid token or revoked intents).

#### Permission Errors

**Symptoms:** Bot receives messages but fails to send replies. Errors like "Missing Access" or "Missing Permissions" in logs.

**Resolution:**
1. Ensure the bot role in the Discord server has the required permissions in the target channel.
2. Check channel-level permission overrides that may restrict the bot.
3. Required permissions: Send Messages, Read Messages / View Channels, Add Reactions, Attach Files.

#### Health Check Failures

The ECS health check runs:

```
pgrep -f "node.*discord-gateway"
```

- **Interval:** 30 seconds
- **Start period:** 120 seconds (allows time for initial connection)
- **Retries:** 3

If health checks fail consistently, the ECS service will replace the task. Check CloudWatch logs to determine why the Node.js process exited.

#### Credential and Intents Issues

| Discord Close Code | Meaning | Action |
|--------------------|---------|--------|
| 4004 | Authentication failed | Bot token is invalid or expired. Rotate in Secrets Manager. |
| 4014 | Disallowed intents | Enable required privileged intents in Developer Portal. |
| 4013 | Invalid intents | The intent bitmask includes values Discord does not recognize. Check `intents` config. |
| 4011 | Sharding required | Bot is in too many guilds for a single connection. Sharding is not yet supported. |

---

## Security

### Ed25519 Signature Verification

Discord interaction endpoints (slash commands, button clicks) use Ed25519 signature verification. The `DiscordAdapter` verifies the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers against the application's public key before processing any interaction payload. Invalid signatures are rejected immediately.

### Bot Token Management

- Bot tokens are stored in **AWS Secrets Manager**, never in code, configuration files, or environment variables.
- The gateway worker resolves tokens at runtime from Secrets Manager with a 15-minute cache (token cache) and 5-minute cache (avatar config cache).
- Tokens are never logged. Structured logging records only metadata (avatar ID, guild ID, channel ID, message length).

### Token Rotation

To rotate a bot token:

1. Generate a new token in the Discord Developer Portal.
2. Update the secret in Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "swarm/{avatarId}/secrets" \
     --secret-string '{"discord_bot_token": "NEW_TOKEN_HERE"}'
   ```
3. The gateway worker will pick up the new token within **15 minutes** (token cache TTL).
4. No restart or redeployment is required.

### Rate Limiting

Rate limiting is handled at two levels:

- **Discord Gateway protocol:** The gateway enforces rate limits on identify and heartbeat. The `GatewayConnection` respects these limits automatically.
- **REST API:** Outbound message sending respects Discord's per-channel and global rate limits via `DiscordRateLimiter` (`packages/core/src/platforms/discord-rate-limiter.ts`), with automatic retry-after handling.

### Network Security

- The ECS Fargate task runs in a public subnet with `assignPublicIp: true` for pulling container images and reaching the Discord API.
- No inbound ports are exposed. The WebSocket connection is outbound-initiated to Discord's gateway endpoint.
- All communication with Discord uses TLS (WSS for gateway, HTTPS for REST API).

---

## Keeping This Document Current

This document should be updated whenever:

- The `enableDiscordGateway` flag is changed in `cdk.context.json` for any environment
- The ECS task definition, Dockerfile, or gateway handler entry point changes
- New troubleshooting patterns are discovered during incident response
- Queue naming conventions or resource naming patterns change

The CDK constructs and `cdk.context.json` are the authoritative source for deployment configuration. When in doubt, check:
- `packages/infra/cdk.context.json` -- environment flags
- `packages/infra/bin/swarm.ts` -- how flags are read and defaulted
- `packages/infra/src/constructs/discord-gateway-worker.ts` -- ECS task definition
- `packages/infra/src/stacks/admin-api-stack.ts` -- where the gateway construct is instantiated
