# SWARM-010: Operational Improvements

**Priority:** P2 — Integrated
**Package:** `@swarm/infra`, `@swarm/core`

## Worker Assignment

- **Assigned Worker:** `worker-010`
- **Branch:** `feat/swarm-010`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-010`
- **Core Mission:** Improve operational resilience and maintainability by hardening failure handling and reducing deployment/admin-api change risk.

## Items

### 1. Add DLQ to EventBridge Rules
EventBridge → Lambda rules (twitter poller, tweet poster, moltbook heartbeat) have no dead-letter config. Failed invocations are silently lost.

### 2. Make LLM Timeouts Configurable
OpenRouter timeout (20s in core, 90s in handlers) and max tokens are hardcoded. Make configurable per-avatar via `config.yaml` LLM settings.

### 3. Add Router Framework to Admin API
Hand-rolled regex routing across 40+ routes is fragile. Consider Hono for lightweight Lambda-native routing with automatic OpenAPI generation.

### 4. Refactor Deploy Workflow
At 1,247 lines, `deploy.yml` is extremely hard to review. Break into reusable workflows via `workflow_call`.

## Acceptance Criteria

- [x] EventBridge rules have SQS DLQs for failed invocations
- [x] LLM timeout/max tokens configurable per avatar
- [x] Admin API uses a router framework (or at minimum extracted route handlers)
- [x] Deploy workflow split into ≤3 composable workflows
