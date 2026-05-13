# Swarm

Run persistent AI avatars across Telegram, Discord, and the web — with the guardrails, memory, and operational controls a real operator needs. Set up through chat. Deploy in minutes.

## Why Swarm

- **Live in minutes.** Create an AI avatar, connect it to Telegram, get your first live response — all through a guided chat interface, no config files or CLI required.
- **Persistent personality and memory.** Avatars remember conversations across sessions and platforms. Configurable memory retention with TTL, delete, and export controls.
- **Safe autonomy with clear limits.** Daily usage limits for messages, media, voice, and tool calls prevent runaway costs. Entitlement tiers (Free / Pro / Enterprise) enforce boundaries automatically.
- **Reliable by design.** Queue-based processing ensures messages are never silently dropped. Correlation IDs, structured logging, and CloudWatch dashboards give operational visibility from day one.
- **Multi-platform from a single config.** Deploy the same avatar to Telegram, Discord, X, and web with platform-specific adapters.
- **Chat-first operations.** Create avatars, configure personas, set secrets, deploy to platforms, monitor usage — all through natural language in the admin interface.

## Start Here

- **Ship or debug runtime behavior** → [AGENTS.md](AGENTS.md), then [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Understand the architecture** → Component map and diagram below
- **Pick roadmap work** → [ROADMAP.md](ROADMAP.md), [PLAN.md](PLAN.md), [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md), [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md)
- **Operate safely in production** → [docs/SECURITY.md](docs/SECURITY.md), [docs/RUNBOOK.md](docs/RUNBOOK.md)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Admin UI   │  │  Admin API  │  │  Chat Configuration     │  │
│  │  (React)    │  │  (Lambda)   │  │  (LLM + Tools)          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        RUNTIME PLANE                            │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Telegram │    │ Twitter  │    │ Discord  │    │   Web    │  │
│  │ Webhook  │    │ Poller   │    │ Gateway  │    │  Chat    │  │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘  │
│       └───────────────┴───────────────┴───────────────┘         │
│                              │                                   │
│                    ┌─────────────────┐                          │
│                    │   Message SQS   │                          │
│                    └────────┬────────┘                          │
│                    ┌─────────────────┐                          │
│                    │ Message Handler │                          │
│                    │ (LLM + Tools)   │                          │
│                    └────────┬────────┘                          │
│                    ┌─────────────────┐                          │
│                    │  Response SQS   │                          │
│                    └────────┬────────┘                          │
│                    ┌─────────────────┐                          │
│                    │ Response Sender │                          │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SHARED SERVICES                             │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐  │
│  │ Memory │ │ Media  │ │Credits │ │Wallets │ │Observability │  │
│  │DynamoDB│ │S3+Repl.│ │DynamoDB│ │Secrets │ │ CloudWatch   │  │
│  └────────┘ └────────┘ └────────┘ └────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Component Map

- **Admin UI**: [packages/admin-ui](packages/admin-ui) — React + Zustand app with wallet login, avatar sidebar, chat interface, logs panel, and tool prompts.
- **Admin API**: [packages/admin-api](packages/admin-api) — Session-authenticated API plus avatar-facing Telegram webhook, media/gallery, credits, wallets, voice tools, and config sync.
- **Runtime core**: [packages/core](packages/core) — Platform adapters, response generator, state and activity services, and tool registry used by Lambdas.
- **Handlers**: [packages/handlers](packages/handlers) — Lambda functions for inbound webhooks, SQS message processing, and outbound response sending.
- **Infra**: [packages/infra](packages/infra) — CDK app/constructs for queues, tables, buckets, and stacks.
- **MCP Server**: [packages/mcp-server](packages/mcp-server) — Unified tool registry for MCP-compatible clients and Lambda handlers.
- **Lambda Layer**: [packages/layer](packages/layer) — Shared Lambda layer with native modules (sharp) and fetch shims for Node.js 20+.
- **Profile Page**: [packages/profile-page](packages/profile-page) — Public avatar profile pages.
- **Claude Code Worker**: [packages/claude-code-worker](packages/claude-code-worker) — Agent worker that processes coding tasks using the Claude Code CLI.

## Debugging Jump Table

| Symptom | Start Here | Fast Evidence |
| --- | --- | --- |
| Telegram webhook rejects or avatar silent | [packages/handlers/src/telegram/telegram-webhook-shared.ts](packages/handlers/src/telegram/telegram-webhook-shared.ts), [docs/RUNBOOK.md](docs/RUNBOOK.md) | `./scripts/avatar-logs.sh staging <avatarId> --since 2h --level ERROR` |
| Admin chat LLM/tool calls fail | [packages/admin-api/src/handlers/chat.ts](packages/admin-api/src/handlers/chat.ts), [packages/admin-api/src/services/mcp-adapter.ts](packages/admin-api/src/services/mcp-adapter.ts) | `./scripts/test-api.sh staging chat '{"message":"debug","history":[]}'` |
| Message accepted but no outbound send | [packages/handlers/src/messaging/message-processor.ts](packages/handlers/src/messaging/message-processor.ts), [packages/handlers/src/messaging/response-sender.ts](packages/handlers/src/messaging/response-sender.ts) | `./scripts/avatar-logs.sh staging <avatarId> --since 2h --query timeout` |
| Avatar config/secrets drift | [packages/admin-api/src/services/avatars.ts](packages/admin-api/src/services/avatars.ts), [packages/admin-api/src/services/secrets.ts](packages/admin-api/src/services/secrets.ts) | `./scripts/avatar-inspect.sh staging <avatarId>` |
| Admin UI 401/403 | [packages/admin-api/src/auth](packages/admin-api/src/auth), [packages/admin-api/src/handlers/wallet-auth.ts](packages/admin-api/src/handlers/wallet-auth.ts) | `./scripts/test-api.sh staging avatars GET` |

## Quick Start

```bash
git clone https://github.com/cenetex/aws-swarm.git
cd aws-swarm
nvm use
pnpm install
pnpm build
pnpm test
```

## Commands

```bash
pnpm build        # Build all packages
pnpm lint         # Lint configured packages
pnpm typecheck    # Type-check all packages
pnpm test         # Run isolated workspace tests
pnpm cdk diff     # Preview infra changes
```

## AI Agent Onboarding

Start with [AGENTS.md](AGENTS.md). Respect the chat-first product constraint in [docs/design-philosophy.md](docs/design-philosophy.md).

## Deployment

All deployments go through GitHub Actions on push to `main`. Do **not** run `cdk deploy` locally. Staging auto-deploys on merge; production requires manual approval.

Environment variables handlers rely on: `ADMIN_TABLE`, `STATE_TABLE`, `ACTIVITY_TABLE`, `MESSAGE_QUEUE_URL`, `RESPONSE_QUEUE_URL`, `MEDIA_BUCKET`, `SECRETS_ARN`, `LLM_API_KEY_SECRET_ARN`.

## License

Code is MIT licensed. Documentation is CC0 1.0.
