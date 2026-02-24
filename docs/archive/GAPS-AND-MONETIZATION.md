# AWS Swarm: System Gaps & Monetization Plan

**Date:** 2026-01-25
**Status:** Analysis Complete

This document provides a comprehensive analysis of current system gaps and outlines the monetization strategy for AWS Swarm.

---

## Executive Summary

AWS Swarm has a solid foundation with NFT-based access control, credit-based rate limiting, and multi-tenant isolation. However, critical gaps exist in the billing/entitlements layer, memory retention policies, and operational infrastructure. The monetization model is web3-native with three distinct revenue streams: NFT sales, tiered subscriptions, and usage-based fees.

---

## Part 1: Current State Analysis

### What's Built (Updated 2026-02-07)

| Component | Status | Location |
|-----------|--------|----------|
| NFT Gating (Gate NFT) | Complete | `admin-api/src/services/nft-gate.ts` |
| Inhabitation System | Complete | `admin-api/src/services/avatar-ownership.ts` |
| Lineage NFTs | Complete | `admin-api/src/services/lineage-nft.ts` |
| Credit/Rate Limiting | Complete (deprecated by Energy) | `admin-api/src/services/credits.ts` |
| Energy System | Complete | `admin-api/src/services/energy.ts`, `energy-burn.ts` |
| Avatar Ascension | Complete | `admin-api/src/services/avatar-ascend.ts` |
| Entitlements (schema + storage + enforcement) | Complete | `admin-api/src/services/entitlements.ts`, `handlers/src/services/entitlement-enforcement.ts` |
| Runtime Limits Sync | Complete | `admin-api/src/services/runtime-limits.ts` |
| Activation Readiness Gates | Complete | `admin-api/src/services/activation-readiness.ts` |
| Wallet Management | Complete | `admin-api/src/services/wallets.ts` |
| Account-Level Gating | Complete | `admin-api/src/services/account-gate.ts` |
| Twitter Rate Limiting | Complete | `handlers/src/services/twitter-rate-limit.ts` |
| Content Store | Complete | `core/src/services/content-store.ts` |
| Multi-wallet Accounts | Complete | `admin-api/src/services/account.ts` |

### What's Missing (Updated 2026-02-07)

| Component | Status | Priority | Blocking |
|-----------|--------|----------|----------|
| Entitlements Schema | **Complete** | P0 | — |
| Entitlements Storage | **Complete** | P0 | — |
| Runtime Enforcement | **Complete** | P0 | — |
| Memory Configuration | **Complete** (schema + gating) | P1 | — |
| Memory Retention/TTL | **Complete** (DynamoDB TTL on write) | P1 | — |
| Memory Delete/Export | **Complete** (delete + bulk delete + export endpoints) | P1 | — |
| Deploy/Activate Flow | **Complete** (activate + readiness gates) | P1 | — |
| Energy-Entitlement Unification | **Complete** (energy as burst pool) | P1 | — |
| Orb-Holder Auto-Boost | **Complete** (boosted limits for Orb holders) | P1 | — |
| Stripe Integration | Deferred to M2 | P2 | M2 |
| Usage Dashboards | Not Started | P2 | M2 |
| CloudWatch Alarms | Partial (no actions) | P2 | M1 |
| Operational Runbooks | Not Started | P2 | M1 |

---

## Part 2: System Gaps Deep Dive

### Gap 1: Entitlements System (P0)

**Current State:** No formal entitlements. Rate limits are hardcoded per tool.

**What's Needed:**

```typescript
interface Entitlement {
  avatarId: string;
  plan: 'free' | 'basic' | 'pro' | 'enterprise';

  // Feature flags
  features: {
    memoryEnabled: boolean;
    voiceEnabled: boolean;
    mediaGenerationEnabled: boolean;
    multiPlatformEnabled: boolean;
    customPersonaEnabled: boolean;
  };

  // Limits
  limits: {
    messagesPerDay: number;
    mediaGenerationsPerDay: number;
    voiceMinutesPerMonth: number;
    memoryRetentionDays: number;
    platformCount: number;
  };

  // Billing
  billing: {
    source: 'manual' | 'stripe' | 'nft';
    stripeSubscriptionId?: string;
    nftMint?: string;
    expiresAt?: number;
  };
}
```

**Implementation Tasks:**
1. Define schema in `packages/admin-api/src/types.ts`
2. Create `packages/admin-api/src/services/entitlements.ts`
3. Add DynamoDB storage (pk: `AVATAR#{id}`, sk: `ENTITLEMENT`)
4. Expose via admin API (`GET/PUT /avatars/{id}/entitlement`)
5. Enforce in `message-processor.ts`, `media.ts`, `voice.ts`

