# AWS Swarm

AI avatar stack for Telegram-first social bots, with a chat-based admin UI, Solana wallet authentication, NFT gating, channel-aware webhook handler, reusable media/gallery services, and an SQS-driven processing pipeline.

## Start Here by Goal
- **Ship or debug runtime behavior**: [AGENTS.md](AGENTS.md) for triage/test workflow, then [docs/RUNBOOK.md](docs/RUNBOOK.md) and [docs/MONITORING-OPERATOR-GUIDE.md](docs/MONITORING-OPERATOR-GUIDE.md) for incidents.
- **Understand system architecture quickly**: [ARCHITECTURE.md](ARCHITECTURE.md), the component map below, then [docs/UNIFIED-AGENT-BRAIN-RFC.md](docs/UNIFIED-AGENT-BRAIN-RFC.md) for the tool/runtime model.
- **Pick roadmap work**: [ROADMAP.md](ROADMAP.md), [PLAN.md](PLAN.md), [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md), [docs/ROADMAP-M2-MULTI-PLATFORM.md](docs/ROADMAP-M2-MULTI-PLATFORM.md).
- **Operate safely in production**: [docs/SECURITY.md](docs/SECURITY.md), [docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md](docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md), and [docs/OPERATIONS-REPORTS.md](docs/OPERATIONS-REPORTS.md).

## Highlights
- **Solana Wallet Authentication**: Sign in with Phantom wallet (QR code on mobile, browser extension on desktop). NFT gating controls avatar creation and inhabitation.
- Chat-driven admin console (React) for creating and configuring avatars, syncing chat history across devices, and driving setup actions through LLM tool calls.
- Telegram webhook handler with channel-aware buffering, conversation history, deduplication, and tool use (image/video generation, voice messages, gallery replay, Solana wallets).
- Shared services for gallery, media jobs, wallet balances, voice transcription/TTS, and credit limits to keep tools safe and predictable.
- Pluggable platform adapters (Telegram/Twitter/Web) and an SQS pipeline (ingest → message-processor → response-sender) so avatars scale horizontally.
- Infrastructure packaged for AWS (DynamoDB, SQS, Secrets Manager, S3/CDN) with CDK constructs in the repo.

## Component Map
- Admin UI: [packages/admin-ui](packages/admin-ui) — React + Zustand app with wallet login, avatar sidebar, chat interface, logs panel, and tool prompts.
- Admin API: [packages/admin-api](packages/admin-api) — first-party session-authenticated API plus avatar-facing Telegram webhook, media/gallery, credits, wallets, voice tools, and config sync.
- Runtime core: [packages/core](packages/core) — Platform adapters, response generator, state and activity services, and tool registry used by Lambdas.
- Handlers: [packages/handlers](packages/handlers) — Lambda functions for inbound webhooks, SQS message processing, and outbound response sending.
- Infra: [packages/infra](packages/infra) — CDK app/constructs for queues, tables, buckets, and stacks.
- MCP Server: [packages/mcp-server](packages/mcp-server) — Unified tool registry for MCP-compatible clients and Lambda handlers.
- Lambda Layer: [packages/layer](packages/layer) — Shared Lambda layer with native modules (sharp) and fetch shims for Node.js 20+.
- Profile Page: [packages/profile-page](packages/profile-page) — Public avatar profile pages served at rati.chat.
- Claude Code Worker: [packages/claude-code-worker](packages/claude-code-worker) — Agent worker that processes coding tasks using the Claude Code CLI.

## Runtime Modes
- **Avatar webhook path**: Telegram updates hit `/webhook/telegram/{avatarId}` and can be processed with channel-aware gating plus tool execution for low-friction iteration.
- **Queue-backed runtime path**: Ingested envelopes move through SQS (`ingest -> message-processor -> response-sender`) for higher throughput and clearer operational isolation.

