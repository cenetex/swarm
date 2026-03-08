# Go-to-Market Strategy -- M2

**Status:** DRAFT
**Date:** 2026-03-01
**Owner:** Leadership

**Related documents:**
- [ICP.md](ICP.md) -- ideal customer profiles, buying signals, design partner criteria
- [ICP-MESSAGING-MATRIX.md](ICP-MESSAGING-MATRIX.md) -- positioning, messaging, proof claims per ICP segment
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- tier definitions, entitlement limits, pricing
- [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) -- per-ICP launch playbooks with step-by-step setup
- [PROJECT-CHARTER.md](PROJECT-CHARTER.md) -- revenue activation gate, stop/go clause

---

## 1. GTM Objective

Launch paid tiers (Pro at $9/mo, Enterprise at $29/mo) via Stripe, validated by at least 5 design-partner conversations (per PROJECT-CHARTER Section 1b). The goal is predictable, subscription-based revenue layered on top of existing Web3 revenue (Orb NFT sales, RATI token burns).

---

## 2. Funnel Definition

The activation funnel tracks a user from first visit to retained paying customer.

| Stage | Event | Definition | KPI Target |
|-------|-------|------------|------------|
| F1 | Visit | Lands on swarm.rati.chat | -- |
| F2 | Sign-up | Creates account (email or wallet) | 40% of F1 |
| F3 | Activation | First live response delivered on any platform | 60% of F2 |
| F4 | Retention | Avatar active on day 7 | 50% of F3 |
| F5 | Conversion | Upgrades to Pro or Enterprise | 10% of F4 |
| F6 | Expansion | Adds second avatar or second platform | 20% of F5 |

### Key Metrics

- **Time-to-first-response (TTFR):** Target under 10 minutes from sign-up to F3.
- **Day-7 retention rate:** Target 50% of activated users.
- **Free-to-Pro conversion rate:** Target 10% of retained users within 30 days.
- **Monthly recurring revenue (MRR):** Track from first Stripe subscription.

---

## 3. Channel Strategy

### Primary Channels (High Intent)

| Channel | Audience | Tactic | Owner |
|---------|----------|--------|-------|
| Solana ecosystem (Discord, X) | Orb NFT holders, RATI token holders | Direct outreach, Orb-holder auto-boost as hook | Community |
| Telegram bot communities | Operators running community bots | Demo "avatar in 10 minutes" flow, share in bot-building groups | Marketing |
| Crypto/NFT project founders | Community managers for token projects | Targeted DMs with demo video, offer design-partner slots | Sales |

### Secondary Channels (Broad Reach)

| Channel | Audience | Tactic | Owner |
|---------|----------|--------|-------|
| Product Hunt | Indie hackers, tool enthusiasts | Launch with "Deploy an AI avatar in 10 minutes" positioning | Marketing |
| Discord server operator communities | Server admins looking for bot upgrades | Show multi-platform value, chat-first differentiation | Community |
| Web3 marketing agencies | Agencies managing multiple communities | Enterprise pitch: fleet management from one chat interface | Sales |

### Channel Prioritization

Focus M2 effort on primary channels. Secondary channels are opportunistic -- do not invest in paid acquisition until Free-to-Pro conversion rate exceeds 8%.

---

## 4. Activation Flow

The activation flow is the critical path from sign-up to first live response. Every step happens inside the admin chat at swarm.rati.chat (see [design-philosophy.md](design-philosophy.md)).

```
Sign up (email or wallet)
    |
    v
Admin chat welcome message
    |
    v
"Create a new avatar called <name>"
    |
    v
"Set up Telegram for <name>" --> inline secret prompt --> token entered --> webhook registered
    |
    v
Send test message on Telegram --> avatar responds (F3: Activation)
```

**Target:** Under 10 minutes from sign-up to F3.

**Friction points to monitor:**
- BotFather token creation (external dependency, cannot control)
- Webhook registration failures (monitor error rates)
- Cold-start latency on first message (Lambda cold start)

See [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) for detailed setup guides per ICP segment.

---

## 5. Pricing and Upgrade Triggers