### Gap 2: Memory Configuration & Retention (P1)

**Current State:** Memory exists but no configuration or retention policy.

**What's Needed:**

```typescript
interface MemoryConfig {
  enabled: boolean;                    // Master switch
  retentionDays: number;              // TTL for memories (0 = forever)
  maxMemories: number;                // Hard limit per avatar
  consolidationEnabled: boolean;      // Enable daily consolidation
  exportEnabled: boolean;             // Allow memory export
}
```

**Implementation Tasks:**
1. Add `memoryConfig` to avatar config schema
2. Default free tier: `{ enabled: false }`
3. Implement deletion endpoint (`DELETE /avatars/{id}/memories`)
4. Implement export endpoint (`GET /avatars/{id}/memories/export`)
5. Add TTL enforcement via scheduled Lambda

### Gap 3: Deploy/Activate Flow (P1)

**Current State:** Avatars are always "active" once created.

**What's Needed:**
- Explicit activation state (draft → active → paused)
- Deployment triggers webhook registration
- Deactivation tears down webhooks
- Audit logging for state transitions

**Implementation Tasks:**
1. Add `status: 'draft' | 'active' | 'paused'` to avatar config
2. Create `POST /avatars/{id}/deploy` endpoint
3. Create `POST /avatars/{id}/pause` endpoint
4. Wire webhook registration into deploy flow
5. Add audit log entries for transitions

### Gap 4: Observability Infrastructure (P2)

**Current State:** Structured logging exists but lacks correlation and dashboards.

**What's Needed:**
- Correlation ID propagation (webhook → SQS → handler)
- CloudWatch dashboard per avatar
- DLQ alarms with SNS notifications
- Error rate alerting

**Implementation Tasks:**
1. Add `correlationId` to SQS message attributes
2. Create CDK construct for CloudWatch dashboard
3. Add DLQ alarms in `shared-handlers.ts`
4. Create operational runbook document

### Gap 5: Payment Integration (P2)

**Current State:** No payment processing. Manual entitlements only.

**What's Needed (M2):**
- Stripe Checkout for subscription plans
- Webhook handler for subscription events
- Entitlement sync on payment success/failure
- Customer portal link generation

---

## Unified Billing Strategy (2026-02-07)

**Decision:** Web2 entitlements set the floor. Web3 augments the ceiling. See [BILLING-STRATEGY.md](BILLING-STRATEGY.md) for full specification.

**Principle:** `Effective Limit = max(entitlement_limit, web3_augmented_limit)`

| User Type | Access Gate | Capacity Source | Burst Pool | Revenue |
|-----------|------------|-----------------|------------|---------|
| No wallet | Free entitlement | Free tier limits | Energy (base) | Future Stripe |
| Wallet, no Orb | Free entitlement | Free tier limits | Energy (base) | Future Stripe |
| Orb holder | NFT-gated slots | Boosted free limits | Energy (enhanced) | Orb purchase |
| RATI burner | NFT-gated slots | Boosted + burn tier | Energy (burn-scaled) | Token burns |
| Ascended | Permanent NFT | Pro-equivalent | Energy (1.5x) | Orb + RATI burn |
| Manual Pro | Per entitlement | Pro limits | Energy + Pro | Admin-assigned |
| Enterprise | Per entitlement | Unlimited | Unlimited | Custom deal |

**Implementation status:**
1. ~~Unify energy as burst pool within entitlement limits (eliminate double-gating)~~ **Done.** `entitlement-enforcement.ts` checks daily limit first; energy is burst fallback only.
2. ~~Auto-boost entitlement params for Orb holders in `syncRuntimeLimitsToState()`~~ **Done.** `runtime-limits.ts` applies Orb-holder boost to free-tier avatars.
3. ~~Map Ascension to permanent Pro-equivalent entitlement~~ **Done.** `avatar-ascend.ts` grants Pro plan on ascension.
4. Stripe integration deferred to M2.

---

## Part 3: Monetization Strategy

