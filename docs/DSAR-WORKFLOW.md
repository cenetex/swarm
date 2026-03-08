# DSAR (Data Subject Access Request) Workflow

> **Owner**: Platform Engineering
> **Last reviewed**: 2026-03-08
> **Status**: Active
> **Related**: [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) | [SECURITY.md](./SECURITY.md)

This document describes the automated DSAR workflow for data discovery, export,
and erasure. It covers GDPR Article 15 (right of access) and Article 17 (right
to erasure / "right to be forgotten").

---

## 1. Data Classes Covered

| Data Class | Storage | Key Schema | Deletable | Retention |
|-----------|---------|-----------|-----------|-----------|
| Chat History | `SwarmAdmin-{env}` | `CHAT#{email}` / `AVATAR#{id}` or `GLOBAL` | Yes | 24h TTL |
| Audit Events | `SwarmAdmin-{env}` | `AUDIT#{avatarId}` / `EVENT#{ts}#{id}` | No (retention exception) | 90 days TTL |
| Identity Links | `SwarmAdmin-{env}` | `USER#{userId}` / `IDENTITY_LINK#{platform}#{platformUserId}` | Yes | Until revoked |
| Avatar Memories | `SwarmAdmin-{env}` | `MEMORY#{avatarId}` / `{tier}#{ts}#{id}` (filtered by userId) | Yes | 30 days TTL |
| Auto-Issues | `SwarmAdmin-{env}` | `ISSUE#{issueId}` / `META` (filtered by avatarId) | Yes | 30 days TTL |

---

## 2. Retention Exceptions

| Data Class | Exception Basis | Justification |
|-----------|----------------|---------------|
| Audit Events | Legitimate interest / legal obligation | Audit events contain only metadata (event type, actor ID, timestamp) and no message content. They are required for compliance reviews and security investigations. Retained for 90 days with TTL auto-expiry. |
| Erasure Audit Trail | Legal obligation | The erasure request itself is recorded as an audit event to demonstrate compliance. This is required by GDPR Article 5(2) accountability principle. |

---

## 3. API Endpoints

All endpoints require an authenticated session. Users can only access their own data.

### 3.1 Data Inventory

```
GET /dsar/inventory
```

Returns an inventory of all data classes with approximate record counts.

**Response:**
```json
{
  "userId": "wallet-abc123",
  "generatedAt": "2026-03-08T12:00:00Z",
  "dataClasses": [
    {
      "dataClass": "chatHistory",
      "description": "Chat conversation history with admin chatbot",
      "approximateCount": 3,
      "retentionPolicy": "24 hours (TTL)"
    }
  ],
  "totalRecords": 12
}
```

### 3.2 Data Export

```
POST /dsar/export
```

Exports all personal data in structured JSON format.

**Response:**
```json
{
  "exportedAt": "2026-03-08T12:00:00Z",
  "userId": "wallet-abc123",
  "dataClasses": {
    "chatHistory": [
      [{"role": "user", "content": "hello"}]
    ],
    "auditLog": [],
    "identityLinks": [],
    "memories": [],
    "issues": []
  },
  "retentionExceptions": [
    {
      "dataClass": "auditLog",
      "reason": "Audit events are retained for compliance purposes..."
    }
  ]
}
```

### 3.3 Data Erasure

```
POST /dsar/erase
Content-Type: application/json

{
  "confirm": true,
  "dryRun": false
}
```

Deletes all erasable personal data. Requires `confirm: true` in the request body.

**Dry-run mode:** Set `dryRun: true` to preview what would be deleted without
actually performing deletions.

**Response:**
```json
{
  "userId": "wallet-abc123",
  "erasedAt": "2026-03-08T12:00:00Z",
  "dryRun": false,
  "deleted": [
    { "dataClass": "chatHistory", "count": 3 },
    { "dataClass": "identityLinks", "count": 1 },
    { "dataClass": "memories", "count": 5 },
    { "dataClass": "issues", "count": 2 }
  ],
  "retained": [
    {
      "dataClass": "auditLog",
      "count": 8,
      "reason": "Retained for compliance..."
    }
  ],
  "totalDeleted": 11,
  "totalRetained": 8
}
```

---

## 4. Audit Trail

Every DSAR operation is logged:

1. **Inventory requests** are logged via structured logging (`dsar_inventory` event)
2. **Export requests** are logged via structured logging (`dsar_export` event)
3. **Erasure requests** are:
   - Logged via structured logging (`dsar_erase` event)
   - Recorded as a permanent audit event (`avatar_deleted` with `dsar_erasure` action detail)
   - The audit event captures what was deleted vs retained

---

## 5. Architecture

```
User Request
    |
    v
API Gateway (/dsar/*)
    |
    v
DSAR Lambda Handler
    |
    +-- authenticateRequest() -- validate session
    |
    +-- DSAR Service
         |
         +-- discoverUserData() -- inventory
         +-- exportUserData()   -- full export
         +-- eraseUserData()    -- delete + audit
              |
              +-- QueryCommand (CHAT#, USER#, MEMORY#, ISSUE#, AUDIT#)
              +-- DeleteCommand (for deletable data)
              +-- PutCommand (audit trail of erasure)
```

---

## 6. Limitations

- **CloudWatch logs** are not covered by the automated erasure. Structured logging
  does NOT log message content (only metadata). Logs auto-expire per retention policy.
- **S3 media assets** are not yet covered. Avatar media follows S3 lifecycle rules.
- **Memories** are discovered via table scan filtered by userId. For large tables,
  consider adding a GSI on userId for better performance.
- **Cross-table data**: only the `SwarmAdmin` table is covered. The `swarm-state`
  table (channel state, activity records) uses TTL-based auto-expiry.

---

## 7. Testing

```bash
bun test packages/admin-api/src/services/dsar.test.ts
```

Tests cover:
- Data discovery with populated and empty data
- Export returns structured data with retention exceptions
- Erasure deletes records and records an audit event
- Dry-run mode previews without deleting
- Graceful handling of users with no data