## Narrative: Web -> Telegram
1) **Create/configure via web**: Admin UI calls the admin API to create avatars and chat with the setup bot ([packages/admin-ui/src/api](packages/admin-ui/src/api)). Avatar metadata is stored in DynamoDB and synced to the runtime state table ([packages/admin-api/src/services/avatars.ts](packages/admin-api/src/services/avatars.ts)). Secrets are collected via tool calls and saved to Secrets Manager.
2) **Telegram webhook ingest**: Telegram sends updates to `/webhook/telegram/{avatarId}`. The handler validates the secret token/IP, deduplicates updates, loads avatar config/secrets, and enqueues work into the shared runtime ([packages/handlers/src/telegram/telegram-webhook-shared.ts](packages/handlers/src/telegram/telegram-webhook-shared.ts)).
3) **Channel-aware gating**: Messages are buffered and run through a state machine (IDLE → ACTIVE → COOLDOWN) to avoid over-replying and to group context ([packages/admin-api/src/services/channel-state.ts](packages/admin-api/src/services/channel-state.ts)).
4) **LLM + tools**: The handler calls the configured OpenRouter model with tool definitions for image/video generation, gallery lookup, and wallet info. Tool executions use media, gallery, wallet, and credit services before replying.
5) **Respond on Telegram**: Replies and media are sent via the Telegram Bot API with typing indicators and optional media uploads; gallery items can be replayed, and video generation jobs report back when ready.
6) **SQS processing path** (runtime): For deployed avatars using the shared pipeline, inbound envelopes go to the message queue, `message-processor` generates actions with the core response generator, and `response-sender` dispatches to Telegram/Twitter/Web adapters while recording activity and channel state ([packages/handlers/src/messaging/message-processor.ts](packages/handlers/src/messaging/message-processor.ts), [packages/handlers/src/messaging/response-sender.ts](packages/handlers/src/messaging/response-sender.ts)).

## Debugging Jump Table
| Symptom | Start Here | Fast Evidence |
| --- | --- | --- |
| Telegram webhook rejects requests or avatar stays silent | [packages/handlers/src/telegram/telegram-webhook-shared.ts](packages/handlers/src/telegram/telegram-webhook-shared.ts), [packages/handlers/src/telegram/webhook-security.ts](packages/handlers/src/telegram/webhook-security.ts), [docs/RUNBOOK.md](docs/RUNBOOK.md) | `./scripts/avatar-logs.sh staging <avatarId> --since 2h --level ERROR` |
| Admin chat LLM/tool calls fail | [packages/admin-api/src/handlers/chat.ts](packages/admin-api/src/handlers/chat.ts), [packages/admin-api/src/handlers/chat-llm.ts](packages/admin-api/src/handlers/chat-llm.ts), [packages/admin-api/src/services/mcp-adapter.ts](packages/admin-api/src/services/mcp-adapter.ts) | `./scripts/test-api.sh staging chat '{"message":"debug","history":[]}'` |
| Inbound message accepted but no outbound send | [packages/handlers/src/messaging/message-processor.ts](packages/handlers/src/messaging/message-processor.ts), [packages/handlers/src/messaging/response-sender.ts](packages/handlers/src/messaging/response-sender.ts), [packages/handlers/src/messaging/continuation-processor.ts](packages/handlers/src/messaging/continuation-processor.ts) | `./scripts/avatar-logs.sh staging <avatarId> --since 2h --query timeout` |
| Avatar config/secrets drift across services | [packages/admin-api/src/services/avatars.ts](packages/admin-api/src/services/avatars.ts), [packages/admin-api/src/services/config-sync.ts](packages/admin-api/src/services/config-sync.ts), [packages/admin-api/src/services/secrets.ts](packages/admin-api/src/services/secrets.ts) | `./scripts/avatar-inspect.sh staging <avatarId>` |
| Admin UI session/auth returns 401/403 | [packages/admin-api/src/auth](packages/admin-api/src/auth), [packages/admin-api/src/handlers/wallet-auth.ts](packages/admin-api/src/handlers/wallet-auth.ts), [docs/AUTHENTICATION-IMPROVEMENTS.md](docs/AUTHENTICATION-IMPROVEMENTS.md) | `./scripts/test-api.sh staging avatars GET` |

