git clone https://github.com/your-org/aws-swarm.git
pnpm cdk bootstrap
# AWS Swarm

AI agent stack for Telegram-first social bots, with a chat-based admin UI, Solana wallet authentication, NFT gating, channel-aware webhook handler, reusable media/gallery services, and an SQS-driven processing pipeline.

## Highlights
- **Solana Wallet Authentication**: Sign in with Phantom wallet (QR code on mobile, browser extension on desktop). NFT gating controls agent creation and inhabitation.
- Chat-driven admin console (React) for creating and configuring agents, syncing chat history across devices, and driving setup actions through LLM tool calls.
- Telegram webhook handler with channel-aware buffering, conversation history, deduplication, and tool use (image/video generation, voice messages, gallery replay, Solana wallets).
- Shared services for gallery, media jobs, wallet balances, voice transcription/TTS, and credit limits to keep tools safe and predictable.
- Pluggable platform adapters (Telegram/Twitter/Web) and an SQS pipeline (ingest → message-processor → response-sender) so agents scale horizontally.
- Infrastructure packaged for AWS (DynamoDB, SQS, Secrets Manager, S3/CDN) with CDK constructs in the repo.

## Component Map
- Admin UI: [packages/admin-ui](packages/admin-ui) — React + Zustand app with wallet login, agent sidebar, chat interface, logs panel, and tool prompts.
- Admin API: [packages/admin-api](packages/admin-api) — Cloudflare Access–protected API plus agent-facing Telegram webhook, media/gallery, credits, wallets, voice tools, and config sync.
- Runtime core: [packages/core](packages/core) — Platform adapters, response generator, state and activity services, and tool registry used by Lambdas.
- Handlers: [packages/handlers](packages/handlers) — Lambda functions for inbound webhooks, SQS message processing, and outbound response sending.
- Infra: [packages/infra](packages/infra) — CDK app/constructs for queues, tables, buckets, and stacks.
- MCP Server: [packages/mcp-server](packages/mcp-server) — Unified tool registry for MCP-compatible clients and Lambda handlers.

## Web → Telegram Flow
1) **Create/configure via web**: Admin UI calls the admin API to create agents and chat with the setup bot ([packages/admin-ui/src/api](packages/admin-ui/src/api)). Agent metadata is stored in DynamoDB and synced to the runtime state table ([packages/admin-api/src/services/agents.ts](packages/admin-api/src/services/agents.ts)). Secrets are collected via tool calls and saved to Secrets Manager.
2) **Telegram webhook ingest**: Telegram sends updates to `/webhook/telegram/{agentId}`. The handler validates the secret token/IP, deduplicates updates, loads agent config/secrets, and persists per-chat history ([packages/admin-api/src/handlers/telegram-webhook.ts](packages/admin-api/src/handlers/telegram-webhook.ts)).
3) **Channel-aware gating**: Messages are buffered and run through a state machine (IDLE → ACTIVE → COOLDOWN) to avoid over-replying and to group context ([packages/admin-api/src/services/channel-state.ts](packages/admin-api/src/services/channel-state.ts)).
4) **LLM + tools**: The handler calls the configured OpenRouter model with tool definitions for image/video generation, gallery lookup, and wallet info. Tool executions use media, gallery, wallet, and credit services before replying.
5) **Respond on Telegram**: Replies and media are sent via the Telegram Bot API with typing indicators and optional media uploads; gallery items can be replayed, and video generation jobs report back when ready.
6) **SQS processing path** (runtime): For deployed agents using the shared pipeline, inbound envelopes go to the message queue, `message-processor` generates actions with the core response generator, and `response-sender` dispatches to Telegram/Twitter/Web adapters while recording activity and channel state ([packages/handlers/src/message-processor.ts](packages/handlers/src/message-processor.ts), [packages/handlers/src/response-sender.ts](packages/handlers/src/response-sender.ts)).

## Capabilities
- **Media tools**: Image generation (Nano Banana Pro / Flux-like), async video jobs with webhook callbacks, sticker creation, profile/reference image uploads, and gallery reuse ([packages/admin-api/src/services/media.ts](packages/admin-api/src/services/media.ts), [packages/admin-api/src/services/gallery.ts](packages/admin-api/src/services/gallery.ts)).
- **Voice messages**: Inbound voice transcription and outbound TTS with voice profiles ([packages/admin-api/src/services/voice.ts](packages/admin-api/src/services/voice.ts)).
- **Gallery + credits**: Gallery storage in DynamoDB with Twitter/sticker flags; trial credits with daily recharge for image generation ([packages/admin-api/src/services/credits.ts](packages/admin-api/src/services/credits.ts)).
- **Wallets**: Solana wallet creation, balance checks, and per-agent wallet lists exposed to the LLM ([packages/admin-api/src/services/wallets.ts](packages/admin-api/src/services/wallets.ts)).
- **Agent inhabitation**: NFT-gated system where users can inhabit (claim) agents, with lineage NFT rewards for abandonment.
- **Security**: Solana wallet auth, Cloudflare Access on admin API, webhook secret tokens, Telegram IP allowlist, and Secrets Manager for tokens/keys.

## Quick Start
```bash
pnpm install
pnpm build
pnpm test   # optional: runs package tests
```

Local dev expects AWS credentials and the core tables/buckets configured (see CDK stacks in [packages/infra](packages/infra)). Environment variables most handlers rely on: `ADMIN_TABLE`, `STATE_TABLE`, `ACTIVITY_TABLE`, `MESSAGE_QUEUE_URL`, `RESPONSE_QUEUE_URL`, `MEDIA_BUCKET`, `SECRETS_ARN`, and `LLM_API_KEY_SECRET_ARN`.

## Deployment Notes
- Bootstrap and deploy CDK stacks from [packages/infra](packages/infra) for shared resources.
- Agent-specific secrets (e.g., `TELEGRAM_BOT_TOKEN`) are stored per agent in Secrets Manager and synced by the admin API.
- Webhooks are registered with Telegram using per-agent secret tokens ([packages/admin-api/src/services/telegram.ts](packages/admin-api/src/services/telegram.ts)).

## Commands
```bash
pnpm build        # Build all packages
pnpm test         # Run tests
pnpm dev          # Optional: package-level watch
pnpm cdk diff     # Preview infra changes
pnpm cdk deploy   # Deploy stacks (see infra package scripts)
```

## License

Code is MIT licensed (see `LICENSE`). Documentation, schemas, and reference data are dedicated to the public domain under CC0 1.0 (see `LICENSE-CC0-1.0`).
