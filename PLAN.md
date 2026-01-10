# AWS Social Media Agent Swarm - Architecture Plan

---

## Implementation Status

> **Last Updated:** 2025-01-09

### Overall Progress

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo Setup | DONE | pnpm workspaces, TypeScript configs |
| Core Types | DONE | Comprehensive type definitions |
| Platform Adapters | PARTIAL | Telegram done, Twitter/Web stubs, Discord missing |
| Processors | DONE | Evaluator, Generator, OutboundSender complete |
| Services | DONE | State, Activity, LLM (with retry), Secrets complete |
| Handlers | DONE | All handlers implemented |
| Infrastructure (CDK) | DONE | Full stack with shared + per-agent resources |
| Agent Templates | DONE | Template config.yaml and persona.md |
| Agent Configs | NOT STARTED | No real agents configured yet |
| Tests | NOT STARTED | No test coverage |

### Critical Path to MVP

```
[x] Types & Interfaces
[x] Telegram Adapter
[x] Message Evaluator
[x] Response Generator
[x] State Service (DynamoDB)
[x] LLM Service (Bedrock, OpenRouter, Anthropic + retry)
[x] Message Processor Handler (SQS consumer)
[x] Outbound Sender (execute response actions)
[x] Response Sender Handler
[x] CDK Infrastructure (SharedInfrastructure + AgentConstruct)
[x] Tool Definitions (send_message, react, ignore, wait, take_selfie)
[x] Agent Template
[ ] First real agent config (firehorse, kyro, etc.)
[ ] End-to-end Telegram test
[ ] Deploy to AWS
```

---

## Known Issues & Bugs

### Resolved

1. ~~**`state.ts` - Invalid DynamoDB Query**~~ **FIXED**
   - Changed from Query to Scan with FilterExpression
   - GSI added in CDK infrastructure for better performance

2. ~~**`llm/index.ts` - Placeholder Zod Schema Conversion**~~ **FIXED**
   - Added `zod-to-json-schema` package
   - Proper schema conversion implemented

3. ~~**`llm/index.ts` - Wrong Anthropic Provider**~~ **FIXED**
   - Dedicated `AnthropicLLMService` using `@anthropic-ai/sdk`

4. ~~**No retry/fallback logic for LLM calls**~~ **FIXED**
   - `RetryableLLMService` wrapper with exponential backoff + jitter

5. ~~**`isReplyToBot()` always returns false**~~ **FIXED**
   - Channel state lookup + Telegram raw message parsing

6. ~~**Missing DLQ handling**~~ **FIXED**
   - DLQ configured in CDK AgentConstruct for all queues

### Remaining Issues

7. **Platform adapters incomplete**
   - `TwitterAdapter` - stub only, needs full implementation
   - `WebAdapter` - stub only, needs full implementation
   - `DiscordAdapter` - completely missing

8. **Media service minimal**
   - Image/video generation not fully implemented

---

## File Structure with Status