## Capabilities
- **Media tools**: Image generation (Nano Banana Pro / Flux-like), async video jobs with webhook callbacks, sticker creation, profile/reference image uploads, and gallery reuse ([packages/admin-api/src/services/media.ts](packages/admin-api/src/services/media.ts), [packages/admin-api/src/services/gallery.ts](packages/admin-api/src/services/gallery.ts)).
- **Voice messages**: Inbound voice transcription and outbound TTS with voice profiles ([packages/admin-api/src/services/voice.ts](packages/admin-api/src/services/voice.ts)).
- **Gallery + credits**: Gallery storage in DynamoDB with Twitter/sticker flags; trial credits with daily recharge for image generation ([packages/admin-api/src/services/credits.ts](packages/admin-api/src/services/credits.ts)).
- **Wallets**: Solana wallet creation, balance checks, and per-avatar wallet lists exposed to the LLM ([packages/admin-api/src/services/wallets.ts](packages/admin-api/src/services/wallets.ts)).
- **Avatar inhabitation**: NFT-gated system where users can inhabit (claim) avatars, with lineage NFT rewards for abandonment.
- **Security**: Solana wallet auth, first-party admin API sessions, webhook secret tokens, Telegram IP allowlist, and Secrets Manager for tokens/keys.

## Quick Start
```bash
git clone https://github.com/atimics/aws-swarm.git
cd aws-swarm
pnpm install
pnpm build
pnpm lint
pnpm typecheck
bun test    # optional: workspace tests
```

For security best practices, dependency management, and vulnerability handling, see [docs/SECURITY.md](docs/SECURITY.md).

## AI Agent Onboarding
- Start with [AGENTS.md](AGENTS.md) for triage flow, where-to-look debugging map, targeted tests, and high-leverage scripts.
- If using VS Code Copilot/agent workflows, also read [.github/copilot-instructions.md](.github/copilot-instructions.md) for repo-specific constraints and execution discipline.
- Respect the chat-first product constraint in [docs/design-philosophy.md](docs/design-philosophy.md): no settings pages or detached config workflows.

Roadmaps and planning:
- Milestone summary: [ROADMAP.md](ROADMAP.md)
- M1 (Paid Telegram MVP): [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)
- M2 (Multi-platform): [docs/ROADMAP-M2-MULTI-PLATFORM.md](docs/ROADMAP-M2-MULTI-PLATFORM.md)
- Next-milestone task list: [PLAN.md](PLAN.md)
- Automated cost/activity reporting: [docs/OPERATIONS-REPORTS.md](docs/OPERATIONS-REPORTS.md)

Local dev expects AWS credentials and the core tables/buckets configured (see CDK stacks in [packages/infra](packages/infra)). Environment variables most handlers rely on: `ADMIN_TABLE`, `STATE_TABLE`, `ACTIVITY_TABLE`, `MESSAGE_QUEUE_URL`, `RESPONSE_QUEUE_URL`, `MEDIA_BUCKET`, `SECRETS_ARN`, and `LLM_API_KEY_SECRET_ARN`.

## Deployment Notes
- All deployments happen through GitHub Actions on push to `main`. Do **not** run `cdk deploy` locally. See the [deploy workflow](.github/workflows/deploy.yml) and [CLAUDE.md](CLAUDE.md) for details.
- Staging auto-deploys on merge to main; production requires manual approval in the Actions UI.
- CDK stacks are defined in [packages/infra](packages/infra). Run `pnpm cdk diff` locally to preview changes before pushing.
- Avatar-specific secrets (e.g., `TELEGRAM_BOT_TOKEN`) are stored per avatar in Secrets Manager and synced by the admin API.
- Webhooks are registered with Telegram using per-avatar secret tokens ([packages/admin-api/src/services/telegram.ts](packages/admin-api/src/services/telegram.ts)).

## Commands
```bash
pnpm build        # Build all packages
pnpm dev          # Optional: package-level watch
pnpm lint         # Lint configured packages
pnpm typecheck    # Type-check all packages
bun test          # Run tests
pnpm cdk diff     # Preview infra changes
pnpm synth        # Synthesize infra templates
```

## License

Code is MIT licensed (see `LICENSE`). Documentation, schemas, and reference data are dedicated to the public domain under CC0 1.0 (see `LICENSE-CC0-1.0`).
