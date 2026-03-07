# Service Layer Domain Map

This document describes the domain-oriented organization of the admin-api service layer.

## Overview

The service layer is organized into 12 domain modules. Each domain has a barrel
export (`index.ts`) that re-exports from the individual service files. The main
`services/index.ts` barrel remains unchanged for backward compatibility.

**New code** should prefer importing from domain barrels:
```typescript
import { getAvatar, listAvatars } from '../services/avatar/index.js';
import { getEntitlement } from '../services/billing/index.js';
```

**Existing code** continues to work with direct file imports:
```typescript
import { getAvatar } from '../services/avatars.js';
```

## Domain Boundaries

### `avatar/` — Avatar Lifecycle
Core avatar CRUD, ownership, ascension, stats, observability, activation
readiness, and config synchronization.

| Module | Description |
|--------|-------------|
| `avatars` | Avatar CRUD, platform configuration |
| `avatar-ownership` | Ownership verification, inhabitation rules |
| `avatar-ascend` | Orb + RATI burn ascension flow |
| `avatar-stats` | D&D-style stat generation |
| `avatar-observability` | Avatar-level event and metric tracking |
| `activation-readiness` | Pre-activation checklist evaluation |
| `config-sync` | Config push to runtime infrastructure |

### `auth/` — Authentication & Authorization
Wallet-based auth, Privy auth, NFT gating, account management, and
wallet linking.

| Module | Description |
|--------|-------------|
| `wallet-auth` | Wallet signature auth, session management |
| `privy-auth` | Privy access token verification |
| `account-gate` | Account-level access gating |
| `accounts` | Account CRUD, wallet-to-account mapping |
| `wallet-link` | Multi-wallet linking challenges |
| `nft-gate` | NFT ownership verification for gating |
| `accounts/*` | Auth orchestrator, challenge, identity, session services |

### `billing/` — Billing & Entitlements
Credits, energy, entitlements, Stripe integration, runtime limits,
burn stats, and usage tracking.

| Module | Description |
|--------|-------------|
| `credits` | Credit ledger and consumption |
| `entitlements` | Tier-based entitlement resolution |
| `energy` | Energy pool management (type exports) |
| `energy-burn` | Energy burn tracking |
| `stripe-billing` | Stripe checkout and subscription management |
| `runtime-limits` | Effective runtime limit computation |
| `orb-slots` | Orb-based slot allocation |
| `burn-stats` | RATI burn statistics |
| `active-user-limit` | Active user cap enforcement |

### `memory/` — Memory System
Avatar memory storage, search, consolidation, migration, embeddings,
dreams, and moltbook.

| Module | Description |
|--------|-------------|
| `memory` | Core memory CRUD, search, TTL management |
| `memory-consolidation` | Batch memory consolidation |
| `memory-migration` | Memory schema migration |
| `embedding` | Vector embedding generation |
| `dreams` | Dream generation and retrieval |
| `dream-jobs` | Async dream job management |
| `moltbook` | Moltbook narrative entries |

### `media/` — Media & Content
Image/video generation, gallery, stickers, voice synthesis,
and Replicate integration.

| Module | Description |
|--------|-------------|
| `media` | Media generation orchestration |
| `media-jobs` | Async media job management |
| `gallery` | Image gallery CRUD |
| `replicate` | Replicate API client |
| `stickers` | Sticker generation and pack management |
| `sticker-processor` | Sticker image processing |
| `telegram-stickers` | Telegram sticker set management |
| `voice` | Voice synthesis (TTS) |

### `chat/` — Chat Infrastructure
Chat history, job management, voting, access control, idempotency,
processor adaptation, initiative, reactions, and model resolution.

| Module | Description |
|--------|-------------|
| `chat-history` | Chat history facade |
| `chat-history-store` | Chat history DynamoDB storage |
| `chat-jobs` | Async chat job management |
| `chat-voting` | Chat message voting |
| `chat-access` | Avatar chat access checking |
| `idempotency` | Request idempotency store |
| `processor-adapter` | Chat processor integration |
| `initiative` | Proactive initiative system (CONTROL-PLANE ONLY, not wired into live routing) |
| `reactions` | Message reaction handling (CONTROL-PLANE ONLY, not wired into live routing) |
| `models-registry` | LLM model selection and resolution |

