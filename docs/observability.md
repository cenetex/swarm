# Observability

How to emit structured logs from aws-swarm services. Applies to `packages/admin-api/**` (and anywhere that pulls in `@swarm/core` logging helpers). This is the how-to; see `packages/admin-api/src/services/structured-logger.ts` for the API surface.

## Why structured logs

Every service writes JSON lines to stdout. CloudWatch ingests them verbatim; the admin UI's log viewer also reads them from DynamoDB. Bare `console.log("user ${id} deleted")` forces every future reader to regex their way through sentences — fine when there are five log lines, unusable when there are five million. The structured logger guarantees every line has `{level, subsystem, event, avatarId?, platform?, requestId?, ...data}`, which is what CloudWatch Logs Insights and the in-UI filter rely on.

Concretely, the migration that landed these loggers (#1363) replaced ~150 bare `console.*` sites. Don't reintroduce them — see the [ratchet](#ratchet) section.

## Which logger do I use?

```
┌──────────────────────────────────────────────────────────────┐
│ Do you have an avatarId in scope?                            │
│                                                              │
│   yes → createAvatarLogger(avatarId, platform?)              │
│          (emits avatarId + platform on every line)           │
│                                                              │
│   no  → createSystemLogger(module)                           │
│          (e.g. 'billing-handler', 'stripe-webhook')          │
│          internally sets avatarId='system', platform=module  │
└──────────────────────────────────────────────────────────────┘
```

Rules of thumb:

- **Per-request handlers** that operate on one avatar (webhooks, API endpoints under `/avatars/{avatarId}/...`) — `createAvatarLogger(avatarId, platform)` at the top of the handler, then reuse.
- **Background services** without an avatar context (cron jobs, cross-avatar maintenance, CDK-invoked Lambdas) — `createSystemLogger('my-module')`.
- **Mixed**: when a system-level handler ends up with an avatarId mid-execution (e.g. media-processor dequeues a job for avatar X), create a fresh `createAvatarLogger(avatarId, platform)` for that work; don't mutate the system logger.

The returned logger exposes `debug`, `info`, `warn`, `error`, plus `setRequestId(id)` for cross-line correlation. `debug` is console-only; `info`/`warn`/`error` also flush to DynamoDB for the admin UI.

## Call signature

```ts
log.info(subsystem, event, data?);
```

- **`subsystem`** — short grouping within the module. Lowercase, hyphen-or-snake for multi-word. Examples: `'webhook'`, `'oauth'`, `'stripe'`, `'gate'`, `'video_gen'`, `'entitlements'`. Pick the smallest meaningful unit; it's how CloudWatch Insights slices the logs.

- **`event`** — lowercase snake_case. For state changes, past tense: `'token_exchange_failed'`, `'webhook_received'`, `'stripe_event_ignored'`, `'entitlement_change_audit_failed'`. For ongoing/idempotent actions, present: `'stripe_ping_ok'`, `'unknown_stripe_price_id'`. Event codes are the stable vocabulary Logs Insights queries (and alarms) pivot on — don't rename them casually.

- **`data`** — a `Record<string, unknown>` of structured fields. Use it for everything you'd otherwise stuff into an interpolated string: IDs, HTTP status codes, durations, error messages. PII is redacted automatically by `redactLogData`. Don't fabricate fields ("happy: true"); don't drop real ones silently.

### Good

```ts
const log = createSystemLogger('billing-handler');
log.warn('stripe', 'unknown_stripe_price_id', {
  priceId,
  eventId: event.id,
  customerId,
});
```

### Bad

```ts
console.warn(`Unknown price ${priceId} for event ${event.id}`);
// — loses the event code (not greppable across price IDs)
// — forces future readers to regex out the ID
// — never shows up in the admin UI log viewer
```

## Reference event codes

Representative events that shipped in #1363. Use these as templates when naming new ones (don't invent a new convention).

| Subsystem     | Event code                          | Level |
|---------------|-------------------------------------|-------|
| `stripe`      | `stripe_event_received`             | info  |
| `stripe`      | `stripe_event_ignored`              | info  |
| `stripe`      | `stripe_ping_ok`                    | info  |
| `stripe`      | `unknown_stripe_price_id`           | warn  |
| `stripe`      | `resolve_subscription_metadata_failed` | error |
| `stripe`      | `entitlement_change_audit_failed`   | error |
| `stripe`      | `payment_failure_audit_failed`      | error |
| `stripe`      | `invoice_paid_audit_failed`         | error |
| `stripe`      | `unhandled_exception`               | error |

See `packages/admin-api/src/handlers/billing.ts` for the calling patterns.

## Documented exception: avatar-observability

`packages/admin-api/src/services/avatar-observability.ts` keeps two bare `console.warn` sites inside `recordLogBatch`'s drop-items fallback (currently lines 309 and 336). **This is intentional.** `recordLog` — which the structured logger calls to persist to DynamoDB — lives in this same file. If we used `createSystemLogger` here, a DynamoDB outage would recurse: the logger would try to persist its own "batch dropped" warning via the same failing DynamoDB path.

The two sites are marked with `eslint-disable-next-line no-console` plus a comment explaining the circular-dependency rationale. **Don't "fix" them.** If you find yourself adding a third console fallback, reconsider — you probably don't have the same recursion risk and should use `createSystemLogger` instead.

## Ratchet

The migration to structured logging is complete as of #1363. Going forward, **new files under `packages/admin-api/src/**/*.ts` must not add `console.log`, `console.warn`, `console.error`, or `console.info`.** Exceptions:

- The two documented fallback sites in `avatar-observability.ts` above.
- The transport line inside `structured-logger.ts` itself (`console.log(JSON.stringify(logEntry))` — that's how CloudWatch ingests).
- Legacy files that predate the migration and haven't been touched — leave them until you're editing them for another reason, then migrate the whole file.

The eslint config flags bare `console.*` usage; if you need a real exception, disable it inline with a comment explaining *why*, not just *that*.

## Correlating logs across a request

For handlers that span multiple services, set a request ID once at the entry point:

```ts
const log = createAvatarLogger(avatarId, platform);
log.setRequestId(event.requestContext.requestId);
```

All subsequent `log.*` calls on that logger include `requestId`, so Logs Insights `filter requestId = "..."` reconstructs the full flow. Pass the same request ID into downstream services if they accept one.

## Channel State and Message Deduplication

When storing messages in `ChannelState.recentMessages`, each message must be uniquely identifiable. The `messageId` field is the platform-specific message identifier (e.g., Telegram `message_id`, not SQS `messageId`). Important invariants:

- **`messageId` uniqueness**: Each entry in `recentMessages` has a unique `messageId` per channel. This is guaranteed by the idempotency guard in `addMessageToChannel` (issue #1552).
- **No duplicate appends on redelivery**: If SQS redelivers the same message (same platform `messageId`), it will only be appended to the buffer once. Subsequent deliveries are idempotent no-ops.
- **Flags computed once**: `isMention` and `isReplyToBot` metadata are computed exactly once at envelope construction time (`buildTelegramEnvelope`, etc.) and propagated through to the channel buffer via `ContextMessage`. There is no re-derivation downstream — downstream consumers read from `envelope.metadata` and `contextMessage` directly.

When querying `recentMessages` in triggers or response selection, you can safely assume each `messageId` appears exactly once, even if the underlying transport (SQS) might redeliver the same update multiple times.

## Lambda log levels by environment

| Lambda | Prod | Dev/Staging |
|--------|------|-------------|
| Shared Handlers (message-processor, chat-worker, response-sender, media-processor, etc.) | `info` | `info` |
| Admin API | `warn` | `info` |

**Shared Handlers** run at `info` level in both prod and staging to ensure lifecycle events are visible for debugging the chat-worker → response-sender path in CloudWatch. These Lambdas have low frequency (not on the noisy webhook path), so the additional log volume is acceptable. Key events that rely on `info` level:

- `chat_worker_started`, `chat_worker_complete`, `response_generated` (chat-worker diagnostics)
- `response_sent`, `response_failed` (response-sender diagnostics — canonical "message reached user" signal)
- Tool-call loop metrics and individual tool results

**Admin API** runs at `warn` in prod to reduce log volume from the high-throughput chat endpoint, and `info` in dev/staging for local development convenience. Note: this is external to the handlers stack and configured separately.

## What this doc doesn't cover

- **OpenTelemetry / distributed tracing.** Deferred in #1363; when it lands it'll live in its own doc.
- **Logs Insights dashboards and saved queries.** Worth a separate follow-up.
- **The `structured-logger.ts` API surface.** Read the JSDoc on the source — don't duplicate it here.
