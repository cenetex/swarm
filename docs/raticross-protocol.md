# Raticross Protocol v0.1

Inter-agent communication protocol for the raticross bridge connecting Swarm avatars with external agent systems.

## Overview

Raticross is the agent-to-agent bridge layer. It defines a JSON envelope format that systems use to exchange messages, tasks, results, and status updates. The first bridge pair is **Swarm <-> Kyro**.

## Message Envelope

All messages use the `RaticrossEnvelope` format:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "traceId": "trace-abc-123",
  "protocol": "0.1",
  "timestamp": 1710000000000,
  "from": {
    "system": "swarm",
    "agentId": "avatar-kyro-001",
    "pubkey": "optional-ed25519-key"
  },
  "to": {
    "system": "kyro",
    "agentId": "kyro-main"
  },
  "type": "message",
  "conversationId": "conv-abc-123",
  "content": "Hello from Swarm!",
  "context": {
    "summary": "User greeting exchange",
    "constraints": "Keep responses brief",
    "toolHints": ["memory", "search"]
  },
  "meta": {
    "ttl": 60000,
    "priority": "normal",
    "tags": ["greeting"]
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique message identifier |
| `timestamp` | number | Unix timestamp in milliseconds |
| `from` | RaticrossActor | Sending agent |
| `to` | RaticrossActor | Target agent |
| `type` | enum | One of: `message`, `task`, `result`, `status` |
| `conversationId` | string | Conversation thread identifier |
| `content` | string | Message body (text) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `traceId` | string | Distributed trace ID for request/response correlation |
| `protocol` | string | Protocol version (e.g., `"0.1"`) |
| `context` | object | Structured context for the receiver |
| `meta` | object | Routing and lifecycle metadata |

### Envelope Types

- **`message`** — Standard text message between agents
- **`task`** — Request for the receiving agent to perform work
- **`result`** — Response to a prior task
- **`status`** — System status update (heartbeat, state change)

## Actor Identification

```json
{
  "system": "swarm",
  "agentId": "avatar-kyro-001",
  "pubkey": "optional"
}
```

The combination of `system` + `agentId` is globally unique. In Swarm, the `agentId` maps to the avatar ID.

## Health Check

### Request

```
POST /raticross/health
x-raticross-key: <shared-secret>

{
  "type": "health",
  "timestamp": 1710000000000,
  "from": { "system": "swarm", "agentId": "health-probe" },
  "protocol": "0.1"
}
```

### Response

```json
{
  "ok": true,
  "system": "kyro",
  "protocol": "0.1",
  "timestamp": 1710000000000,
  "uptime": 3600000,
  "agents": ["kyro-main"]
}
```

## Authentication

All requests include an `x-raticross-key` header containing a shared secret. Both the inbound relay and health check endpoints validate this key.

## Integration Points

### Swarm Side

| Component | Path | Role |
|-----------|------|------|
| Protocol types | `packages/core/src/types/raticross.ts` | Shared type definitions |
| Bridge client | `packages/core/src/services/raticross-client.ts` | Send messages and health checks |
| Inbound handler | `packages/handlers/src/relay/raticross-inbound.ts` | Receive messages from peers |
| Health handler | `packages/handlers/src/relay/raticross-health.ts` | Respond to health probes |
| Outbound adapter | `packages/handlers/src/messaging/adapters/raticross-adapter.ts` | Forward responses to peers |
| Platform config | `RaticrossConfig` in avatar config | Per-avatar bridge settings |

### Avatar Configuration

Enable raticross for an avatar by adding to its `platforms` config:

```json
{
  "platforms": {
    "raticross": {
      "enabled": true,
      "relayUrl": "https://kyro-relay.example.com",
      "agentId": "kyro-main"
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `RATICROSS_INBOUND_KEY` | Shared secret for authenticating inbound requests |
| `MESSAGE_QUEUE_URL` | SQS FIFO queue URL for inbound message processing |
| `STATE_TABLE` | DynamoDB table for avatar config lookup |

### Secrets (per-avatar)

| Secret | Description |
|--------|-------------|
| `RATICROSS_RELAY_KEY` | Shared secret for authenticating outbound requests to peer |

## Message Flow

### Inbound (Kyro -> Swarm)

1. Kyro sends `RaticrossEnvelope` to `POST /raticross/inbound`
2. Handler validates auth key and envelope fields
3. Looks up target avatar by `to.agentId`
4. Maps envelope to `SwarmEnvelope` with platform `raticross`
5. Enqueues to shared message FIFO queue
6. Message processor generates LLM response
7. Response sender dispatches via `RaticrossAdapter`

### Outbound (Swarm -> Kyro)

1. Response sender detects platform `raticross` for the conversation
2. `RaticrossAdapter.executeAction()` builds a `RaticrossEnvelope`
3. POSTs to peer's `/raticross/inbound` endpoint
4. Peer processes and responds through their own pipeline

### Health Check

1. Bridge client sends health probe to `POST /raticross/health`
2. Peer responds with system info, protocol version, uptime, and available agents
3. Client returns parsed `RaticrossHealthResponse`
