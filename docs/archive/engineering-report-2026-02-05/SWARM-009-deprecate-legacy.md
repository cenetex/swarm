# SWARM-009: Deprecate Legacy Code

**Priority:** P2 — Integrated
**Package:** Multiple

## Worker Assignment

- **Assigned Worker:** `worker-009`
- **Branch:** `feat/swarm-009`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-009`
- **Core Mission:** Retire legacy code and duplicate type definitions safely, with explicit migration verification before hard removals.

## Items

### 1. Remove Legacy Monolithic Stack
`swarm-stack.ts` duplicates split-stack logic. Once all environments are migrated, remove it.

### 2. Remove Legacy Processors
`response-generator.ts` is superseded by `message-processor.ts` (unified pipeline). The barrel explicitly labels it "Legacy Processors" but it's still exported.

### 3. Remove Dead Code
- `twitter-mention-poller.ts` (not exported, superseded by `-shared` variant)
- Stale test comments ("handlers don't have tests yet" — they do now)

### 4. Resolve Dual Type Definitions
- `ToolDefinition` defined in both `core/types` and `core/processors`
- `ProcessorConfig` defined in both `core/types` and `core/processors`
- Unify into single canonical types

## Acceptance Criteria

- [x] Legacy stack removed after migration verification
- [x] Legacy processors deprecated with JSDoc `@deprecated` tags
- [x] Dead code removed
- [x] No duplicate type names across packages