### Revenue Model Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    AWS SWARM REVENUE                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  NFT Sales  │  │Subscriptions│  │   Usage-Based Fees  │ │
│  │  (One-time) │  │ (Recurring) │  │     (Per-action)    │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│        │                │                    │              │
│        ▼                ▼                    ▼              │
│  ┌───────────┐   ┌───────────┐      ┌───────────────────┐  │
│  │ Gate NFT  │   │   Plans   │      │  Media Generation │  │
│  │ Lineage   │   │ Free/Pro/ │      │  Voice Minutes    │  │
│  │ Avatar NFT│   │ Enterprise│      │  API Calls        │  │
│  └───────────┘   └───────────┘      └───────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Revenue Stream 1: NFT Sales

#### Gate NFT
- **Purpose:** Avatar creation slots and abandonment rights
- **Pricing:** Market-driven (secondary sales on Magic Eden)
- **Mechanics:**
  - 1 free slot per wallet
  - +1 slot per Gate NFT held
  - Abandonment requires burning 1 Gate NFT
- **Revenue:** Initial mint + royalties on secondary sales

#### Lineage NFT
- **Purpose:** Collectible record of avatar inhabitation
- **Pricing:** Free mint (gas only) on abandonment
- **Mechanics:**
  - Minted when user abandons avatar
  - Records era, inhabitant, timestamps
  - Enables "legacy" narratives
- **Revenue:** Royalties on secondary trading

#### Avatar NFTs (Whitelisted Collections)
- **Purpose:** Third-party NFTs claimed as avatars
- **Pricing:** Partnership/licensing fees
- **Mechanics:**
  - PROXIM8, custom collections
  - NFT metadata → Avatar persona
  - Collection whitelisting required
- **Revenue:** Partnership deals, integration fees

### Revenue Stream 2: Subscription Plans

| Plan | Price | Target User | Key Features |
|------|-------|-------------|--------------|
| **Free** | $0 | Casual users | 1 avatar, no memory, rate limited |
| **Basic** | $9/mo | Creators | 1 avatar, memory enabled, more limits |
| **Pro** | $29/mo | Power users | 3 avatars, all features, priority |
| **Enterprise** | Custom | Businesses | Unlimited, SLA, dedicated support |

#### Plan Feature Matrix

| Feature | Free | Basic | Pro | Enterprise |
|---------|------|-------|-----|------------|
| Avatar Slots | 1 | 1 | 3 | Unlimited |
| Memory | None | 30 days | 90 days | Unlimited |
| Messages/day | 50 | 500 | 2000 | Unlimited |
| Image Gen/day | 5 | 20 | 100 | 500 |
| Video Gen/day | 0 | 2 | 10 | 50 |
| Voice Minutes/mo | 0 | 30 | 120 | 500 |
| Platforms | 1 | 2 | All | All |
| Custom Persona | Basic | Full | Full | Full |
| API Access | No | No | Yes | Yes |
| Priority Support | No | No | Yes | Dedicated |

#### Implementation Path

**M1 (Manual Entitlements):**
1. Admin can set plan via chat tool
2. Entitlements stored in DynamoDB
3. Runtime enforces limits
4. No payment processing

**M2 (Stripe Integration):**
1. Stripe Checkout for plan selection
2. Webhook syncs entitlements
3. Customer portal for management
4. Dunning for failed payments

### Revenue Stream 3: Usage-Based Fees

For users who exceed plan limits or want pay-as-you-go:

| Resource | Unit | Price |
|----------|------|-------|
| Additional Messages | 1000 msgs | $1 |
| Image Generation | 100 images | $5 |
| Video Generation | 10 videos | $10 |
| Voice Minutes | 60 mins | $5 |
| Memory Storage | 1GB/mo | $2 |
| API Requests | 10K requests | $5 |

#### Implementation:

1. Track usage in `UsageMeteringService`
2. Bill overage at end of billing cycle
3. Or pre-purchase credit packs
4. Display usage in admin UI dashboard

---

## Part 4: NFT Economics

### Gate NFT Tokenomics

```
Total Supply: 10,000 Gate NFTs
├── Initial Mint: 5,000 (public sale)
├── Reserved: 2,000 (team, partnerships)
├── Treasury: 2,000 (ecosystem growth)
└── Burned: 1,000+ (projected from abandonments)
```

**Deflationary Mechanism:**
- Abandoning an avatar burns 1 Gate NFT
- Creates scarcity over time
- Increases value of remaining NFTs

**Price Discovery:**
- Initial mint price: 0.1 SOL
- Secondary market: Magic Eden
- Royalties: 5% on secondary sales

### Lineage NFT Collection

Each avatar creates its own collection:
- Genesis (Era 1) → Most valuable
- Subsequent eras less rare
- Collection grows with each abandonment

