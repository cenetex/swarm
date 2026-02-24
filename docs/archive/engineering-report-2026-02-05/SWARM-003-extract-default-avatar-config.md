# SWARM-003: Extract Default Avatar Config to Shared Constant

**Priority:** P0 — Do Now
**Package:** `@swarm/core`, `@swarm/handlers`
**Risk:** Low — mechanical refactor with high DRY payoff

## Worker Assignment

- **Assigned Worker:** `worker-003`
- **Branch:** `feat/swarm-003`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-003`
- **Core Mission:** Define and adopt one canonical `DEFAULT_AVATAR_CONFIG` to eliminate default drift across handler runtime paths.

## Problem

Every handler that resolves avatar config has its own inline 20-line fallback object with identical default values (LLM model, behavior settings, media config, tool lists). These objects in `message-processor.ts` and `response-sender.ts` are nearly identical but already show minor divergence (different tool lists, different secret lists).

## Solution

1. Add a `DEFAULT_AVATAR_CONFIG` constant to `@swarm/core/constants.ts`
2. Replace all inline fallback objects with `{ ...DEFAULT_AVATAR_CONFIG, id: avatarId, name: ... }`
3. Use spread to allow handler-specific overrides where needed

## Acceptance Criteria

- [ ] `DEFAULT_AVATAR_CONFIG` exported from `@swarm/core`
- [ ] `message-processor.ts` uses `DEFAULT_AVATAR_CONFIG` for fallback
- [ ] `response-sender.ts` uses `DEFAULT_AVATAR_CONFIG` for fallback
- [ ] Any future handler can import the same default
- [ ] Existing tests pass