Pricing is defined in [BILLING-STRATEGY.md](BILLING-STRATEGY.md). The GTM motion relies on natural limit-hitting as the primary upgrade trigger.

| Trigger | Free Limit | Pro Unlocks | Detection |
|---------|-----------|-------------|-----------|
| Message exhaustion | 50/day | 500/day | Entitlement enforcement logs |
| Platform expansion | 1 platform | 3 platforms | Platform config attempt blocked |
| Memory need | Disabled | 30-day retention | User asks about memory in admin chat |
| Autonomous posting | Disabled | Enabled | User asks about scheduled posts |

**Upgrade flow:** User hits a limit --> admin chat explains the limit and offers upgrade --> inline Stripe Checkout (M2) --> entitlement synced immediately.

Orb NFT holders get boosted free limits (100 msg/day, 15 media credits) as an automatic augmentation, which delays but does not eliminate the upgrade trigger.

---

## 6. Competitive Positioning

AWS Swarm competes against three categories:

| Category | Examples | Swarm Differentiation |
|----------|----------|----------------------|
| DIY bot frameworks | Telegraf, discord.js, custom OpenAI wrappers | No infrastructure to manage. Chat-first setup. Persistent memory. Multi-platform from one interface. |
| Hosted chatbot platforms | Chatfuel, ManyChat, Botpress | AI-native (not rule-based). Personality persistence across platforms. Web3 integration (optional). |
| AI agent platforms | Character.ai, Replika | Operator-controlled (not consumer toy). Multi-platform deployment. Operational visibility and audit. |

**Core positioning statement:** AWS Swarm lets you deploy persistent AI avatars across Telegram, Discord, and X in minutes -- with shared memory, operational controls, and no infrastructure to manage. Everything happens through chat.

See [ICP-MESSAGING-MATRIX.md](ICP-MESSAGING-MATRIX.md) for segment-specific messaging.

---

## 7. Design Partner Program (Pre-Launch)

Before public billing launch, validate the ICP and pricing through a Design Partner Beta (max 10 customers). See [ICP.md](ICP.md) Section 5-6 for criteria and validation plan.

**Timeline:**
1. Recruit 5-10 design partners from primary channels.
2. Manual onboarding with Pro or Enterprise entitlements.
3. 30-day active usage period with structured feedback.
4. Validate ICP assumptions (see ICP.md Section 6 thresholds).
5. If validated: launch public Stripe billing.
6. If not validated: revise ICP, recruit new cohort.

---

## 8. Launch Sequence

| Phase | Gate | Action |
|-------|------|--------|
| Pre-launch | Design partners recruited | Manual onboarding, feedback collection |
| Validation | 5+ conversations with convergent results | ICP confirmed or revised |
| Soft launch | Stripe integration tested | Enable self-serve upgrade for existing users |
| Public launch | Conversion rate > 5% in soft launch | Open acquisition channels, Product Hunt, content marketing |

---

## 9. Success Criteria (M2 Exit)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Design partner conversations completed | 5+ | Tracking table in ICP.md |
| Day-7 retention rate (design partners) | 80% | F4 funnel event |
| Free-to-Pro conversion rate | > 5% | Stripe subscription count / F4 count |
| MRR | > $0 (any paid customer) | Stripe dashboard |
| TTFR (time-to-first-response) | < 10 minutes median | Activation funnel logs |
| NPS from design partners | > 30 | Post-pilot survey |

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ICP assumptions wrong (nobody wants to pay $9/mo) | Medium | High | Design partner validation before public launch |
| Web3 layer repels non-crypto users | Medium | Medium | Wallet auth is optional; email sign-up works without Web3 |
| Telegram-first limits addressable market | Low | Medium | Discord support shipped; X support in progress |
| Cold-start latency degrades activation | Medium | Medium | Monitor TTFR; provisioned concurrency if needed |
| Stripe integration delays block M2 | Low | High | Manual entitlement assignment as fallback |

---

*This document is a DRAFT. It will be updated as design-partner feedback informs channel strategy, pricing, and positioning.*
