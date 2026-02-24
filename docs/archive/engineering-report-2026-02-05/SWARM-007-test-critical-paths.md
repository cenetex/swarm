# SWARM-007: Test Critical Untested Paths

**Priority:** P1 — Next Sprint
**Package:** Multiple
**Risk:** Low — additive, no runtime changes

## Worker Assignment

- **Assigned Worker:** `worker-007`
- **Branch:** `feat/swarm-007`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-007`
- **Core Mission:** Raise confidence on critical runtime paths by adding high-value tests where outages and regressions are currently least detectable.

## Problem

The most critical runtime paths lack test coverage:

1. **LLM service** (`core/services/llm/`) — Retry logic, provider fallback, error handling — zero tests
2. **Avatars handler** (`admin-api/handlers/avatars.ts`) — 1,789 lines, 40+ routes — zero tests
3. **Discord adapter** (`core/platforms/discord.ts`) — 778 lines — zero tests
4. **claude-code-worker** — entire package — zero tests

## Solution

### Phase 1: LLM Service Tests
- Test retry with exponential backoff
- Test provider fallback (OpenRouter → Bedrock → Anthropic)
- Test `RetryableLLMService` circuit-breaking behavior
- Mock HTTP responses, don't hit real APIs

### Phase 2: Avatars Handler Tests
- Test CRUD operations with mocked DynamoDB
- Test authorization (wallet ownership, admin checks)
- Test input validation (Zod schemas)
- Test error responses (404, 403, 400)

### Phase 3: Discord + Claude Code Worker
- Discord adapter: test message formatting, command parsing
- Claude Code Worker: test SQS polling, job status transitions, NDJSON parsing

## Acceptance Criteria

- [ ] LLM service has ≥80% branch coverage
- [ ] Avatars handler has tests for all CRUD routes + auth
- [ ] Discord adapter has parity with Telegram adapter tests
- [ ] Coverage thresholds (SWARM-004) pass after these additions
