# Copilot Instructions for AWS Swarm

Follow these repo-specific rules when generating code or debugging issues.

## Primary References
- `AGENTS.md` — avatar quickstart, triage flow, debugging commands, and script index.
- `README.md` — component map and request flow.
- `ARCHITECTURE.md` — control plane/runtime/shared-services architecture.
- `docs/RUNBOOK.md` — incident response + DLQ/webhook recovery.
- `docs/design-philosophy.md` — **chat-first** UX constraints.

## Non-Negotiable Product Constraint
- This product is chat-first.
- Do not introduce settings pages, detached config wizards, or modal-first setup flows.
- Prefer inline chat prompts/tool UIs for all configuration and management actions.

## Codebase Map
- `packages/core` — shared runtime and types.
- `packages/handlers` — webhook + queue Lambda handlers.
- `packages/admin-api` — admin/chat API handlers and services.
- `packages/admin-ui` — React UI.
- `packages/infra` — CDK infrastructure.
- `packages/mcp-server` — shared tool registry and MCP server.

## Build/Test Workflow
1. `pnpm install`
2. `pnpm build`
3. Targeted validation first:
   - `pnpm lint`
   - `pnpm typecheck`
   - focused tests (`bun test <file>` or package filter)
4. Run broader tests only after focused checks pass.

## Debugging Workflow
1. Reproduce with smallest scope (single package/file test).
2. For API/runtime issues, gather evidence with scripts:
   - `./scripts/test-api.sh`
   - `./scripts/avatar-logs.sh`
   - `./scripts/avatar-inspect.sh`
3. For Telegram webhook issues, inspect:
   - `packages/handlers/src/telegram-webhook-shared.ts`
   - `packages/handlers/src/webhook-security.ts`
   - `docs/RUNBOOK.md`
4. For admin LLM/tool issues, inspect:
   - `packages/admin-api/src/handlers/chat.ts`
   - `packages/admin-api/src/handlers/chat-llm.ts`
   - `packages/admin-api/src/handlers/chat-tool-helpers.ts`
   - `packages/mcp-server/src/`

## Change Discipline
- Keep edits minimal, package-scoped, and directly tied to the issue.
- Fix root causes over superficial patches.
- Avoid unrelated refactors while debugging.
- Never commit/log secrets.
- Do not run deploy commands unless explicitly requested.

## Style/Conventions
- TypeScript + ESM imports with `.js` extensions in source imports.
- 2-space indentation.
- Strict typing (respect existing tsconfig/lint rules).
- Tests live near code as `*.test.ts`.

## PR/Commit Expectations
- Conventional commits with scope (`fix(admin-api): ...`).
- Include: repro, root cause, validation commands, and any docs/runbook updates.
