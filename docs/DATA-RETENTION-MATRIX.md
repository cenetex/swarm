# Data Retention & Deletion Control Matrix

> **Owner**: Platform Engineering
> **Last reviewed**: 2026-02-23
> **Status**: Active
> **Related**: [SECURITY.md](./SECURITY.md) | [SECURE-LOGGING.md](./SECURE-LOGGING.md) | [RUNBOOK.md](./RUNBOOK.md)

This document defines the enforceable data retention and deletion policy for
all platform data stores. Every data class has a declared retention target,
a current implementation status, and an owner responsible for compliance.

---

## 1. Data Classification

| Class | Sensitivity | Description |
|-------|------------|-------------|
| **Operational State** | Internal | Channel state, cooldowns, idempotency keys, presence |
| **Chat History** | Confidential | User messages processed through the message pipeline |
| **Memory (AI)** | Confidential | Avatar memories (ephemeral, durable, archival tiers) |
| **Audit Events** | Compliance | Admin actions, entitlement changes, secret rotations |
| **Application Logs** | Internal | Lambda/ECS structured logs in CloudWatch |
| **Access Logs** | Compliance | API Gateway access logs |
| **Media Assets** | Internal | Generated images, avatars, temp media files |
| **Secrets** | Restricted | API keys, tokens stored in Secrets Manager |
| **Queue Messages** | Transient | SQS messages in transit (processing queues, DLQs) |
| **Content Store** | Internal | Drafted/posted/rejected social media content |
| **CDN Access Logs** | Internal | CloudFront request logs |
| **Activity Records** | Internal | Avatar activity tracking events |
| **Facts** | Confidential | Extracted user/conversation facts |
| **User Cooldowns** | Internal | Per-user cooldown tracking records |

---

## 2. Retention Matrix

### 2.1 DynamoDB Tables

| Data Store | Table | TTL Attribute | Current Retention | Policy Target | Status | Owner |
|-----------|-------|---------------|-------------------|---------------|--------|-------|
| Channel State | `swarm-state-{env}` | `ttl` | 90 days | 90 days | Compliant | Core |
| Activity Records | `swarm-activity-{env}` | `ttl` | 24 hours | 24 hours | Compliant | Core |
| Idempotency Keys | `swarm-state-{env}` | `ttl` | 1 hour (default) | 1 hour | Compliant | Core |
| Tweet Reply Tracking | `swarm-state-{env}` | `ttl` | 7 days | 7 days | Compliant | Core |
| User Cooldowns | `swarm-state-{env}` | `ttl` | 1 day after expiry | 1 day after expiry | Compliant | Core |
| Presence/Channel State | `swarm-state-{env}` | `ttl` | 2 hours | 2 hours | Compliant | Core |
| Audit Events | `SwarmAdmin-{env}` | `ttl` | 90 days | 1 year | **Needs Change** | Admin API |
| Admin Chat Sessions | `SwarmAdmin-{env}` | `ttl` | Per-item (varies) | 30 days | Compliant | Admin API |
| Content Store (posted) | `swarm-state-{env}` | `ttl` | 90 days | 90 days | Compliant | Core |
| Content Store (rejected) | `swarm-state-{env}` | `ttl` | 7 days | 7 days | Compliant | Core |
| Content Store (pending) | `swarm-state-{env}` | `ttl` | 30 days | 30 days | Compliant | Core |
| Facts | `swarm-state-{env}` | `ttl` | 90 days | 90 days | Compliant | Core |

### 2.2 AI Memory Tiers

| Tier | Table | Current Retention | Policy Target | Status | Owner |
|------|-------|-------------------|---------------|--------|-------|
| Ephemeral | `swarm-state-{env}` | 1 day | 1 day | Compliant | Core/Brain |
| Durable | `swarm-state-{env}` | 90 days | 90 days | Compliant | Core/Brain |
| Archival | `swarm-state-{env}` | Unlimited (no TTL) | Unlimited | Compliant | Core/Brain |
| Canonical Memory | `swarm-state-{env}` | 30 days (default) | 30 days | Compliant | Core/Brain |

### 2.3 CloudWatch Log Groups

