# Pattern: Autonomous Agent Runner

A scheduled Lambda that wakes an avatar, gives it one LLM call against a read-only state tool, and lets it issue command tools under quota. Use it when an avatar needs to act on the world on its own cadence — not in response to a user message.

## When to use this (and when not)

Reach for this pattern when **all** of these are true:

- The avatar needs to act without a user prompting it.
- The action is time-bounded (a few tool calls) and idempotent per tick.
- Ticks are coarse (tens of minutes to days), not seconds.
- The avatar's authority is scoped to tools it can call — not to arbitrary side effects.

Pick something else when:

- The work is reactive to a user message (Telegram/Discord/Twitter webhook path is cheaper).
- The cadence is sub-minute (use SQS + worker, not EventBridge).
- The work is platform-wide and avatar-agnostic (use a plain scheduled Lambda; no need to iterate avatars).
- You need sub-second latency from event → action (this is batch-flavored, not real-time).

## Anatomy

```
EventBridge rule (rate=1h)
   │
   ▼
Lambda handler (ScheduledHandler)
   │
   ├── load station-governing avatars from state
   │
   ├── for each avatar:
   │     │
   │     ├── gate: shouldRunNow(lastRunTime, min, max)?
   │     │     (skip if inside cooldown)
   │     │
   │     ├── load AvatarConfig + secrets
   │     │
   │     ├── register MCP tools:
   │     │     - read-only state tool (signal_station_state)
   │     │     - command tools (signal_set_price, signal_hail, ...)
   │     │
   │     ├── one LLM call via tool loop
   │     │     (avatar picks which commands to run, under quota)
   │     │
   │     └── persist: lastRun heartbeat, emitted actions, audit entry
   │
   └── DLQ on failure (retryAttempts: 2, maxEventAge: 2h)
```

## Worked example: Signal station governance (`station-agent-runner`)

Reference implementation for the first shipped runner. Every piece below maps to a tactical choice you will repeat in the next runner.

| Concern                  | Signal station implementation |
|--------------------------|-------------------------------|
| Entry point              | `packages/handlers/src/station/station-agent-runner.ts` (`handler: ScheduledHandler`) |
| Schedule                 | `events.Schedule.rate(Duration.hours(1))` — infra in `packages/infra/src/constructs/shared-handlers.ts` (see `StationAgentSchedule`) |
| Lambda config            | `timeout: 5min`, `memory: 1GB`, `retryAttempts: 2`, `maxEventAge: 2h`, DLQ = `schedulerDlq` |
| Avatar selection         | `isStationAvatar(config)` — filter by `config.tools` containing `signal_station_state` or anything starting with `signal_` |
| Per-avatar gate          | `shouldRunNow(lastRunTime, 20h, 28h)` with deterministic randomization from `lastRunTime % 1000` |
| Idempotency              | heartbeat key `signal-station` on the avatar's state row via `stateService.getLastHeartbeat` / `putLastHeartbeat` |
| State tool (read-only)   | `signal_station_state` — hits `GET /api/station/{id}/state` on the Signal API |
| Command tools (write)    | `signal_set_price`, `signal_hail`, etc. — gated by the avatar's `tools` allowlist |
| Env contract             | `SIGNAL_API_URL`, `STATE_TABLE`, `SECRET_PREFIX`, `MEDIA_BUCKET`, `CDN_URL` |
| Synthetic envelope       | `buildSchedulerEnvelope(avatarId)` — `platform: 'web'`, `conversationId: station_governance_<avatarId>`, explicit `idempotencyKey` |
| Audit trail              | `activityService.logResponseSent` + DynamoDB rows for `lastHailText`, `lastChannelMessageId`, etc. |
| Failure isolation        | One avatar's failure does not abort the batch; errors bubble as `{ acted: false, error }` entries |
| Observability            | `createSystemLogger('station-agent-runner')`, structured `(subsystem, event, data)` — see [../observability.md](../observability.md) |

## Checklist for a new runner

When you ship the next one (raticross relay is the likely candidate), work through this list and don't skip:

1. **Tick cadence bounds.** State the min and max interval in hours. Write them down in the runner file so the next reader doesn't have to derive them. Signal uses 20–28h (roughly daily ± 4h) with deterministic jitter to avoid thundering-herd on any one hour.
2. **Idempotency.** A heartbeat key per avatar + tool-loop input keyed by `idempotencyKey` so CloudWatch/EventBridge retries don't double-act. Writes that can't be idempotent (e.g., sending Telegram messages) must be deduped at the side-effect boundary, not here.
3. **Entitlement / energy integration.** The LLM call consumes quota. Wire through `checkMediaWithEnergyFallback` / equivalent before the loop; if burst quota is exhausted, skip this tick rather than stall.
4. **Avatar selection.** How do you decide which avatars participate? Tool allowlist (Signal's pattern) is the cheapest; avoid scanning the whole avatar table every tick if the set is small.
5. **Read-only state tool first.** The LLM must have a way to observe the world before acting. If there's no cheap read, the runner will hallucinate.
6. **Command tools gated by tool allowlist.** Never trust the LLM to pick tools not on the avatar's `tools` array. The MCP client respects this; don't bypass it.
7. **Audit log every emitted action.** Drop a structured log entry (`subsystem: 'runner'`, `event: 'tool_call_emitted'`) for each command, plus one summary per avatar per tick. This is how you prove the runner is acting sanely.
8. **Kill-switch.** One env var or feature flag that disables the runner without a code deploy. For Signal: `ENVIRONMENT` + avatar-level `tools` array flipping disables it; consider a cleaner `DISABLE_STATION_AGENT` if you want a faster lever.
9. **DLQ behavior.** SQS DLQ on the EventBridge rule with `retryAttempts: 2`. Downstream: DLQ processor (`SharedHandlersDlqProcessor`) alarms on non-empty DLQ.
10. **Single LLM call per tick, not a loop.** The tool loop inside a tick is bounded; the **outer** tick rate is what you want to tune, not the inner call budget.

## Non-goals

- **Building a shared runner framework.** Ship one more runner (raticross relay) the same way Signal did, then look at the diff and extract the common pieces. Premature abstraction will cost more than it saves.
- **Real-time reactions.** If you need the avatar to respond within seconds to an event, that's a webhook or SQS worker, not this pattern.
- **Cross-avatar coordination.** Each avatar ticks in isolation. If two avatars need to coordinate, they do it through the game/world API (Signal's channel messages) or through raticross — not through shared runner state.
