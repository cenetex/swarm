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

## Logs & Debugging

### Consolidated Logs Endpoint
Each agent has a logs endpoint: `GET /agents/{agentId}/logs`

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | string | Filter by log level (`ERROR`, `WARN`, `INFO`, `DEBUG`) |
| `subsystem` | string | Filter by component (`telegram`, `llm`, `state`, etc.) |
| `since` | string | Relative time (e.g., `30m`, `2h`, `1d`) |
| `start` | number | Start timestamp (ms since epoch) |
| `end` | number | End timestamp (ms since epoch) |
| `limit` | number | Max results (default 200, max 500) |
| `query` | string | Free-text search in log messages |

**Example:**
```bash
# Get last 30 minutes of ERROR logs for an agent
curl "https://api.rati.chat/agents/my-agent/logs?level=ERROR&since=30m"

# Search for specific text in last hour
curl "https://api.rati.chat/agents/my-agent/logs?query=timeout&since=1h"
```

**Response:**
```json
{
  "agentId": "my-agent",
  "startTime": 1736531232000,
  "endTime": 1736533032000,
  "logGroups": ["/aws/lambda/my-agent-webhook", "/aws/lambda/AdminApiChatHandler..."],
  "filters": { "level": "ERROR", "limit": 200 },
  "events": [
    { "timestamp": "2026-01-10T19:07:12.531Z", "message": "...", "logGroup": "...", "logStream": "..." }
  ]
}
```

### AWS CLI Log Commands
```bash
# List log groups for admin API
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/SwarmStack-staging-AdminApi"

# Tail recent logs
aws logs filter-log-events \
  --log-group-name "/aws/lambda/SwarmStack-staging-AdminApiChatHandler..." \
  --start-time $(($(date +%s) * 1000 - 300000)) \
  --query 'events[*].message' --output text

# Search for errors
aws logs filter-log-events \
  --log-group-name "/aws/lambda/..." \
  --filter-pattern "ERROR" \
  --limit 20
```

### Common Issues
- **400 on `/chat`**: Check Zod validation - request body must have `message` (string) and `history` (array)
- **403 Forbidden**: Cloudflare Access JWT missing or invalid; check `CF-Access-JWT-Assertion` header
- **DynamoDB reserved keywords**: Use expression attribute names for reserved words like `ttl` → `#ttl`