**Metadata includes:**
- Avatar snapshot at abandonment
- Era number
- Inhabitant history
- Memory highlights (opt-in)

---

## Part 5: Implementation Roadmap

### Phase 1: Foundation (M1 - Current)

**Timeline:** 2 weeks

| Task | Owner | Status |
|------|-------|--------|
| Define entitlement schema | Backend | Not Started |
| Implement entitlements service | Backend | Not Started |
| Add runtime enforcement | Backend | Not Started |
| Memory config in avatar schema | Backend | Not Started |
| Deploy/activate endpoints | Backend | Not Started |
| Manual entitlement tool in chat | Backend | Not Started |

**Deliverable:** Manual entitlements with runtime enforcement

### Phase 2: Billing (M2)

**Timeline:** 4 weeks

| Task | Owner | Status |
|------|-------|--------|
| Stripe account setup | Ops | Not Started |
| Checkout session endpoint | Backend | Not Started |
| Webhook handler | Backend | Not Started |
| Customer portal integration | Backend | Not Started |
| Usage metering service | Backend | Not Started |
| Billing dashboard in UI | Frontend | Not Started |

**Deliverable:** Self-serve paid subscriptions

### Phase 3: Scale (M3)

**Timeline:** 8 weeks

| Task | Owner | Status |
|------|-------|--------|
| Usage-based billing | Backend | Not Started |
| Enterprise plan features | Backend | Not Started |
| Multi-avatar coordination | Backend | Not Started |
| Memory export/delete | Backend | Not Started |
| SLA monitoring | Ops | Not Started |

**Deliverable:** Enterprise-ready platform

---

## Part 6: Pricing Strategy

### Competitive Analysis

| Platform | Free Tier | Paid Tier | Notes |
|----------|-----------|-----------|-------|
| Character.AI | Limited msgs | $9.99/mo | Focus on personas |
| Replika | Basic | $7.99/mo | Relationship focus |
| ChatGPT | GPT-3.5 | $20/mo | General purpose |
| AWS Swarm | 1 avatar | $9-29/mo | Multi-platform, web3 |

### Pricing Principles

1. **Free tier is functional** - Users can experience core value
2. **Paid unlocks power** - Memory, media, multi-platform
3. **NFT is premium** - Additional slots, collectible value
4. **Enterprise is custom** - High-touch sales process

### Revenue Projections (Conservative)

| Metric | M1 | M2 | M3 |
|--------|----|----|----|
| Free Users | 500 | 2,000 | 10,000 |
| Paid Users (5%) | 25 | 100 | 500 |
| Avg Revenue/User | $15 | $18 | $22 |
| MRR | $375 | $1,800 | $11,000 |
| NFT Sales (one-time) | $5,000 | $10,000 | $25,000 |

---

## Part 7: Technical Debt & Risks

### Technical Debt

| Issue | Impact | Effort | Priority |
|-------|--------|--------|----------|
| `chat.ts` is 2500+ lines | Maintainability | High | P2 |
| No formal API docs | Developer experience | Medium | P2 |
| 98 services in admin-api | Discoverability | Medium | P3 |
| Inconsistent service patterns | Onboarding | Low | P3 |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| NFT market downturn | Medium | High | Subscription fallback |
| LLM cost increases | Medium | Medium | Usage limits, caching |
| Platform API changes | High | Medium | Abstraction layer |
| Regulatory (crypto) | Low | High | Fiat-first option |

---

## Appendix: Code References

### Existing Monetization Code

| File | Purpose | Lines |
|------|---------|-------|
| `admin-api/src/services/credits.ts` | Credit bucket system | ~300 |
| `admin-api/src/services/nft-gate.ts` | Gate NFT verification | ~200 |
| `admin-api/src/services/avatar-ownership.ts` | Inhabitation logic | ~400 |
| `admin-api/src/services/lineage-nft.ts` | Lineage NFT minting | ~250 |
| `admin-api/src/services/account-gate.ts` | Account-level gating | ~150 |
| `handlers/src/services/twitter-rate-limit.ts` | Twitter tier limits | ~380 |

### Configuration Points

| Config | Location | Current Value |
|--------|----------|---------------|
| Gate NFT Collection | `nft-gate.ts:8` | `8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ` |
| Whitelisted Collections | Environment | `WHITELISTED_NFT_COLLECTIONS` |
| Credit Limits | `credits.ts:20-50` | Hardcoded per tool |
| Twitter Tier | `twitter-rate-limit.ts:25` | `free` or `basic` |

---

*This document should be updated as implementation progresses.*