```
aws-swarm/
├── README.md                            # [ ] NOT CREATED
├── package.json                         # [x] DONE
├── pnpm-workspace.yaml                  # [x] DONE
├── tsconfig.base.json                   # [x] DONE
│
├── agents/
│   └── .template/                       # [x] DONE
│       ├── config.yaml                  # Template for agent config
│       ├── persona.md                   # Template for agent persona
│       └── README.md
│
├── packages/infra/                      # [x] DONE
│   ├── package.json                     # [x] DONE
│   ├── tsconfig.json                    # [x] DONE
│   ├── bin/
│   │   └── swarm.ts                     # [x] DONE - CDK entry point
│   └── src/
│       ├── index.ts                     # [x] DONE
│       ├── stacks/
│       │   ├── index.ts                 # [x] DONE
│       │   └── swarm-stack.ts           # [x] DONE - Main stack
│       └── constructs/
│           ├── index.ts                 # [x] DONE
│           ├── shared.ts                # [x] DONE - DynamoDB, S3, CloudFront, Layer
│           └── agent.ts                 # [x] DONE - SQS, API Gateway, Lambdas
│
├── packages/core/
│   ├── package.json                     # [x] DONE
│   ├── tsconfig.json                    # [x] DONE
│   └── src/
│       ├── index.ts                     # [x] DONE
│       ├── types/
│       │   └── index.ts                 # [x] DONE - Comprehensive types
│       ├── platforms/
│       │   ├── base.ts                  # [x] DONE - PlatformAdapter + Registry
│       │   ├── index.ts                 # [x] DONE
│       │   ├── telegram.ts              # [x] DONE - Full implementation
│       │   ├── twitter.ts               # [~] STUB - Needs implementation
│       │   ├── web.ts                   # [~] STUB - Needs implementation
│       │   └── discord.ts               # [ ] MISSING
│       ├── processors/
│       │   ├── index.ts                 # [x] DONE
│       │   ├── message-evaluator.ts     # [x] DONE
│       │   ├── response-generator.ts    # [x] DONE
│       │   └── outbound-sender.ts       # [x] DONE
│       ├── services/
│       │   ├── index.ts                 # [x] DONE
│       │   ├── state.ts                 # [x] DONE
│       │   ├── activity.ts              # [x] DONE
│       │   ├── secrets.ts               # [x] DONE
│       │   ├── llm/
│       │   │   └── index.ts             # [x] DONE - Bedrock, OpenRouter, Anthropic + retry
│       │   ├── media/
│       │   │   └── index.ts             # [~] STUB - Minimal implementation
│       │   └── solana/
│       │       └── index.ts             # [~] STUB - Minimal implementation
│       └── utils/
│           ├── index.ts                 # [x] DONE
│           ├── logger.ts                # [x] DONE
│           └── config.ts                # [x] DONE
│
└── packages/handlers/
    ├── package.json                     # [x] DONE
    ├── tsconfig.json                    # [x] DONE
    └── src/
        ├── index.ts                     # [x] DONE
        ├── telegram-webhook.ts          # [x] DONE - Full implementation
        ├── message-processor.ts         # [x] DONE - Full implementation with tools
        ├── response-sender.ts           # [x] DONE - Full implementation
        ├── tweet-poster.ts              # [~] STUB
        └── web-chat.ts                  # [~] STUB
```

**Legend:** `[x]` Done | `[~]` Partial/Stub | `[ ]` Not Started

---

## What's Working

### Complete Pipeline (Telegram)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Gateway   │────▶│ telegram-webhook│────▶│  message-queue  │
│  POST /webhook  │     │    (Lambda)     │     │   (SQS FIFO)    │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                        ┌─────────────────┐              │
                        │message-processor│◀─────────────┘
                        │    (Lambda)     │
                        │ - Load config   │
                        │ - Call LLM      │
                        │ - Generate resp │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │ response-queue  │
                        │   (SQS FIFO)    │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐     ┌─────────────────┐
                        │ response-sender │────▶│    Telegram     │
                        │    (Lambda)     │     │      API        │
                        └─────────────────┘     └─────────────────┘
