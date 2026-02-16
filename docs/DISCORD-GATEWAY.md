# Discord Gateway Architecture and Deployment Guide

This document describes the Discord integration architecture, deployment procedures, configuration options, and troubleshooting for the AWS Swarm platform.

## Table of Contents

- [Architecture](#architecture)
  - [Integration Modes](#integration-modes)
  - [Key Components](#key-components)
  - [Message Flow (Bot Mode)](#message-flow-bot-mode)
  - [Gateway Intents](#gateway-intents)
  - [Multi-Tenant Design](#multi-tenant-design)
  - [Bot Token Resolution](#bot-token-resolution)
- [Deployment Guide](#deployment-guide)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

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
| **GatewayConnection** | `packages/handlers/src/discord-gateway-shared.ts` | Persistent WebSocket to Discord, multi-tenant (groups avatars by bot token), heartbeat management, session resume, exponential backoff reconnect |
| **Discord Gateway Worker** | `packages/infra/src/constructs/discord-gateway-worker.ts` | ECS Fargate service: 512 CPU / 1024 MiB memory, health check via `pgrep`, circuit breaker with rollback |
| **Discord Service** | `packages/admin-api/src/services/discord.ts` | REST operations: connection status, send message, list guilds/channels |

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

1. **JSON secrets blob** (preferred): Reads `swarm/{avatarId}/secrets` from AWS Secrets Manager and extracts the `discord_bot_token` key from the JSON object.
2. **Individual secret** (fallback): Reads `swarm/{avatarId}/discord_bot_token/default` as a plain string value.
3. **Cache**: Resolved tokens are cached for **5 minutes** to reduce Secrets Manager API calls.

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

#### 7. Deploy with CDK

Ensure the gateway worker is enabled in the stack configuration:

```typescript
// In packages/infra/src/bin/swarm.ts or equivalent
{
  enableDiscordGateway: true
}
```

Deploy via the standard CI/CD pipeline by pushing to `main`, or trigger a manual deployment through GitHub Actions.

#### 8. Verify Deployment

Check CloudWatch logs for the gateway worker. A successful connection shows:

```
[INFO] Gateway connected - received READY event
[INFO] Heartbeat ACK received (latency: XXms)
[INFO] Discovered N avatar(s) across M bot token(s)
```

### Environment Variables

The gateway worker ECS task requires the following environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `STATE_TABLE` | DynamoDB table for avatar discovery | `swarm-state-staging` |
| `MESSAGE_QUEUE_URL` | SQS FIFO queue URL for message delivery | `https://sqs.us-east-1.amazonaws.com/123456789012/swarm-messages-staging.fifo` |
| `ACTIVITY_TABLE` | DynamoDB table for activity logging | `swarm-activity-staging` |
| `SECRET_PREFIX` | Prefix for Secrets Manager keys | `swarm` (default) |
| `ENVIRONMENT` | Deployment environment | `staging` or `production` |

These are automatically configured by the CDK construct when `enableDiscordGateway` is set to `true`.

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

## Troubleshooting

### Container Crashes at Startup

**Symptoms:** ECS task starts and immediately exits. Circuit breaker may trigger after repeated failures.

**Diagnosis:**
1. Check CloudWatch logs for the gateway worker log group (`/ecs/swarm-discord-gateway-{env}`).
2. Look for error messages in the first few log lines.

**Common causes:**
- Missing environment variables (`STATE_TABLE`, `MESSAGE_QUEUE_URL`, etc.)
- Invalid or expired bot token in Secrets Manager
- Insufficient IAM permissions for the task role (DynamoDB, SQS, Secrets Manager access)

### Bot Not Responding to Messages

**Symptoms:** Bot appears online in Discord but does not respond to messages.

**Diagnosis:**
1. Verify **MESSAGE CONTENT INTENT** is enabled in the Discord Developer Portal.
2. Check `allowedChannels` and `allowedGuilds` filters -- the bot may be filtering out the channel.
3. Confirm the message evaluator criteria: the bot responds to @mentions, replies to its own messages, and DMs (depending on config).
4. Check SQS queue metrics for messages being enqueued.
5. Check MessageProcessor Lambda logs for processing errors.

### Duplicate Messages

**Symptoms:** Bot sends the same response multiple times.

**Diagnosis:**
1. Check the SQS deduplication window (5-minute default for FIFO queues).
2. Verify the idempotency key format: `discord:{avatarId}:{messageId}`.
3. Look for gateway reconnections that may replay events without proper session resume.

### Gateway Disconnects

**Expected behavior.** The Discord Gateway will periodically disconnect for maintenance or load balancing. The gateway worker handles this automatically:

- Attempts session resume first (replays missed events).
- Falls back to fresh connection if resume fails.
- Uses exponential backoff with jitter: starts at 1 second, caps at **30 seconds**.
- Logs reconnection attempts at INFO level.

No action is required unless disconnects happen continuously (check for invalid token or revoked intents).

### Permission Errors

**Symptoms:** Bot receives messages but fails to send replies. Errors like "Missing Access" or "Missing Permissions" in logs.

**Resolution:**
1. Ensure the bot role in the Discord server has the required permissions in the target channel.
2. Check channel-level permission overrides that may restrict the bot.
3. Required permissions: Send Messages, Read Messages / View Channels, Add Reactions, Attach Files.

### Health Check Failures

The ECS health check runs:

```
pgrep -f "node.*discord-gateway"
```

- **Interval:** 30 seconds
- **Start period:** 120 seconds (allows time for initial connection)
- **Retries:** 3

If health checks fail consistently, the ECS service will replace the task. Check CloudWatch logs to determine why the Node.js process exited.

### Production Status

Discord Gateway is currently **disabled in production** (`enableDiscordGateway: false`) due to container startup crashes that require runtime debugging with CloudWatch. The gateway is **active in staging** and can be tested there.

---

## Security

### Ed25519 Signature Verification

Discord interaction endpoints (slash commands, button clicks) use Ed25519 signature verification. The `DiscordAdapter` verifies the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers against the application's public key before processing any interaction payload. Invalid signatures are rejected immediately.

### Bot Token Management

- Bot tokens are stored in **AWS Secrets Manager**, never in code, configuration files, or environment variables.
- The gateway worker resolves tokens at runtime from Secrets Manager with a 5-minute cache.
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
3. The gateway worker will pick up the new token within **5 minutes** (cache TTL).
4. No restart or redeployment is required.

### Rate Limiting

Rate limiting is handled at two levels:

- **Discord Gateway protocol:** The gateway enforces rate limits on identify and heartbeat. The `GatewayConnection` respects these limits automatically.
- **REST API:** Outbound message sending respects Discord's per-channel and global rate limits, with automatic retry-after handling.

### Network Security

- The ECS Fargate task runs in a private subnet with outbound-only internet access (via NAT Gateway).
- No inbound ports are exposed. The WebSocket connection is outbound-initiated to Discord's gateway endpoint.
- All communication with Discord uses TLS (WSS for gateway, HTTPS for REST API).