### `platform/` — Platform Integrations
Telegram, Twitter, Discord integration; MCP adapters;
onboarding flows; and generic integration configuration.

| Module | Description |
|--------|-------------|
| `telegram` | Telegram Bot API client |
| `telegram-admin` | Telegram diagnostics and repair |
| `telegram-onboarding` | Telegram user onboarding |
| `twitter-oauth` | Twitter OAuth 2.0 flow |
| `twitter-feed` | Twitter feed polling |
| `discord` | Discord bot integration |
| `mcp-adapter` | MCP tool adapter |
| `mcp-config` | MCP toolset configuration |
| `mcp-twitter-adapter` | MCP Twitter-specific adapter |
| `integrations` | Generic integration configuration |
| `onboarding/*` | Onboarding state machine and orchestrator |
| `onboarding-rollout` | Feature flag rollout for onboarding |

### `observability/` — Observability
Logging, monitoring, auto-issue detection, and audit trails.

| Module | Description |
|--------|-------------|
| `logs` | CloudWatch log access |
| `observability` | System health and metrics |
| `auto-issues` | Automated issue detection and recording |
| `audit-log` | Admin action audit logging |
| `structured-logger` | Structured JSON logger |

### `infra/` — Infrastructure Services
Low-level infrastructure: DynamoDB client, secrets, utilities.

| Module | Description |
|--------|-------------|
| `dynamo-client` | Shared DynamoDB document client |
| `secrets` | AWS Secrets Manager access |
| `promise-timeout` | Promise timeout utility |
| `templates` | Template rendering |

### `web3/` — Web3 & Blockchain
Wallet management, token operations, NFT minting, and token launches.

| Module | Description |
|--------|-------------|
| `wallets` | Wallet CRUD and derivation |
| `wallet-balance` | On-chain balance queries |
| `lineage-nft` | Lineage NFT minting and verification |
| `token-launch` | Token launch orchestration |
| `vanity-mint` | Vanity address minting |

### `channel/` — Channel Management
Channel state tracking, home channels, and shared channels.

| Module | Description |
|--------|-------------|
| `channel-state` | Per-channel conversation state (CONTROL-PLANE ONLY, see `docs/COORDINATION-OWNERSHIP.md`) |
| `home-channel` | Avatar home channel management |
| `shared-channel` | Multi-avatar shared channels (CONTROL-PLANE ONLY) |

### `property/` — Property Research
Property research tools and web search.

| Module | Description |
|--------|-------------|
| `property-research` | Property data research tools |
| `web-search` | Web search integration |

## Migration Strategy

This decomposition is **additive and non-breaking**:

1. **Phase 1 (current)**: Domain barrel files created alongside existing flat structure.
   All existing `import { foo } from '../services/bar.js'` paths continue to work.

2. **Phase 2 (future)**: Gradually update handler imports to use domain barrels.
   ```typescript
   // Before
   import { getAvatar } from '../services/avatars.js';
   import { getEntitlement } from '../services/entitlements.js';
   
   // After
   import { getAvatar } from '../services/avatar/index.js';
   import { getEntitlement } from '../services/billing/index.js';
   ```

3. **Phase 3 (future)**: Move service files into domain directories and update
   relative imports. The barrel files become true module boundaries.

## Cross-Domain Dependencies

Some services have cross-domain dependencies. These are acceptable during
the transition period and will be addressed in Phase 3:

- `credits.ts` (billing) imports from `energy.ts` (billing) — same domain
- `avatars.ts` (avatar) imports from `secrets.ts` (infra), `telegram.ts` (platform) — cross-domain
- `avatar-ascend.ts` (avatar) imports from `burn-stats.ts` (billing), `entitlements.ts` (billing) — cross-domain
- `dreams.ts` (memory) imports from `memory.ts` (memory) — same domain
- `chat-history.ts` (chat) imports from `chat-history-store.ts` (chat) — same domain
