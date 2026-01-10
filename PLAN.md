# AWS Social Media Agent Swarm - Architecture Plan

## Current State Analysis

You have **4 distinct bot projects** on AWS (us-east-1) with overlapping patterns:

| Project | Language | Platforms | Key Features |
|---------|----------|-----------|--------------|
| **FireHorse** | TypeScript/Node | Telegram, X/Twitter | Image gen (OpenRouter), Video gen (Replicate), Memory synthesis, Scheduled tweets |
| **Kyro** | Python | Discord, Telegram, X, Web | Tool-based responses, Token-gated, SQS message queues, Bedrock LLM |
| **Ratibot** | Python | X/Twitter | NFT generation, Airdrops, Ecosystem cycles, Irys storage |
| **Mirquo** | TypeScript | Telegram, X | Agent-based, DynamoDB memories, Embeddings |

### Shared Patterns Identified

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        COMMON ARCHITECTURE PATTERN                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │  Platform   │    │   Message   │    │  Response   │    │   Media     │        │
│  │  Webhook    │───▶│  Processor  │───▶│  Generator  │───▶│  Processor  │        │
│  │  Handler    │    │   (Queue)   │    │   (LLM)     │    │ (Images/Vid)│        │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘        │
│        │                   │                  │                  │                │
│        ▼                   ▼                  ▼                  ▼                │
│  ┌─────────────────────────────────────────────────────────────────────┐         │
│  │                         SHARED SERVICES                              │         │
│  │  • State (DynamoDB)    • Secrets Manager    • S3 (media)            │         │
│  │  • Cooldowns           • Rate Limiting      • Activity Feed          │         │
│  └─────────────────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Current AWS Resources

**Compute:**
- 30+ Lambda functions across projects
- ECS Fargate (Discord Gateway)

**Storage:**
- 12 DynamoDB tables (state, activity, cooldowns, memories)
- 12 S3 buckets (images, static assets, artifacts)

**Messaging:**
- 6 SQS queues (message queues, response jobs, media jobs, DLQs)

**Scheduling:**
- 14 EventBridge rules (tweets, maintenance, monitoring)

**Secrets:**
- 24 Secrets Manager entries (API keys, tokens, wallets)

---

## Proposed Swarm Architecture

### Design Principles