| Log Group | Construct | Prod Retention | Staging Retention | Policy Target (Prod) | Status | Owner |
|-----------|-----------|---------------|-------------------|---------------------|--------|-------|
| Message Processor | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Telegram Webhook | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Response Sender | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Media Processor | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Twitter Mention Poller | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Autonomous Tweet Poster | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Platform Heartbeat | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Tweet Sender | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| DLQ Processor | SharedHandlers | 30 days | 3 days | 30 days | Compliant | Handlers |
| Admin API Lambdas | AdminApi | 14 days | 3 days | 14 days | Compliant | Admin API |
| API Gateway Access Logs | AdminApi | 30 days | 7 days | 30 days | Compliant | Admin API |
| Discord Gateway | DiscordGateway | 14 days | 3 days | 14 days | Compliant | Handlers |
| Claude Code Worker | ClaudeCodeWorker | 14 days | 3 days | 14 days | Compliant | Claude Code |
| Claude Code Dispatcher | AdminApi | 14 days | 3 days | 14 days | Compliant | Admin API |

### 2.4 SQS Queues

| Queue | Construct | Retention | Policy Target | Status | Owner |
|-------|-----------|-----------|---------------|--------|-------|
| Message Queue (FIFO) | SharedHandlers | Default (4 days) | 4 days | Compliant | Handlers |
| Response Queue (FIFO) | SharedHandlers | Default (4 days) | 4 days | Compliant | Handlers |
| Media Queue (FIFO) | SharedHandlers | Default (4 days) | 4 days | Compliant | Handlers |
| Post Queue (FIFO) | SharedHandlers | Default (4 days) | 4 days | Compliant | Handlers |
| Shared DLQ (FIFO) | SharedHandlers | 14 days | 14 days | Compliant | Handlers |
| Scheduler DLQ | SharedHandlers | 14 days | 14 days | Compliant | Handlers |
| Admin Response Queue | AdminApi | 1 day | 1 day | Compliant | Admin API |
| Admin Response DLQ | AdminApi | 14 days | 14 days | Compliant | Admin API |
| Admin Chat Queue | AdminApi | 1 day | 1 day | Compliant | Admin API |
| Admin Chat DLQ | AdminApi | 14 days | 14 days | Compliant | Admin API |
| Dream Queue (FIFO) | AdminApi | 1 day | 1 day | Compliant | Admin API |
| Dream DLQ (FIFO) | AdminApi | 14 days | 14 days | Compliant | Admin API |
| Consolidation DLQ | AdminApi | 14 days | 14 days | Compliant | Admin API |
| Claude Code Queue (FIFO) | ClaudeCodeWorker | 1 day | 1 day | Compliant | Claude Code |
| Claude Code DLQ (FIFO) | ClaudeCodeWorker | 7 days | 7 days | Compliant | Claude Code |

### 2.5 S3 Buckets

| Bucket | Construct | Lifecycle Rules | Policy Target | Status | Owner |
|--------|-----------|----------------|---------------|--------|-------|
| Media Bucket (`swarm-media-*`) | Shared | `temp/` prefix: 1 day expiry; general: 30-day transition to Intelligent Tiering | Match current | Compliant | Shared |
| CDN Log Bucket (`swarm-cdn-logs-*`) | Shared | 90-day expiry | 90 days | Compliant | Shared |
| SQS Offload (same media bucket) | Core | 24-hour `Expires` header on objects | 24 hours | Compliant | Core |
| Admin UI Bucket | AdminUI | None (static assets) | No expiry (static hosting) | Compliant | Admin UI |
| Profile Page Bucket | ProfilePage | None (static assets) | No expiry (static hosting) | Compliant | Profile Page |

### 2.6 Secrets Manager

| Secret Pattern | Retention | Policy Target | Status | Owner |
|---------------|-----------|---------------|--------|-------|
| `{prefix}/admin/llm-api-key` | Indefinite (manual rotation) | Rotate every 90 days | **No Control** | Admin API |
| `{prefix}/{avatarId}/secrets` | Indefinite (user-managed) | User-managed, delete on avatar deletion | Compliant | Handlers |
| `{prefix}/admin/replicate-api-key` | Indefinite (manual rotation) | Rotate every 90 days | **No Control** | Admin API |

---

## 3. Compliance Summary

| Status | Count | Action Required |
|--------|-------|----------------|
| Compliant | 44 | None |
| **Needs Change** | 1 | Audit events TTL should be extended to 1 year |
| **No Control** | 2 | Add rotation reminders for Secrets Manager keys |

### 3.1 Required Remediation

#### R1: Extend Audit Event Retention to 1 Year

**Current**: 90-day TTL in `packages/admin-api/src/services/audit-log.ts`
**Target**: 365-day TTL
**Rationale**: Audit events are compliance-critical and should survive longer than operational data. 90 days is insufficient for annual compliance reviews.
**Tracked**: Issue to be filed separately.

#### R2: Secret Rotation Policy

