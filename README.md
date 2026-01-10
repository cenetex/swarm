# AWS Swarm

A modular framework for deploying AI agents across multiple social platforms (Telegram, Twitter/X, Web chat) with shared infrastructure and reusable components.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AWS Swarm Framework                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Telegram   │  │  Twitter/X  │  │  Web Chat   │  │  Discord    │   │
│  │  Webhook    │  │  Webhook    │  │    API      │  │  (Future)   │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
│         │                │                │                │           │
│         └────────────────┴────────────────┴────────────────┘           │
│                                   │                                     │
│                          ┌────────▼────────┐                           │
│                          │   Message SQS   │                           │
│                          │   (FIFO Queue)  │                           │
│                          └────────┬────────┘                           │
│                                   │                                     │
│                          ┌────────▼────────┐                           │
│                          │    Message      │                           │
│                          │   Processor     │                           │
│                          └────────┬────────┘                           │
│                                   │                                     │
│                          ┌────────▼────────┐                           │
│                          │  Response SQS   │                           │
│                          └────────┬────────┘                           │
│                                   │                                     │
│                          ┌────────▼────────┐                           │
│                          │    Response     │                           │
│                          │     Sender      │                           │
│                          └─────────────────┘                           │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Shared Infrastructure                        │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  │  │
│  │  │  DynamoDB  │  │     S3     │  │  Secrets   │  │ CloudFront │  │  │
│  │  │   State    │  │   Media    │  │  Manager   │  │    CDN     │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- AWS CLI configured
- AWS CDK CLI (`npm i -g aws-cdk`)

### Installation

```bash
# Clone the repo
git clone https://github.com/your-org/aws-swarm.git
cd aws-swarm

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Creating Your First Agent

```bash
# Copy the template
cp -r agents/.template agents/my-agent

# Edit the config
code agents/my-agent/config.yaml
code agents/my-agent/persona.md

# Add secrets to AWS
aws secretsmanager create-secret \
  --name swarm/my-agent/secrets \
  --secret-string '{"TELEGRAM_BOT_TOKEN":"...","OPENROUTER_API_KEY":"..."}'

# Deploy
pnpm deploy:agent my-agent
```

### Deploying Everything

```bash
# Bootstrap CDK (first time only)
pnpm cdk bootstrap

# Deploy all agents
pnpm deploy:all

# Deploy specific environment
pnpm deploy:prod
```

## Project Structure

```
aws-swarm/
├── agents/                    # Agent configurations
│   ├── .template/             # Template for new agents
│   ├── agent-1/               # Each agent gets a folder
│   │   ├── config.yaml        # Agent configuration
│   │   └── persona.md         # Personality prompt
│   └── agent-2/
├── packages/
│   ├── core/                  # Shared TypeScript types & utilities
│   │   ├── src/
│   │   │   ├── types/         # Type definitions
│   │   │   ├── platforms/     # Platform adapters
│   │   │   ├── services/      # LLM, media, state services
│   │   │   ├── processors/    # Message processing pipeline
│   │   │   └── utils/         # Logging, config utilities
│   ├── handlers/              # Lambda handlers
│   │   └── src/
│   │       ├── telegram-webhook.ts
│   │       ├── message-processor.ts
│   │       ├── response-sender.ts
│   │       ├── tweet-poster.ts
│   │       └── web-chat.ts
│   └── infra/                 # CDK infrastructure
│       ├── src/
│       │   ├── constructs/    # Reusable CDK constructs
│       │   └── stacks/        # CDK stacks
│       └── bin/swarm.ts       # CDK app entry point
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Configuration

### Agent Config (config.yaml)

See [agents/.template/config.yaml](agents/.template/config.yaml) for all options.

### Environment Variables

Lambda handlers use these environment variables:
- `AGENT_ID` - Agent identifier
- `STATE_TABLE` - DynamoDB state table name
- `ACTIVITY_TABLE` - DynamoDB activity table name
- `MEDIA_BUCKET` - S3 bucket for media
- `SECRETS_ARN` - Secrets Manager ARN
- `MESSAGE_QUEUE_URL` - SQS message queue
- `RESPONSE_QUEUE_URL` - SQS response queue

## Packages

### @swarm/core

Core types, platform adapters, and services:

```typescript
import {
  // Types
  AgentConfig,
  SwarmEnvelope,
  SwarmResponse,
  
  // Platform adapters
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  
  // Services
  createLLMService,
  createMediaService,
  createSolanaService,
  createStateService,
  
  // Processors
  createMessageEvaluator,
  createResponseGenerator,
  createOutboundSender,
} from '@swarm/core';
```

### @swarm/handlers

Lambda handlers for each platform and processor:

- `telegramWebhook` - Handles Telegram bot webhooks
- `messageProcessor` - Generates responses using LLM
- `responseSender` - Sends responses to platforms
- `tweetPoster` - Posts scheduled tweets
- `webChat` - Handles REST API for web chat

### @swarm/infra

CDK constructs and stacks:

```typescript
import { SwarmStack, AgentConstruct, SharedInfrastructure } from '@swarm/infra';
```

## Supported Platforms

| Platform | Inbound | Outbound | Features |
|----------|---------|----------|----------|
| Telegram | ✅ | ✅ | Messages, replies, reactions, images |
| Twitter/X | ✅ | ✅ | Mentions, replies, scheduled tweets |
| Web Chat | ✅ | ✅ | REST API, token gating |
| Discord | 🔜 | 🔜 | Coming soon |

## LLM Providers

- **OpenRouter** - Access to Claude, GPT-4, Llama, and more
- **AWS Bedrock** - Claude via AWS
- **Anthropic** - Direct Claude API

## Solana Integration

Enable token-gated access and blockchain features:

```yaml
solana:
  enabled: true
  cluster: mainnet-beta
  tokenMint: "YourTokenMint..."
```

Features:
- Token balance verification
- Token transfers
- NFT minting
- Wallet signature verification

## Commands

```bash
# Development
pnpm dev          # Watch mode for all packages
pnpm build        # Build all packages
pnpm test         # Run tests
pnpm lint         # Lint code

# Deployment
pnpm deploy:all   # Deploy all agents
pnpm deploy:agent <id>  # Deploy specific agent
pnpm cdk diff     # Preview changes
pnpm cdk destroy  # Tear down

# Utilities
pnpm test:persona <id>  # Test agent persona
pnpm logs <id>          # Tail CloudWatch logs
```

## License

MIT
