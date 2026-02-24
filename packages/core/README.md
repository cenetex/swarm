# @swarm/core

Core types, platform adapters, message processors, and services for the AWS Swarm avatar platform.

## Purpose

This package is the shared foundation used by every other package in the monorepo. It provides:

- **Types** -- canonical data shapes (`AvatarConfig`, `SwarmEnvelope`, `SwarmResponse`, `Platform`, `ToolDefinition`, etc.)
- **Platform adapters** -- normalise inbound/outbound messages for Telegram, Discord, Twitter, and Web
- **Message processors** -- evaluate, process, and send messages (prompt building, tool composition, outbound sender)
- **Services** -- DynamoDB state, Secrets Manager, LLM (Bedrock + OpenRouter), media generation, Solana, usage metering, presence, channel summaries, circuit breaker, canonical memory, SQS offload
- **Errors** -- structured error codes and error classes
- **Utilities** -- logger, metrics, correlation IDs, config helpers, fetch retry

## Directory Layout

```
src/
  types/          # Shared TypeScript types and interfaces
  platforms/      # Platform adapters (Telegram, Discord, Twitter, Web)
  processors/     # Message evaluation, processing, prompt building, tool composition
  services/       # DynamoDB, LLM, media, Solana, secrets, state, brain/memory, etc.
  errors/         # Error codes and structured error classes
  tools/          # Tool definitions for avatar tool use
  utils/          # Logger, metrics, correlation, config, fetch-retry
  constants.ts    # Shared constants
  index.ts        # Barrel export
```

## Exports

The package exposes sub-path exports for tree-shaking:

| Import path | Contents |
|---|---|
| `@swarm/core` | Everything (barrel) |
| `@swarm/core/types` | Type definitions only |
| `@swarm/core/platforms` | Platform adapters |
| `@swarm/core/processors` | Message processors |
| `@swarm/core/services` | All services |
| `@swarm/core/errors` | Error codes and classes |

## Key Patterns

- **Dependency injection** -- Services like `DynamoDBStateService` accept a DynamoDB client and expose `_setDynamoClient()` for test injection.
- **Factory functions** -- Most services have a `create*Service()` factory alongside the class (e.g. `createLLMService`, `createMediaService`).
- **Platform adapter registry** -- `PlatformRegistry` maps platform names to adapter instances.

## Scripts

```bash
pnpm build       # tsc --build
pnpm typecheck   # tsc --noEmit
pnpm watch       # tsc --build --watch
pnpm test        # bun test
pnpm lint        # eslint src/
```