**Current**: No automated rotation schedule for admin API keys
**Target**: 90-day rotation reminders via CloudWatch Events or Secrets Manager rotation
**Rationale**: Long-lived secrets increase blast radius if compromised.
**Tracked**: Issue to be filed separately.

---

## 4. Retention Policy Validation

Automated tests in `packages/infra/src/retention-policy.test.ts` validate that:

1. All CloudWatch log groups have explicit retention periods set
2. Production log retention matches policy baselines (ONE_MONTH for handler logs, TWO_WEEKS for admin/discord/claude-code logs)
3. Staging log retention is THREE_DAYS (cost optimization)
4. DLQ retention is 14 days (forensic investigation window)
5. Processing queue retention does not exceed 4 days
6. DynamoDB tables have TTL attributes enabled

Run validation:

```bash
bun test packages/infra/src/retention-policy.test.ts
```

---

## 5. Deletion Request Runbook

### 5.1 User Data Deletion Request

When a user requests deletion of their data (GDPR Article 17 or similar):

#### Step 1: Identify User Data

```bash
# Find all items for a user across DynamoDB tables
# User data is keyed by wallet address or platform user ID

# State table - channel states where user is engaged
aws dynamodb query \
  --table-name swarm-state-{env} \
  --index-name GSI1 \
  --key-condition-expression "gsi1pk = :pk" \
  --expression-attribute-values '{":pk": {"S": "USER#{userId}"}}'

# Admin table - check for inhabitant records
aws dynamodb query \
  --table-name SwarmAdmin-{env} \
  --index-name GSI1 \
  --key-condition-expression "sk = :sk" \
  --expression-attribute-values '{":sk": {"S": "INHABITANT#{walletAddress}"}}'
```

#### Step 2: Delete User Records

```bash
# Delete user-specific items from state table
# Note: channel state items with the user in engagedUsers will auto-expire via TTL

# Delete inhabitant mapping
aws dynamodb delete-item \
  --table-name SwarmAdmin-{env} \
  --key '{"pk": {"S": "AVATAR#{avatarId}"}, "sk": {"S": "INHABITANT#{walletAddress}"}}'

# Delete user's audit events (if user-initiated actions are logged)
# These will auto-expire via TTL, but can be force-deleted for immediate compliance
```

#### Step 3: Purge Logs (if required)

CloudWatch logs containing user message metadata auto-expire per the retention
policy. For immediate deletion:

```bash
# Delete specific log streams containing user data
# WARNING: This is destructive and removes all events in the stream
aws logs delete-log-stream \
  --log-group-name "/aws/lambda/swarm-{env}-message-processor" \
  --log-stream-name "{specific-stream}"
```

> **Note**: Structured logging in this project does NOT log message content
> (only metadata like chat ID, message length). See [SECURE-LOGGING.md](./SECURE-LOGGING.md).

#### Step 4: Confirm Deletion

1. Re-run the queries from Step 1 to confirm no items remain
2. Record the deletion action in the audit log (meta-audit)
3. Notify the requesting user within the required timeframe (30 days for GDPR)

### 5.2 Avatar Deletion

When an avatar is deleted, the following data must be cleaned up:

| Data | Location | Cleanup Method |
|------|----------|---------------|
| Avatar config | `SwarmAdmin-{env}` | Delete `AVATAR#{id}` partition |
| Avatar secrets | Secrets Manager | Delete `{prefix}/{avatarId}/secrets` |
| Avatar memories | `swarm-state-{env}` | Delete `MEMORY#{avatarId}` items (or wait for TTL) |
| Avatar channel states | `swarm-state-{env}` | Wait for TTL (90 days) |
| Avatar media | S3 `swarm-media-*` | Delete `avatars/{avatarId}/` prefix |
| Avatar content store items | `swarm-state-{env}` | Wait for TTL |
| Avatar audit events | `SwarmAdmin-{env}` | Wait for TTL (compliance retention) |

### 5.3 Retention Exception Requests

To request an exception to the standard retention policy:

1. Open a GitHub issue with label `type:security`
2. Include: data class, current retention, requested retention, justification
3. Security review required before approval
4. Approved exceptions are tracked in the [security exception registry](../.github/workflows/security-exceptions.yml)
5. Exceptions must have an expiry date and are reviewed weekly

---

## 6. Change Control

Any change to retention settings must:

1. Update this matrix document
2. Update the corresponding CDK construct or application code
3. Pass the automated retention policy tests
4. Be reviewed by the platform engineering team
5. Follow the standard PR workflow (conventional commit, CI pass)
