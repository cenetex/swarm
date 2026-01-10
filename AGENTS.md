# Repository Guidelines

## Project Structure & Module Organization
- `packages/` hosts the main modules: `core` (shared runtime), `handlers` (Lambda entrypoints), `admin-api`, `admin-ui`, and `infra` (CDK).
- `agents/` contains per-agent configs like `agents/<agent-id>/config.yaml` and `agents/<agent-id>/persona.md`.
- `scripts/` holds helper scripts (ex: `scripts/test-persona.mjs`).
- Tests live alongside packages as `packages/**/*.test.ts`.

## Build, Test, and Development Commands
- `pnpm install` installs workspace dependencies.
- `pnpm build` builds all packages (`pnpm -r build`).
- `pnpm dev` runs package dev/watch tasks in parallel.
- `pnpm test` runs Vitest across packages.
- `pnpm lint` runs ESLint where configured (ex: `packages/core`, `packages/admin-ui`).
- `pnpm cdk diff` or `pnpm synth` previews infra changes via `@swarm/infra`.
- Deployments are typically handled via GitHub Actions; only run `pnpm deploy:dev`/`pnpm deploy:prod` if explicitly requested.

## Coding Style & Naming Conventions
- TypeScript, ES2022, ESM (`import ... from './file.js'`); `tsconfig.base.json` enforces strictness and no unused locals/params.
- Use 2-space indentation and match the existing file style.
- Prefer `camelCase` for variables/functions and `PascalCase` for types/classes.
- Agent folder names should be kebab-case IDs that match runtime agent IDs.

## Testing Guidelines
- Vitest is configured in `vitest.config.ts` with test files matching `packages/**/*.test.ts`.
- Coverage uses the V8 provider and targets `packages/*/src/**/*.ts` (infra/admin-ui are excluded by default).
- Name new tests `*.test.ts` and keep them near the package they validate.

## Commit & Pull Request Guidelines
- Use Conventional Commits with package scopes, e.g. `feat(admin-api): add wallet tool`.
- Branches follow `<type>/issue-<number>-<short-description>` (ex: `fix/issue-42-dynamo-query`).
- Reference issues in commit bodies or PR descriptions; PR titles should follow the same commit convention.
- Use the PR template, describe changes and tests, and expect squash merges to `main`.

## Security & Configuration Tips
- Never commit secrets; use AWS Secrets Manager and environment variables (ex: `ADMIN_TABLE`, `STATE_TABLE`, `MESSAGE_QUEUE_URL`).
- Local dev expects AWS credentials and the CDK-managed tables/queues/buckets to exist.
