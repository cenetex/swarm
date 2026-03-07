# Coordination Ownership Model

This document defines which package owns live coordination decisions (turn-taking, response timing, multi-avatar coordination) for shared Telegram and Discord rooms.

## Ownership Boundaries

### Runtime (core + handlers) -- AUTHORITATIVE for live coordination

All live message routing and turn-selection decisions flow through:

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `channel-state.ts` | `packages/core/src/services/state/channel-state.ts` | State machine (IDLE/ACTIVE/COOLDOWN), response trigger evaluation, cooldown enforcement, message buffering, context building |
| `message-processor.ts` | `packages/handlers/src/messaging/message-processor.ts` | Calls `stateService.evaluateResponseTrigger()` to decide whether to respond |
| `response-sender.ts` | `packages/handlers/src/messaging/response-sender.ts` | Sends responses and calls `stateService.markResponseSent()` |

The runtime path is:

```
Webhook -> SQS -> message-processor.ts
  -> stateService.addMessageToChannel()     [core/state/channel-state.ts]
  -> stateService.evaluateResponseTrigger() [core/state/channel-state.ts]
  -> (if shouldRespond) process & send response
  -> stateService.markResponseSent()        [core/state/channel-state.ts]
```

### admin-api -- CONTROL-PLANE ONLY

admin-api coordination modules exist but are NOT used for live routing:

| Module | Location | Status |
|--------|----------|--------|
| `channel-state.ts` | `packages/admin-api/src/services/channel-state.ts` | Parallel implementation with different config values. Marked `@deprecated`. Retained for `getKnownTelegramUsers` (admin query) and shared history functions. |
| `initiative.ts` | `packages/admin-api/src/services/initiative.ts` | D&D-style multi-avatar initiative system. Marked `@deprecated`. Not wired into live processing. Candidate for future migration to core. |
| `shared-channel.ts` | `packages/admin-api/src/services/shared-channel.ts` | Avatar-in-channel registry. Used for presence tracking. Not used for live turn-selection. |
| `reactions.ts` | `packages/admin-api/src/services/reactions.ts` | Emoji reaction handling tied to initiative system. Marked `@deprecated`. Not wired into live processing. |

These modules are:
- NOT exported through the public `@swarm/admin-api` barrel (`services/index.ts`)
- Only accessible through internal domain barrel files (`services/channel/index.ts`, `services/chat/index.ts`)
- Only imported by admin-api's own handlers for control-plane queries (e.g., `getKnownTelegramUsers` in avatar routes)

### What admin-api coordination IS used for

- **Diagnostics**: `getChannelState`, `getKnownTelegramUsers` -- inspecting channel state for admin dashboards
- **Presence tracking**: `shared-channel.ts` -- knowing which avatars are in which channels
- **Shared history**: `getSharedHistory`, `recordBotMessage` -- multi-avatar context sharing (read by admin tools)
- **Configuration reference**: `CHANNEL_CONFIG`, `MULTI_AGENT_CONFIG` -- configuration constants for tuning

### What admin-api coordination is NOT used for

- Live turn-selection (who responds to a message)
- Response timing (when to respond)
- State machine transitions during message processing
- Cooldown enforcement in production webhooks

## Key Differences Between Implementations

| Aspect | core (runtime) | admin-api (control-plane) |
|--------|---------------|--------------------------|
| Cooldown duration | 10s | 60s |
| Message threshold | 3 | 6 |
| Conversation gap | 20s | 45s |
| Direct engagement delay | 0ms | 2000ms |
| Buffer TTL | 90 days | 1 hour |
| DynamoDB key pattern | `AVATAR#{id}` / `CHANNEL#{id}#STATE` | `CHANNEL#{avatarId}#{chatId}` / `STATE` |
| Multi-avatar support | Single-avatar per channel state | Sticky engagement, dynamic cooldowns, initiative rounds |
| Engaged user tracking | `engagedUsers` map with expiry | `stickyEngagement*` fields |

## Migration Notes

If multi-avatar coordination (initiative system) is needed in production:

1. Move `initiative.ts`, `shared-channel.ts`, and `reactions.ts` logic into `packages/core/` or `packages/handlers/`
2. Wire `coordinateInitiative()` into `message-processor.ts` alongside `evaluateResponseTrigger()`
3. Unify the DynamoDB key patterns
4. Remove or fully deprecate the admin-api copies
5. Update tests to point to the new locations

Until then, the admin-api copies serve as a reference implementation and are clearly marked as control-plane-only.
