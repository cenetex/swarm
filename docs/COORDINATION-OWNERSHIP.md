# Coordination Ownership Model

This document defines which package owns live coordination decisions (turn-taking, response timing, multi-avatar coordination) for shared Telegram and Discord rooms.

## Current Architecture: Room-Scoped Coordination

As of the room-coordination work (see [ARCHITECTURE-ROOM-COORDINATION.md](./ARCHITECTURE-ROOM-COORDINATION.md)), all live multi-avatar coordination uses **room-scoped primitives** in `core` and `handlers`. The unit of coordination is `platform + channelId` (a "room"), not the individual avatar.

## Ownership Boundaries

### Runtime (core + handlers) -- AUTHORITATIVE for live coordination

All live message routing and turn-selection decisions flow through:

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `shared-room.ts` | `packages/core/src/services/shared-room.ts` | Shared room ledger: append messages, query recent history, per-avatar overlays, room metadata. Single DynamoDB partition per room (`ROOM#{roomId}`). |
| `turn-arbiter.ts` | `packages/core/src/services/turn-arbiter.ts` | Deterministic turn election: scores candidates by reply-to, @mention, name-hit, sticky affinity, thread ownership, then random fallback. Emits a `TurnDecision` with exactly 0 or 1 primary responder. |
| `room-ingress.ts` | `packages/handlers/src/services/room-ingress.ts` | Room-scoped ingress: appends one message to the shared ledger per inbound event, deduplicates by `messageId`, builds a deterministic `roomKey` (`platform:channelId`). |
| `webhook-home-channel.ts` | `packages/handlers/src/telegram/webhook-home-channel.ts` | Explicit shared-room membership registry. Tracks which avatars are members of which channels via `registeredAvatars` on `HOME_CHANNELS` records. Provides `isSharedRoom()` (2+ avatars), `getChannelAvatarIds()`, and `addSharedChannelMembership()` / `removeSharedChannelMembership()`. |
| `message-processor.ts` | `packages/handlers/src/messaging/message-processor.ts` | Consumes SQS events, calls the turn arbiter for shared rooms, runs the agent pipeline for the elected primary. |
| `response-sender.ts` | `packages/handlers/src/messaging/response-sender.ts` | Sends responses and writes outbound avatar messages back to the shared room ledger. |

### The runtime path (shared rooms)

```
Webhook / Gateway
    |
    v
room-ingress.ts
    -> buildRoomKey(platform, channelId)          [handlers/services/room-ingress.ts]
    -> isSharedRoom(platform, channelId)          [handlers/services/room-ingress.ts]
    -> processSharedRoomMessage()                 [handlers/services/room-ingress.ts]
       -> dedup by messageId against recent ledger
       -> appendMessage() once to shared ledger   [core/services/shared-room.ts]
    -> enqueue ONE room-scoped SQS message
    |
    v
message-processor.ts
    -> getChannelAvatarIds(channelId)             [handlers/telegram/webhook-home-channel.ts]
    -> selectPrimaryResponder(candidates, msg)    [core/services/turn-arbiter.ts]
    -> (if primary elected) run agent pipeline for that avatar
    -> (all others suppressed)
    |
    v
response-sender.ts
    -> send reply via platform API
    -> appendMessage() bot reply to shared ledger [core/services/shared-room.ts]
```

### Private chats and single-avatar channels

Private chats and channels with only one registered avatar bypass room-scoped coordination entirely. They continue to use the per-avatar enqueue path with `MessageGroupId: avatarId#conversationId`.

### admin-api -- CONTROL-PLANE ONLY

The admin-api coordination modules listed below are **not used for live routing**. They predate the room-scoped runtime and are retained only for backward-compatible admin queries.

