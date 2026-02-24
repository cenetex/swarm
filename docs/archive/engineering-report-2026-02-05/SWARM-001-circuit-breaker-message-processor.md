# SWARM-001: Add Circuit Breaker to Message Processor LLM Calls

**Priority:** P0 — Do Now
**Package:** `@swarm/handlers`
**Risk:** High — without this, a slow/down OpenRouter exhausts all 20 reserved Lambda concurrency slots at 90s each

## Worker Assignment

- **Assigned Worker:** `worker-001`
- **Branch:** `feat/swarm-001`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-001`
- **Core Mission:** Add shared circuit-breaker protection to handler LLM calls so downstream outages fail fast instead of exhausting Lambda concurrency.

## Problem

The message processor (`message-processor.ts`) calls OpenRouter with a 90-second timeout but no circuit breaker. If OpenRouter is consistently slow or returning errors, every Lambda invocation burns 90 seconds before timing out, quickly exhausting the reserved concurrency (20). This causes a cascading failure where no messages can be processed.

The `admin-api` package already has a well-tested `createCircuitBreaker()` in `services/circuit-breaker.ts` that implements closed → open → half-open state transitions.

## Solution

1. Move `createCircuitBreaker` from `admin-api` into `@swarm/core` so both packages can use it
2. Add a per-model circuit breaker to the `callLLM` function in `message-processor.ts`
3. When the circuit is open, fail fast and report the message as a batch failure (SQS will retry after visibility timeout)

## Acceptance Criteria

- [ ] `createCircuitBreaker` is available from `@swarm/core`
- [ ] `callLLM()` checks circuit breaker before making HTTP request
- [ ] 3 consecutive failures trip the circuit open
- [ ] Half-open after 30 seconds, allowing one probe request
- [ ] Successful probe closes the circuit
- [ ] Structured log emitted when circuit trips: `{ event: 'circuit_breaker_tripped', subsystem: 'llm' }`
- [ ] Batch item reported as failure when circuit is open (SQS retries later)
