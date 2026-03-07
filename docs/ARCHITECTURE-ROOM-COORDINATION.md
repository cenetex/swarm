# Architecture RFC: Unified Room Coordination for Multi-Avatar Chat

## Status

Draft

## Problem

The runtime currently treats a shared channel as many avatar-local conversations instead of one shared room with many potential speakers.

That leads to four systemic failures:

1. One inbound human message is fanned out into multiple avatar-local pipelines.
2. Each avatar keeps its own channel history and cooldowns, so avatars do not see each other's turns.
3. Telegram and Discord admission logic differs, while the core coordination rules are duplicated across packages.
4. "Natural participation" is mostly prompt guidance rather than a hard runtime constraint.

This creates spammy group-chat behavior, especially when many avatars are active in the same Telegram or Discord channel.

## Goals

- Make `platform + channelId` the unit of coordination.
- Guarantee `0..1` primary text replies per triggering human message by default.
- Let avatars see shared room history, including other avatar turns.
- Support both Telegram and Discord through the same coordination engine.
- Separate reactive replies from proactive participation.
- Move live coordination into the runtime plane, not the admin/control plane.

## Non-Goals

- Replacing avatar persona or memory systems.
- Designing a new admin UX in this RFC.
- Solving every moderation problem in the same change.
- Eliminating platform-specific adapters.

## Current State

### What is live today

- Platform ingress admits messages per avatar.
- Shared handlers enqueue work per `avatarId + conversationId`.
- Channel state is stored per avatar.
- Bot replies are written back only to the responding avatar's state.

### What exists but is not the live path

- `packages/admin-api/src/services/channel-state.ts`
- `packages/admin-api/src/services/shared-channel.ts`
- `packages/admin-api/src/services/initiative.ts`

These contain better multi-avatar ideas, but they are not the production coordination path for Telegram or Discord.

## Design Principles

1. Shared rooms are first-class runtime objects.
2. Coordination happens before LLM generation, not after.
3. The default is silence; speaking is earned.
4. Platform adapters normalize events but do not own turn-taking policy.
5. Shared state is authoritative; per-avatar state is only an overlay.
6. Reactive and proactive behaviors use different budgets.

## Proposed Architecture

### 1. Canonical Room Event Model

Every inbound platform message becomes one canonical `RoomEvent`.

```ts
interface RoomEvent {
  roomKey: string;           // e.g. telegram:-100123 or discord:123456
  platform: 'telegram' | 'discord' | 'shared-chat';
  channelId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  isFromBot: boolean;
  text?: string;
  mentionedAvatarIds: string[];
  replyToMessageId?: string;
  timestamp: number;
  rawRef?: string;
}
```

Ingress should append this event once and enqueue one room-scoped coordination job.

### 2. Shared Room State

The runtime keeps one shared room record per room:

- recent human and avatar messages
- last primary responder
- last responder timestamp
- thread ownership / affinity
- recent question state
- room activity level
- participation budget window
- per-platform metadata

This is the source of truth for turn-taking.

### 3. Per-Avatar Room Overlay

Each avatar gets a small overlay for the same room:

- last spoke at
- recent direct engagement with a user
- fatigue / cooldown score
- recent bot-to-bot interaction age
- thread ownership confidence
- topical affinity hints

This overlay informs selection. It is not allowed to override shared room constraints.

### 4. Room Coordinator

Create a single runtime coordinator package in `@swarm/core` or a new `@swarm/coordination` package.

Responsibilities:

- load shared room state
- load eligible avatars for the room
- compute candidate scores
- elect one primary responder or no responder
- optionally allow delayed secondary reactions
- emit a `TurnDecision`

```ts
interface TurnDecision {
  action: 'ignore' | 'primary_reply' | 'reaction_only' | 'defer' | 'continue_thread';
  primaryAvatarId?: string;
  reactionAvatarIds?: string[];
  trigger:
    | 'direct_mention'
    | 'reply_to_avatar'
    | 'thread_owner'
    | 'sticky_affinity'
    | 'topic_match'
    | 'conversation_gap'
    | 'proactive'
    | 'none';
  delayMs?: number;
  reason: string;
}
```

### 5. Queue Topology

Current queue grouping is avatar-scoped. Replace it with room-scoped ordering:

- ingress queue group: `roomKey`
- coordination worker: serial per room
- response queue: still avatar/platform specific after the decision is made

This gives us a single turn arbiter per room while keeping outbound delivery isolated.