| Module | Location | Status |
|--------|----------|--------|
| `channel-state.ts` | `packages/admin-api/src/services/channel-state.ts` | **Obsolete for live coordination.** Marked `@deprecated`. Retained only for `getKnownTelegramUsers` (admin query) and legacy shared history functions. |
| `initiative.ts` | `packages/admin-api/src/services/initiative.ts` | **Obsolete.** D&D-style multi-avatar initiative system. Marked `@deprecated`. Superseded by `turn-arbiter.ts` in core. |
| `shared-channel.ts` | `packages/admin-api/src/services/shared-channel.ts` | **Superseded** by `webhook-home-channel.ts` explicit membership registry. Retained for legacy presence queries. |
| `reactions.ts` | `packages/admin-api/src/services/reactions.ts` | **Obsolete.** Emoji reaction handling tied to initiative system. Marked `@deprecated`. |

These modules are:
- NOT exported through the public `@swarm/admin-api` barrel (`services/index.ts`)
- Only accessible through internal domain barrel files (`services/channel/index.ts`, `services/chat/index.ts`)
- Only imported by admin-api's own handlers for control-plane queries (e.g., `getKnownTelegramUsers` in avatar routes)

### What admin-api coordination IS used for

- **Diagnostics**: `getChannelState`, `getKnownTelegramUsers` -- inspecting channel state for admin dashboards
- **Configuration reference**: `CHANNEL_CONFIG`, `MULTI_AGENT_CONFIG` -- configuration constants for tuning

### What admin-api coordination is NOT used for

- Live turn-selection (who responds to a message) -- owned by `turn-arbiter.ts`
- Response timing (when to respond) -- owned by the room-scoped ingress + turn arbiter
- State machine transitions during message processing
- Cooldown enforcement in production webhooks
- Shared room membership -- owned by `webhook-home-channel.ts`
- Shared room history -- owned by `shared-room.ts` ledger

## Turn Arbiter: Selection Policy

The turn arbiter (`packages/core/src/services/turn-arbiter.ts`) elects at most one primary responder per human message using a priority scoring system:

| Priority | Tier | Score | Trigger |
|----------|------|-------|---------|
| 1 | Direct reply-to | 600 | Message is a reply to this avatar's prior message (confidence >= threshold) |
| 2 | Explicit @mention | 500 | Avatar is @mentioned in the message |
| 3 | Name hit | 400 | Avatar's name appears in message text |
| 4 | Sticky affinity | 300 | Avatar was the last responder in this room |
| 5 | Thread ownership | 200 | Avatar owns the current thread |
| 6 | Random fallback | 100 | Deterministic hash of `messageId` for reproducible tiebreaking |

**Hard suppressors:**
- Bot-to-bot chains are suppressed by default (`suppressBotToBot: true`)
- Once a primary is elected, all other candidates are suppressed

## Shared Room Ledger: Storage Model

The shared room ledger uses a single DynamoDB partition per room:

| Key pattern | Purpose |
|-------------|---------|
| `ROOM#{roomId}` / `META` | Room metadata: platform, createdAt, messageCount |
| `ROOM#{roomId}` / `MSG#{timestamp}#{messageId}` | Individual messages (human and bot), TTL 7 days |
| `ROOM#{roomId}` / `OVERLAY#{avatarId}` | Per-avatar room overlay (lastParticipatedAt, cooldown, affinity), TTL 30 days |

## Room Membership Registry

The home channel registry (`webhook-home-channel.ts`) tracks explicit avatar membership per channel:

| Key pattern | Purpose |
|-------------|---------|
| `HOME_CHANNELS` / `{chatId}` | Channel record with `registeredAvatars` array |

- `addSharedChannelMembership(avatarId, chatId, botUsername)` -- adds an avatar to a channel
- `removeSharedChannelMembership(avatarId, chatId)` -- removes an avatar from a channel
- `getChannelAvatarIds(chatId)` -- returns all avatar IDs registered in a channel
- `isSharedRoom(platform, channelId)` -- returns `true` when 2+ avatars are registered
- `getHomeChannelIdsForAvatar(avatarId)` -- returns channels where the avatar has explicit membership

Membership is cached in-memory with a 60-second TTL and invalidated on writes.
