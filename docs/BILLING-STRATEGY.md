# Billing Strategy: Unified Web3 + Web2 Model

**Date:** 2026-02-07
**Status:** Active (M1 billing posture decision)
**Decision:** Manual entitlements + Orb-holder auto-boost. Stripe deferred to M2. Energy unified as burst pool.

---

## Problem Statement

AWS Swarm has two parallel billing/gating systems that evolved independently:

1. **Web3 (active):** Gate NFT gating, Lineage NFTs, Energy system with burn-tier scaling, Avatar Ascension, RATI token bonuses
2. **Web2 (active):** Entitlement tiers (free/pro/enterprise), runtime enforcement in Lambda handlers, manual admin assignment

Both systems rate-limit media/voice operations independently, creating confusion: a user can have energy remaining but be blocked by entitlement limits, or vice versa.

---

## Architecture: Web2 Floor + Web3 Ceiling

**Principle:** Entitlements set the floor. Web3 augments the ceiling.

```
Effective Limit = max(entitlement_limit, web3_augmented_limit)
```

### Layer Model

```
┌─────────────────────────────────────────────────────────┐
│                  USER EXPERIENCE LAYER                    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  BURST POOL (Energy System)                       │   │
│  │  Token bucket on top of entitlement limits        │   │
│  │  Grants bonus uses after daily limit exhausted    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  WEB3 AUGMENTATION LAYER                          │   │
│  │  Orb holder → boosted free limits                 │   │
│  │  Burn tier → scaled energy pool                   │   │
│  │  RATI balance → refill bonus                      │   │
│  │  Ascension → permanent Pro-equivalent             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  ENTITLEMENT LAYER (Source of Truth)              │   │
│  │  Free / Pro / Enterprise tiers                    │   │
│  │  Daily limits: messages, media, voice, tools      │   │
│  │  Feature flags: memory, platforms, autonomy       │   │
│  │  RuntimeContract synced to STATE_TABLE            │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  ACCESS LAYER (Gate NFTs)                         │   │
│  │  Controls who can create avatars                  │   │
│  │  1 free slot + 1 per Orb held                     │   │
│  │  Abandonment requires Orb burn                    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Access Layer (Web3 — unchanged)

Gate NFTs control avatar creation slots. This stays as-is.

- 1 free avatar per wallet
- +1 slot per Gate NFT (Orb) held by that wallet
- Abandonment requires burning 1 Orb → mints Lineage NFT
- Gate enforcement is per-wallet: each wallet's NFT holdings determine its own avatar creation slots independently. Linking multiple wallets to one account does not aggregate slots across wallets. The UI shows the best single wallet's gate status for convenience.

**Code:** `nft-gate.ts`, `avatar-ownership.ts`, `lineage-nft.ts`, `account-gate.ts`

### Entitlement Layer (Web2 — source of truth for capacity)

Entitlements control what avatars can *do*. Three tiers with daily limits.

| Limit | Free | Pro | Enterprise |
|-------|------|-----|------------|
| Messages/day | 50 | 500 | Unlimited |
| Media credits/day | 5 | 50 | Unlimited |
| Voice minutes/day | 2 | 30 | Unlimited |
| Tool calls/message | 3 | 5 | 10 |
| Memory | Disabled | 30-day retention | 365-day retention |
| Platforms | 1 | 3 | Unlimited |
| Autonomous posts | No | Yes | Yes |

**Code:** `entitlements.ts`, `runtime-limits.ts`, `entitlement-enforcement.ts`

### Web3 Augmentation Layer (auto-boost)

Web3 holdings automatically upgrade entitlement parameters:

| Holding | Effect | Implementation |
|---------|--------|----------------|
| 1+ Orb NFT | Boost free tier to "Orb holder" limits (100 msg, 15 media, 5 voice-min) | `syncRuntimeLimitsToState()` checks `getGateStatus()` |
| Burn tier | Scales `maxEnergy` and `regenPerHour` | Already works via `RuntimeBurnAugmentation` |
| RATI balance | +0.5 energy/hr per 1M tokens (capped +2/hr) | Already works via `bonusPerMillionTokens` |
| Ascension | Permanent Pro-equivalent limits + 1.5x energy | Map to entitlement upgrade on ascension |

**Orb holder boost (proposed limits):**

| Limit | Free | Orb Holder (auto-boosted free) |
|-------|------|-------------------------------|
| Messages/day | 50 | 100 |
| Media credits/day | 5 | 15 |
| Voice minutes/day | 2 | 5 |
| Tool calls/message | 3 | 5 |
| Memory | Disabled | Disabled (requires Pro) |

### Burst Pool (Energy — unified)

Energy becomes the burst mechanism *on top of* entitlement limits, not a parallel gate.

**Current (double-gated):**
```
media request → check entitlement dailyMediaCredits → check energy pool → allow/deny
```

**Target (unified):**
```
media request → check entitlement dailyMediaCredits
  if within limit → allow (no energy cost)
  if limit exhausted → check energy pool for bonus use → allow/deny