```

### CDK Resources Created

**Shared (per environment):**
- DynamoDB: `swarm-state-{env}` (with GSI)
- DynamoDB: `swarm-activity-{env}`
- S3: `swarm-media-{env}-{account}`
- CloudFront distribution (prod only)
- Lambda Layer with dependencies

**Per Agent:**
- SQS: `{agentId}-messages.fifo`
- SQS: `{agentId}-responses.fifo`
- SQS: `{agentId}-media`
- SQS: `{agentId}-dlq.fifo`
- API Gateway: `{agentId}-api`
- Lambda: `{agentId}-telegram-webhook`
- Lambda: `{agentId}-message-processor`
- Lambda: `{agentId}-response-sender`
- Lambda: `{agentId}-web-chat` (if enabled)
- Lambda: `{agentId}-tweet-poster` (if scheduled)
- EventBridge rule for tweet schedule
- Secrets Manager: `swarm/{agentId}/secrets`

---

## Next Steps (Prioritized)

### Immediate (Deploy First Agent)

1. **Create First Agent Config**
   - [ ] Copy `.template/` to `agents/firehorse/`
   - [ ] Customize config.yaml with real values
   - [ ] Write persona.md with character definition
   - [ ] Create secrets in AWS Secrets Manager

2. **Build & Deploy**
   - [ ] `pnpm install && pnpm build`
   - [ ] `cd packages/infra && cdk deploy --context environment=dev`
   - [ ] Set Telegram webhook URL
   - [ ] Test end-to-end flow

### Short-term (Polish)

3. **Complete Twitter Adapter**
   - [ ] Implement `parseIncomingMessage()`
   - [ ] Implement `executeAction()` for tweets, replies, retweets
   - [ ] Implement mention polling handler
   - [ ] Test scheduled tweets

4. **Complete Web Adapter**
   - [ ] Implement `parseIncomingMessage()`
   - [ ] Implement `executeAction()`
   - [ ] Add token gating logic (Solana)
   - [ ] Test web chat endpoint

5. **Media Generation**
   - [ ] Implement OpenRouter image generation
   - [ ] Implement Replicate video generation
   - [ ] Create media-processor handler

6. **Testing**
   - [ ] Unit tests for MessageEvaluator
   - [ ] Unit tests for ResponseGenerator
   - [ ] Integration tests with local DynamoDB
   - [ ] End-to-end test script

### Medium-term (Additional Platforms)

7. **Discord Adapter**
   - [ ] Create DiscordAdapter class
   - [ ] Decide: Interaction webhooks vs Gateway (ECS Fargate)
   - [ ] Implement slash commands

8. **Observability**
   - [ ] CloudWatch dashboards
   - [ ] X-Ray tracing
   - [ ] CloudWatch alarms

9. **CLI Tool**
   - [ ] `swarm agent create <name>`
   - [ ] `swarm agent deploy <name>`
   - [ ] `swarm secrets set <agent> <key> <value>`

---

## Deployment Commands

```bash
# Build everything
pnpm install
pnpm build

# Deploy to dev
cd packages/infra
cdk bootstrap  # First time only
cdk deploy --context environment=dev

# Deploy specific agent
cdk deploy --context environment=dev --context agents=firehorse

# Deploy to prod
cdk deploy --context environment=prod

# Set Telegram webhook (after deploy)
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "<API_GATEWAY_URL>/webhook/telegram/<AGENT_ID>"}'
```

---

## Architecture Diagrams

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           AWS SWARM ARCHITECTURE                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                          AGENT REGISTRY                                      │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │ │
│  │  │ FireHorse │  │   Kyro    │  │  Ratibot  │  │  Mirquo   │  + New Agents   │ │
│  │  │ persona/  │  │ persona/  │  │ persona/  │  │ persona/  │                 │ │
│  │  │ config    │  │ config    │  │ config    │  │ config    │                 │ │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘                 │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│  ┌───────────────────────────────────▼──────────────────────────────────────────┐│
│  │                       PLATFORM ADAPTERS (Shared)                              ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       ││
│  │  │ Telegram │  │ Discord  │  │ X/Twitter│  │   Web    │  │ Farcaster│       ││
│  │  │ [DONE]   │  │ [TODO]   │  │  [STUB]  │  │  [STUB]  │  │ [FUTURE] │       ││
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘       ││
│  └───────┼─────────────┼─────────────┼─────────────┼────────────────────────────┘│
│          │             │             │             │                              │
│          ▼             ▼             ▼             ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      MESSAGE ROUTER (API Gateway)                            │ │
│  │   POST /webhook/{platform}/{agent_id}  →  Route to correct agent context    │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         PROCESSING PIPELINE                                  │ │
│  │                                                                               │ │
│  │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                │ │
│  │  │ message-queue │───▶│ response-queue│───▶│  media-queue  │                │ │
│  │  │  (SQS FIFO)   │    │  (SQS FIFO)   │    │    (SQS)      │                │ │
│  │  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘                │ │
│  │          │                    │                    │                         │ │
│  │          ▼                    ▼                    ▼                         │ │
│  │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                │ │
│  │  │   Evaluator   │    │ ResponseSender│    │ MediaProcessor│                │ │
│  │  │   + LLM Gen   │    │   (Lambda)    │    │   (Lambda)    │                │ │
│  │  │   (Lambda)    │    │ [DONE]        │    │ [TODO]        │                │ │
│  │  │ [DONE]        │    │               │    │               │                │ │
│  │  └───────────────┘    └───────────────┘    └───────────────┘                │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SHARED SERVICES                                      │ │
│  │                                                                               │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │ │
│  │  │   State     │  │   Activity  │  │   Media     │  │   Secrets   │         │ │
│  │  │ (DynamoDB)  │  │ (DynamoDB)  │  │    (S3)     │  │  Manager    │         │ │
│  │  │ [DONE]      │  │ [DONE]      │  │ [DONE]      │  │ [DONE]      │         │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## DynamoDB Schema

```
Table: swarm-state-{env}
  PK: AGENT#{agentId}
  SK: Various patterns
    - CONFIG                          # Agent configuration
    - PLATFORM#{platform}#CONFIG      # Platform-specific config
    - CHANNEL#{channelId}#STATE       # Channel state + recent messages
    - USER#{userId}#COOLDOWN          # User cooldowns

  GSI1 (gsi1pk, gsi1sk):
    - For listing entities by type

