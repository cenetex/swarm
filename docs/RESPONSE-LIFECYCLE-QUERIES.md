# Response Lifecycle CloudWatch Insights Queries

Reference for debugging response generation, delivery, and drop events.

## Lifecycle Overview

Each response goes through three distinct phases:

1. **response_generated** — LLM produced content, tool-loop complete, response envelope enqueued (emitted from chat-worker)
2. **response_accepted_by_platform** — Platform adapter returned success (emitted from response-sender)
3. **response_dropped** — All actions failed with non-retryable errors (emitted from response-sender)

## Query: Responses generated but not accepted in last hour

Find cases where the LLM generated a response but the platform never confirmed delivery:

```
fields @timestamp, avatarId, conversationId, @message
| filter subsystem = "outbound"
| stats count_if(event = "response_generated") as generated,
        count_if(event = "response_accepted_by_platform") as accepted,
        count_if(event = "response_dropped") as dropped
        by avatarId, conversationId, hour(@timestamp)
| filter generated > (accepted + dropped)
```

## Query: Response drop reasons

View all dropped responses with their failure reasons:

```
fields @timestamp, avatarId, platform, conversationId, reason, errorCount, actionTypes
| filter event = "response_dropped"
| stats count() as drops by reason, platform
| sort drops desc
```

## Query: Avatar-specific response timeline

Debug a specific avatar's response lifecycle over the last 24 hours:

```
fields @timestamp, event, conversationId, platform, @message
| filter avatarId = "avatar-id" and 
         (event = "response_generated" or 
          event = "response_accepted_by_platform" or 
          event = "response_dropped")
| sort @timestamp desc
```

## Query: Silent bot detection

Avatars that generated responses but users saw no messages (generated >> accepted):

```
fields avatarId
| filter subsystem = "outbound" and 
         (event = "response_generated" or event = "response_accepted_by_platform")
| stats count_if(event = "response_generated") as gen,
        count_if(event = "response_accepted_by_platform") as acc
        by avatarId
| filter gen >= 5 and acc < 1
| sort gen desc
```

## Query: Platform-specific drop rate

Compare drop reasons by platform:

```
fields @timestamp, platform, reason
| filter event = "response_dropped"
| stats count() as total_dropped,
        count_if(reason like /reply_target_deleted/) as target_deleted,
        count_if(reason like /rate_limit/) as rate_limit,
        count_if(reason like /overflow/) as overflow,
        count_if(reason like /403/) as forbidden
        by platform
| fields platform, total_dropped, target_deleted, rate_limit, overflow, forbidden,
         (target_deleted / total_dropped) * 100 as target_deleted_pct
```

## Query: Response latency (generated to accepted)

Measure time between generation and platform acceptance:

```
fields @timestamp, @message, avatarId, conversationId
| filter (event = "response_generated" or event = "response_accepted_by_platform")
| stats min(@timestamp) as first_event, max(@timestamp) as last_event by avatarId, conversationId
| fields @timestamp, avatarId, conversationId, (last_event - first_event) as latency_ms
| filter latency_ms > 0
| stats avg(latency_ms), pct(latency_ms, 90), pct(latency_ms, 99), max(latency_ms)
```

## Query: Responses stuck in generated state

Responses enqueued but never sent in the last 6 hours:

```
fields @timestamp, avatarId, conversationId
| filter subsystem = "outbound" and event = "response_generated"
| filter @timestamp < now - 6h
| stats count_if(event = "response_accepted_by_platform" or event = "response_dropped") as terminal
        by avatarId, conversationId, @timestamp
| filter terminal = 0
```

## Metrics

### EMF Metrics Emitted

**ChatWorker (Subsystem = "ChatWorker")**
- `ResponsesGenerated` (Count) — responses enqueued after tool-loop

**ResponseSender (Subsystem = "ResponseSender")**
- `ResponsesAccepted` (Count) — platform confirmed delivery
- `ResponsesDropped` (Count) — terminal failures with Dimension: `DropReason`

### CloudWatch Alarms

Create alarms to watch for silent bots:

**Alert: High drop ratio**
```
(ResponsesDropped / (ResponsesAccepted + ResponsesDropped)) > 0.5
  for 5 minutes
```

**Alert: Generation without acceptance**
```
ResponsesGenerated > 0 and ResponsesAccepted = 0
  for 10 minutes
```

## Integration with Dashboards

- **Activity Table** — Shows all three events per avatar for operator visibility
- **Metrics Dashboard** — Tracks ResponsesGenerated, ResponsesAccepted, ResponsesDropped over time
- **Runbooks** — Use drop reason dimension to escalate to platform-specific teams
