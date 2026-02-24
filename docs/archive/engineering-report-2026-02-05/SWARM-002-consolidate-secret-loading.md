# SWARM-002: Consolidate Duplicated Secret-Loading Logic

**Priority:** P0 — Do Now
**Package:** `@swarm/handlers`
**Risk:** Medium — duplicated code diverges over time, bugs fixed in one copy but not others

## Worker Assignment

- **Assigned Worker:** `worker-002`
- **Branch:** `feat/swarm-002`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-002`
- **Core Mission:** Remove duplicate secret-loading implementations and make `loadAvatarSecrets()` the single production path in targeted handlers.

## Problem

Secret-loading logic is implemented independently in 3+ handler files:

1. `message-processor.ts` — `fetchAvatarSecrets()` (inline, uses raw `secretsClient.send()`)
2. `response-sender.ts` — `fetchAvatarSecrets()` (copy-pasted from above)
3. `continuation-processor.ts` — inline `secretsClient.send()` calls

Meanwhile, a comprehensive `loadAvatarSecrets()` utility already exists in `utils/load-avatar-secrets.ts` with proper fallback chains, naming convention support, and shared Twitter app credential handling. It's already used by `autonomous-tweet-poster`, `tweet-poster`, `tweet-sender`, `twitter-mention-poller-shared`, and `moltbook-heartbeat`.

## Solution

Replace the inline `fetchAvatarSecrets()` functions in `message-processor.ts`, `response-sender.ts`, and `continuation-processor.ts` with calls to the existing `loadAvatarSecrets()` utility.

## Acceptance Criteria

- [ ] `message-processor.ts` uses `loadAvatarSecrets()` instead of inline secret fetching
- [ ] `response-sender.ts` uses `loadAvatarSecrets()` instead of inline secret fetching
- [ ] `continuation-processor.ts` uses `loadAvatarSecrets()` instead of inline secret fetching
- [ ] Raw `SecretsManagerClient` import removed from handlers that no longer need it
- [ ] Existing tests still pass
- [ ] Secret loading behavior verified manually in staging