1. **Agent-First**: Each agent has a persona file + configuration
2. **Platform Adapters**: Plug-in architecture for Telegram/Discord/X/Web
3. **Shared Core**: Common LLM, media, storage, and queue infrastructure
4. **Multi-Tenant**: Single deployment serves multiple agents
5. **Cost-Efficient**: Shared resources, pay-per-use Lambda

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
│  │  │ Webhook  │  │ Gateway  │  │ Webhook  │  │   Chat   │  │  (Future)│       ││
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
│  │  │ message-queue │───▶│ response-jobs │───▶│  media-jobs   │                │ │
│  │  │     (SQS)     │    │    (SQS)      │    │    (SQS)      │                │ │
│  │  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘                │ │
│  │          │                    │                    │                         │ │
│  │          ▼                    ▼                    ▼                         │ │
│  │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                │ │
│  │  │   Evaluator   │    │  LLM Engine   │    │ Media Engine  │                │ │
│  │  │   (Lambda)    │    │   (Lambda)    │    │   (Lambda)    │                │ │
│  │  │ - Should reply│    │ - Bedrock     │    │ - OpenRouter  │                │ │
│  │  │ - Rate limit  │    │ - OpenRouter  │    │ - Replicate   │                │ │
│  │  │ - Cooldowns   │    │ - Tools       │    │ - DALL-E      │                │ │
│  │  └───────────────┘    └───────────────┘    └───────────────┘                │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                            │
│                                      ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SHARED SERVICES                                      │ │
│  │                                                                               │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │ │
│  │  │   State     │  │   Memory    │  │   Media     │  │  Activity   │         │ │
│  │  │ (DynamoDB)  │  │ (DynamoDB)  │  │    (S3)     │  │   Feed      │         │ │
│  │  │ swarm-state │  │swarm-memory │  │swarm-media  │  │(DynamoDB)   │         │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │ │
│  │                                                                               │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                          │ │
│  │  │  Secrets    │  │  Personas   │  │   Config    │                          │ │
│  │  │  Manager    │  │    (S3)     │  │   Store     │                          │ │
│  │  │ swarm/*     │  │ personas/   │  │  (SSM/Env)  │                          │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                          │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SCHEDULED TASKS                                      │ │
│  │  EventBridge Rules → Lambda                                                  │ │
│  │  • Tweet Scheduler (per agent, configurable times)                          │ │
│  │  • Mention Reply (periodic poll for X)                                       │ │
│  │  • Memory Maintenance (cleanup, synthesis)                                   │ │
│  │  • Health Checks                                                             │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Core Framework (Week 1-2)

Create the shared infrastructure and abstractions.

```
aws-swarm/
├── README.md
├── package.json / pyproject.toml       # Monorepo setup
├── infra/
│   ├── lib/
│   │   ├── swarm-stack.ts              # Main CDK stack
│   │   ├── constructs/
│   │   │   ├── agent-construct.ts      # Per-agent resources
│   │   │   ├── platform-webhook.ts     # API Gateway + Lambda
│   │   │   ├── processing-pipeline.ts  # SQS + Processors
│   │   │   ├── storage-layer.ts        # DynamoDB + S3
│   │   │   └── scheduling.ts           # EventBridge rules
│   │   └── config/
│   │       └── agents.ts               # Agent registry
│   └── bin/
│       └── swarm.ts                    # CDK app entry
├── core/
│   ├── src/
│   │   ├── types/
│   │   │   ├── envelope.ts             # Universal message envelope
│   │   │   ├── agent.ts                # Agent configuration type
│   │   │   └── platform.ts             # Platform types
│   │   ├── platforms/
│   │   │   ├── base.ts                 # Abstract platform adapter
│   │   │   ├── telegram.ts             # Telegram adapter
│   │   │   ├── discord.ts              # Discord adapter
│   │   │   ├── twitter.ts              # X/Twitter adapter
│   │   │   └── web.ts                  # Web chat adapter
│   │   ├── processors/
│   │   │   ├── message-evaluator.ts    # Should-reply logic
│   │   │   ├── response-generator.ts   # LLM response generation
│   │   │   ├── media-generator.ts      # Image/video generation
│   │   │   └── outbound-sender.ts      # Send to platforms
│   │   ├── services/
│   │   │   ├── llm/
│   │   │   │   ├── bedrock.ts          # AWS Bedrock client
│   │   │   │   ├── openrouter.ts       # OpenRouter client
│   │   │   │   └── anthropic.ts        # Direct Anthropic
│   │   │   ├── media/
│   │   │   │   ├── openrouter-image.ts # OpenRouter image gen
│   │   │   │   ├── replicate.ts        # Replicate video gen
│   │   │   │   └── dalle.ts            # DALL-E integration
│   │   │   ├── state.ts                # DynamoDB state service
│   │   │   ├── memory.ts               # Memory/context service
│   │   │   ├── secrets.ts              # Secrets Manager wrapper
│   │   │   ├── cooldown.ts             # Rate limiting
│   │   │   └── activity.ts             # Activity feed
│   │   └── utils/
│   │       ├── logger.ts
│   │       └── config.ts
│   └── handlers/
│       ├── webhook.ts                  # Universal webhook handler
│       ├── message-processor.ts        # SQS message processor
│       ├── response-generator.ts       # SQS response processor
│       ├── media-processor.ts          # SQS media processor
│       ├── tweet-poster.ts             # Scheduled tweet handler
│       └── health-check.ts             # Health check endpoint
└── agents/
    ├── firehorse/
    │   ├── persona.md                  # Personality definition
    │   ├── config.yaml                 # Agent configuration
    │   └── tools.ts                    # Agent-specific tools
    ├── kyro/
    │   ├── persona.md
    │   ├── config.yaml
    │   └── tools.ts
    ├── ratibot/
    │   ├── persona.md
    │   ├── config.yaml
    │   └── tools.ts
    └── mirquo/
        ├── persona.md
        ├── config.yaml
        └── tools.ts
```

### Phase 2: Agent Configuration System (Week 2-3)

Define a standard agent configuration format:

```yaml
# agents/firehorse/config.yaml
agent:
  id: firehorse
  name: "Fire Horse"
  version: "1.0.0"

platforms:
  telegram:
    enabled: true
    bot_username: "fire_horse_bot"
    webhook_path: "/telegram/firehorse"
  twitter:
    enabled: true
    username: "FireHorseAI"
    features:
      - scheduled_tweets
      - mention_replies
  discord:
    enabled: false

llm:
  provider: openrouter
  model: anthropic/claude-sonnet-4
  fallback_model: anthropic/claude-3-haiku
  temperature: 0.8
  max_tokens: 1024

media:
  image:
    provider: openrouter
    model: openai/dall-e-3
  video:
    provider: replicate
    model: minimax/video-01

scheduling:
  tweets:
    - cron: "0 13 * * ?"  # 6 AM PT
      template: morning_tweet
    - cron: "0 17 * * ?"  # 10 AM PT
      template: midday_tweet
    - cron: "0 21 * * ?"  # 2 PM PT
      template: afternoon_tweet
    - cron: "0 1 * * ?"   # 6 PM PT
      template: evening_tweet
  mention_check:
    rate: "30 */8 * * ?"