### 6. Selection Policy

Primary selection order:

1. explicit reply to an avatar's prior message
2. explicit avatar mention or name hit
3. active thread ownership
4. sticky user-avatar affinity
5. topic relevance / persona fit
6. channel rotation / fairness
7. silence

Hard suppressors:

- another avatar already elected for this event
- room-level cooldown budget exhausted
- avatar recently spoke
- bot-to-bot chain is too dense
- recent room bot ratio exceeds budget

Default policy:

- `maxPrimaryRespondersPerEvent = 1`
- `maxSecondaryReactionsPerEvent = 0`
- bot-to-bot continuation allowed only with long stagger and low probability

### 7. Reactive vs Proactive Participation

Reactive participation is caused by:

- mention
- reply
- direct question
- active thread continuation

Proactive participation is separate:

- scheduled room scan
- silence window satisfied
- room bot density below threshold
- avatar has budget remaining

This prevents casual chatter from triggering many avatars at once.

### 8. Shared Ledger

Both inbound user messages and outbound avatar messages must be appended to one shared room ledger.

That ledger is used for:

- LLM conversation context
- reply routing
- "who spoke last" checks
- thread ownership
- observability and replay

Ingress must stop double-writing messages. Outbound senders must append sent bot messages back into the shared ledger.

## Platform Boundaries

### Handlers

Handlers should only:

- verify platform authenticity
- normalize events into `RoomEvent`
- enforce platform-specific permissions
- enqueue room-scoped work
- send outbound actions

### Core Runtime

Core should own:

- room ledger
- room coordinator
- arbitration logic
- cooldowns and participation budgets
- thread ownership
- shared context building

### Admin API

Admin API should own:

- configuration
- inspection
- overrides
- moderation controls
- diagnostics

It should not own production turn-taking logic.

## Storage Model

Suggested DynamoDB split:

- `ROOM#{roomKey}` / `STATE`
- `ROOM#{roomKey}` / `EVENT#{timestamp}#{messageId}`
- `ROOM#{roomKey}` / `AVATAR#{avatarId}#OVERLAY`
- `ROOM#{roomKey}` / `TURN#{messageId}`

This allows:

- shared room history queries
- per-room ordering
- avatar overlays without duplicating the room buffer
- replay/debugging of turn decisions

## Observability

The coordinator should log structured decisions:

- roomKey
- triggering messageId
- eligible avatar count
- selected avatar
- suppressed avatars and reasons
- trigger type
- room bot density
- cooldown and budget values

This is required for tuning. Without a visible decision trace, the system will regress silently.

## Migration Plan

### Phase 1: Introduce canonical room primitives

- add `RoomEvent`, `TurnDecision`, shared room state types
- create room-scoped queue path behind a feature flag
- keep existing per-avatar handlers running

### Phase 2: Shared ledger and single arbiter

- append inbound events once
- elect one primary responder before LLM generation
- write outbound avatar messages to the shared ledger

### Phase 3: Replace avatar-local gating

- remove duplicate ingress writes
- retire per-avatar channel arbitration for Telegram and Discord shared rooms
- keep per-avatar overlays only for personalization and fatigue

### Phase 4: Proactive participation

- add separate room-scoped proactive scheduler
- enforce per-room bot density and time budgets

### Phase 5: Delete split-brain runtime code

- remove or archive production-duplicate coordination logic in `admin-api`
- keep admin inspection tools only

## Risks

- Room-scoped serialization increases coupling to one coordination worker path.
- Shared room history will increase write load and should use bounded retention.
- Existing Telegram home-channel semantics may conflict with explicit room membership.
- Discord webhook-tier issues already in backlog overlap with part of this work and must be reconciled.

## Recommended Backlog Shape

Create one epic plus child issues for:

1. canonical room model and coordinator package
2. room-scoped ingress and queue serialization
3. shared ledger and overlay storage
4. turn arbitration and suppression policy
5. outbound write-back and duplicate-write removal
6. proactive participation scheduler and budgets
7. simulation and regression test harness for multi-avatar rooms

## Relationship to Existing Issues

- `#592` should be treated as a Discord-scoped precursor to the cross-platform turn arbiter.
- `#641`, `#589`, and `#674` remain relevant for Discord transport and tiering, but they should consume the shared coordinator rather than invent their own response routing.
- Telegram shared-room work needs its own backlog because the same structural bug exists there today.
