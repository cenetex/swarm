# Repository guidelines

## How work starts

A clear request in chat, an issue, or a pull request is enough authorization to
begin normal development. A GitHub issue is helpful for backlog work but is not
required. Do not stop for missing labels, fields, acceptance-criteria templates,
WIP slots, or separate approval records.

For code changes:

1. Work on a branch and open a pull request.
2. Run the smallest useful checks while iterating.
3. Run the relevant broader checks before merge.
4. Merge when GitHub reports the pull request ready.
5. Let the merge deploy, then check production health.
6. Fix forward or roll back if the deployment is unhealthy.

Developers and coding agents may create or update pull requests, merge, deploy,
verify, and roll back. GitHub's pull request, checks, deployment, and commit
history are the audit trail. Extra review labels, hold periods, evidence forms,
and release tickets are not required.

Ask for human input only when a choice is materially ambiguous or an action is
irreversible, affects outside parties, spends unbounded money, or risks secrets
or data loss.

## Project structure

- `packages/core`: shared runtime.
- `packages/handlers`: Lambda entrypoints and message pipeline.
- `packages/admin-api`: API handlers and services.
- `packages/admin-ui`: operator UI.
- `packages/infra`: CDK.
- `packages/mcp-server`: tool definitions and registry.
- `scripts`: build, test, diagnosis, and operations helpers.
- Tests live beside code as `packages/**/*.test.ts`.

## Build and test

- `pnpm install`: install workspace dependencies.
- `pnpm build`: build all packages.
- `pnpm lint`: lint configured packages.
- `pnpm typecheck`: type-check the workspace.
- `pnpm test` or `bun test`: run workspace tests.
- Prefer a package or single-test command while iterating, then expand checks in
  proportion to the change.

Useful focused commands:

- `pnpm --filter @swarm/core test`
- `pnpm --filter @swarm/handlers test`
- `pnpm --filter @swarm/admin-api test`
- `pnpm --filter @swarm/admin-ui test`
- `bun test packages/handlers/src/telegram/telegram-webhook-shared.test.ts`

## Code style

- TypeScript, ES2022, ESM.
- Use 2-space indentation and match nearby code.
- Prefer `camelCase` for values/functions and `PascalCase` for types/classes.
- Keep changes cohesive. A useful adjacent fix may stay in the same pull request
  when it lowers risk or completes the requested behavior.
- Use Conventional Commits when practical; do not block useful work on wording.
- Preserve the chat-first product experience.

## Security and operations

- Never commit or print secrets. Use AWS Secrets Manager and environment
  variables.
- Model workers must not receive ambient production credentials.
- Production deployment is allowed when the request implies shipping the
  change. Prefer the normal GitHub workflow; a direct local deploy is acceptable
  when it is the established fastest recovery path and the target is verified.
- Use bounded, reversible actions. Check the AWS account and environment before
  mutation.
- Deployment must include a health check. Roll back or fix forward on failure.

## Debugging map

- Telegram: `packages/handlers/src/telegram/`
- Admin chat and tools: `packages/admin-api/src/handlers/chat.ts`,
  `packages/admin-api/src/services/mcp-adapter.ts`
- Message pipeline: `packages/handlers/src/messaging/`
- Avatar config and secrets: `packages/admin-api/src/services/avatars.ts`,
  `packages/admin-api/src/services/secrets.ts`
- Auth/session: `packages/admin-api/src/auth/`
- Operations: `docs/RUNBOOK.md`

Useful tools:

- `scripts/avatar-logs.sh`: consolidated avatar logs.
- `scripts/avatar-inspect.sh`: avatar state and integration snapshot.
- `scripts/test-api.sh`: direct API checks.
- `scripts/smoke-admin-ui.mjs`: UI smoke checks.

## Done

Work is done when the requested behavior is implemented, relevant checks pass,
no secrets are exposed, the pull request is merged, and any requested or
automatic deployment is healthy. Put concise context and test results in the
pull request; do not require the human to fill out paperwork the system already
knows.