Table: swarm-activity-{env}
  PK: AGENT#{agentId}
  SK: {timestamp}
  TTL: 24 hours (configurable)
```

---

## API Routes

```
POST /webhook/telegram/{agentId}     → telegram-webhook Lambda
POST /webhook/twitter/{agentId}      → twitter-webhook Lambda (TODO)
POST /chat                           → web-chat Lambda

GET  /health                         → health check
```

---

## Configuration Reference

### Agent config.yaml

```yaml
id: my-agent
name: My Agent
version: 1.0.0

platforms:
  telegram:
    enabled: true
    botUsername: my_agent_bot
  twitter:
    enabled: false
  web:
    enabled: false

llm:
  provider: openrouter  # openrouter | bedrock | anthropic
  model: anthropic/claude-sonnet-4
  temperature: 0.8
  maxTokens: 1024

media:
  image:
    provider: openrouter
    model: openai/dall-e-3

scheduling:
  tweet:
    hoursUtc: [12, 18]
    template: general

behavior:
  responseDelayMs: [1000, 3000]
  typingIndicator: true
  ignoreBots: true
  cooldownMinutes: 5
  maxContextMessages: 20

tools:
  - send_message
  - react
  - ignore
  - wait
  - take_selfie

secrets:
  - TELEGRAM_BOT_TOKEN
  - OPENROUTER_API_KEY
```

### Required Secrets (per agent)

Store in AWS Secrets Manager as `swarm/{agentId}/secrets`:

```json
{
  "TELEGRAM_BOT_TOKEN": "...",
  "OPENROUTER_API_KEY": "...",
  "TWITTER_API_KEY": "...",
  "TWITTER_API_SECRET": "...",
  "TWITTER_ACCESS_TOKEN": "...",
  "TWITTER_ACCESS_SECRET": "..."
}
```

---

## Cost Estimation

| Resource | Monthly Cost (estimate) |
|----------|------------------------|
| DynamoDB (on-demand) | $5-20 |
| Lambda (per 1M invocations) | $0.20 |
| SQS (per 1M requests) | $0.40 |
| S3 (per GB) | $0.023 |
| CloudFront (per GB) | $0.085 |
| Secrets Manager (per secret) | $0.40 |
| API Gateway (per 1M requests) | $1.00 |

**Estimated total for 4 agents with moderate traffic: $20-50/month**

---

## Decisions Made

- **Language:** TypeScript (better Lambda cold starts than Python)
- **Monorepo:** pnpm workspaces
- **CDK:** TypeScript CDK for infrastructure
- **Platform priority:** Telegram first, then Twitter/Web, Discord later
- **LLM default:** OpenRouter (multi-model access, fallback support)
- **Queues:** SQS FIFO for message ordering, standard for media
- **State:** Single DynamoDB table with composite keys (multi-tenant)