behavior:
  response_delay_ms: [1000, 3000]  # Random delay range
  typing_indicator: true
  ignore_bots: true
  cooldown_minutes: 5

tools:
  - send_message
  - react
  - take_selfie
  - ignore
  - wait
  # Agent-specific tools
  - generate_horse_video

secrets:
  - TELEGRAM_BOT_TOKEN
  - TWITTER_API_KEY
  - TWITTER_API_SECRET
  - OPENROUTER_API_KEY
  - REPLICATE_API_TOKEN
```

### Phase 3: Migrate Existing Bots (Week 3-4)

1. **Extract shared code** from existing projects into `core/`
2. **Create agent configs** for FireHorse, Kyro, Ratibot, Mirquo
3. **Deploy shared infrastructure** via CDK
4. **Point webhooks** to new unified API Gateway
5. **Sunset old stacks** after validation

### Phase 4: Agent CLI & Dashboard (Week 4-5)

```bash
# CLI for managing agents
swarm agent create catboy-2025 --template kyro
swarm agent deploy firehorse --env prod
swarm agent logs kyro --platform telegram
swarm agent status --all
swarm secrets set firehorse TWITTER_API_KEY "xxx"
```

---

## DynamoDB Schema (Multi-Tenant)

```
Table: swarm-state
  PK: AGENT#{agentId}
  SK: Various patterns
    - CONFIG                          # Agent configuration
    - PLATFORM#{platform}#CONFIG      # Platform-specific config
    - CHANNEL#{channelId}#STATE       # Channel state
    - USER#{userId}#COOLDOWN          # User cooldowns
    - SCHEDULE#{scheduleId}           # Scheduled tasks

Table: swarm-messages  
  PK: AGENT#{agentId}#CHANNEL#{channelId}
  SK: MSG#{timestamp}#{messageId}
  TTL: 7 days

Table: swarm-memory
  PK: AGENT#{agentId}
  SK: MEM#{memoryId}
  Attributes: embedding, importance, decay, type

Table: swarm-activity
  PK: AGENT#{agentId}
  SK: ACT#{timestamp}
  TTL: 24 hours
```

---

## API Gateway Routes

```
POST /webhook/telegram/{agentId}     → telegram-handler Lambda
POST /webhook/discord/{agentId}      → discord-handler Lambda  
POST /webhook/twitter/{agentId}      → twitter-handler Lambda
POST /webhook/replicate/{agentId}    → replicate-callback Lambda

GET  /api/agents                     → list agents
GET  /api/agents/{agentId}/activity  → activity feed
GET  /api/agents/{agentId}/health    → health check
POST /api/agents/{agentId}/message   → web chat

GET  /api/admin/stats                → aggregate stats (auth required)
```

---

## Cost Optimization

| Resource | Current (4 separate) | Swarm (shared) |
|----------|---------------------|----------------|
| DynamoDB Tables | 12 | 4 |
| S3 Buckets | 12 | 3 |
| Lambda Functions | 30+ | ~10 (shared) |
| Secrets | 24 | ~10 (per-agent) |
| API Gateways | 10+ | 1 |

**Estimated savings: 40-60% on base infrastructure costs**

---

## Next Steps

1. **Confirm language preference**: TypeScript (like FireHorse/Mirquo) or Python (like Kyro/Ratibot)?
   - Recommendation: **TypeScript** for Lambda cold start performance

2. **Prioritize platform adapters**: Which platforms are most critical?
   - Telegram + X seem most used

3. **Agent migration order**: 
   - Start with FireHorse (cleanest TypeScript codebase)
   - Then Mirquo (similar stack)
   - Then Kyro/Ratibot (Python → TypeScript port or keep Python handlers)

4. **Decide on monorepo vs multi-repo**:
   - Recommendation: **Monorepo with pnpm workspaces**

Ready to start implementation when you confirm the approach!