```

This means:
- Pro users with 50 media credits/day rarely touch energy
- Free users exhaust 5 credits fast, then energy grants bonus uses
- Web3-active users (Orb holders, RATI burners) get more bonus uses through enhanced energy pools
- Enterprise users have unlimited limits, energy is irrelevant

---

## User Journey Matrix

| User Type | Avatar Creation | Daily Capacity | Expensive Ops | Revenue Source |
|-----------|----------------|----------------|---------------|----------------|
| No wallet | 1 free avatar | Free tier | Energy (base) | Future Stripe |
| Wallet, no Orb | 1 free avatar | Free tier | Energy (base) | Future Stripe |
| Orb holder | 1 + N slots | Boosted free | Energy (enhanced) | Orb purchase |
| RATI burner | (from Orb) | Boosted + burn tier | Energy (burn-scaled) | Token burns |
| Ascended | Permanent via NFT | Pro-equivalent | Energy (1.5x) | Orb + RATI burn |
| Manual Pro | Per entitlement | Pro | Energy + Pro limits | Admin-assigned |
| Enterprise | Unlimited | Unlimited | Unlimited | Custom deal |

---

## M1 Implementation (remaining)

| Task | Size | Description |
|------|------|-------------|
| Orb-holder auto-boost | S | In `syncRuntimeLimitsToState()`, check `getGateStatus()` for avatar's creator/inhabitant. If `nftsHeld >= 1`, apply Orb-holder limit overrides to the RuntimeContract. |
| Unify energy + entitlements | M | In `entitlement-enforcement.ts`, change media/voice checks: if entitlement daily limit allows, pass without energy cost. If daily limit exhausted, fall back to `canUseEnergy()` for burst. Remove the independent energy check in `media.ts` and `voice.ts`. |
| Ascension → tier upgrade | S | In `avatar-ascend.ts` finalization, call `setEntitlement()` with Pro-equivalent limits and `source: 'ascension'`. |
| Update admin UI energy display | S | Show energy as "bonus pool" in status, not primary capacity indicator. |

## M2 Implementation (deferred)

| Task | Size | Description |
|------|------|-------------|
| Stripe Checkout | L | Plan selection → Checkout session → entitlement sync |
| Stripe webhooks | M | Subscription events → update entitlement status |
| Customer portal | S | Self-serve plan management |
| Usage-based overages | M | Bill excess beyond plan limits at end of cycle |

---

## Revenue Streams (unchanged)

1. **NFT Sales:** Gate NFT mint + secondary royalties, Avatar NFT partnerships
2. **Subscriptions (M2):** Stripe tiers ($0 / $9 / $29 / custom)
3. **Token Burns:** RATI burn-to-energy conversion (on-chain revenue)
4. **Usage-Based (M2+):** Overage billing beyond plan limits

---

## Code References

| File | Role |
|------|------|
| `admin-api/src/types.ts` | `EntitlementRecord`, `PlanLimits`, `PLAN_DEFAULTS` |
| `admin-api/src/services/entitlements.ts` | CRUD for entitlement records |
| `admin-api/src/services/runtime-limits.ts` | Sync effective limits to STATE_TABLE |
| `handlers/src/services/entitlement-enforcement.ts` | `RuntimeContract`, atomic usage enforcement |
| `admin-api/src/services/energy.ts` | Energy pool with burn-tier scaling |
| `admin-api/src/services/energy-burn.ts` | Burn-to-energy conversion |
| `admin-api/src/services/nft-gate.ts` | Gate NFT verification, slots |
| `admin-api/src/services/avatar-ascend.ts` | Ascension with Orb + RATI burn |
| `admin-api/src/services/account-gate.ts` | Best-wallet gate status selection for account display (per-wallet, not aggregated) |
| `admin-api/src/handlers/avatar-routes/entitlements.ts` | Admin routes for entitlement management |
