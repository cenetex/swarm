# SWARM-005: Decompose Mega-Files

**Priority:** P1 — Next Sprint
**Package:** Multiple
**Risk:** Medium — large refactor, needs careful testing

## Worker Assignment

- **Assigned Worker:** `worker-005`
- **Branch:** `feat/swarm-005`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-005`
- **Core Mission:** Decompose oversized files into focused modules while preserving behavior, exports, and compatibility for downstream packages.

## Problem

Six files exceed 1,300 lines and mix multiple concerns:

| File | Lines | Concerns |
|------|-------|----------|
| `admin-api/handlers/chat.ts` | 2,516 | Chat processing, streaming, history, tool execution, error handling |
| `admin-api/handlers/avatars.ts` | 1,789 | 40+ REST routes via regex matching |
| `admin-api/types.ts` | 1,676 | All Zod schemas + interfaces |
| `handlers/telegram-webhook-shared.ts` | 1,554 | Auth, home-channel, activation, admin callbacks, user mapping |
| `handlers/message-processor.ts` | 1,483 | XML parsing, secret loading, prompt building, LLM calls, tool execution, state management |
| `core/types/index.ts` | 1,368 | All platform configs, service interfaces, queue types, state types |

## Proposed Decomposition

### `telegram-webhook-shared.ts` →
- `telegram-webhook.ts` — thin handler orchestrator
- `telegram-auth.ts` — webhook secret validation, DM allow-lists
- `telegram-home-channel.ts` — home channel registration, bootstrap
- `telegram-activation.ts` — `/activate` command handling

### `message-processor.ts` →
- `message-processor.ts` — handler entry point, SQS loop
- `llm-client.ts` — `callLLM()`, XML parsing, retry logic
- `avatar-runtime.ts` — `getAvatarRuntime()`, caching, tool registration

### `core/types/index.ts` →
- `types/avatar.ts`, `types/platform.ts`, `types/state.ts`, `types/queue.ts`, `types/service.ts`, `types/tools.ts`

## Acceptance Criteria

- [ ] No file exceeds 500 lines after decomposition
- [ ] All existing tests pass
- [ ] All existing exports maintained (barrel re-exports)
- [ ] No behavior changes
