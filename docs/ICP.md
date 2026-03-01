# Ideal Customer Profile (ICP)

**Status:** DRAFT -- needs validation through design-partner conversations
**Date:** 2026-03-01
**Owner:** Leadership
**Charter Reference:** PROJECT-CHARTER.md Risk R8, Section 1b (Public Billing Launch gate)

**Related documents:**
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- tier definitions, entitlement limits, pricing
- [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md) -- funnel KPIs, channel strategy, activation flow
- [ICP-MESSAGING-MATRIX.md](ICP-MESSAGING-MATRIX.md) -- positioning, messaging, proof claims
- [PROJECT-CHARTER.md](PROJECT-CHARTER.md) -- revenue activation gate, stop/go clause

---

## Why This Document Exists

The Project Charter (R8) identifies "No clear ICP defined for paying users" as high-probability, high-impact risk. Stripe activation alone does not equal revenue readiness. Section 1b requires ICP validation with at least 5 design-partner conversations before public billing launch.

This document defines who we believe our paying customers are, what signals indicate readiness to pay, and how we will validate these assumptions before turning on public billing.

---

## 1. Primary ICP: Creator-Operator (Pro Tier, $9/mo)

### Who They Are

Solo operators or very small teams (1-2 people) who want persistent AI avatars operating across messaging platforms on their behalf. They are technically comfortable (can follow a setup guide, understand API tokens) but are not infrastructure engineers. They do not want to manage servers, write deployment scripts, or debug message queues.

**Typical backgrounds:**
- NFT community managers who need automated engagement across Telegram and Discord channels
- Content creators building an AI-powered social presence (a "digital twin" or branded persona)
- Crypto/Web3 project founders who want a community-facing avatar that answers questions, shares updates, and stays online 24/7
- Small DAO operators who need multi-platform bot management without hiring a developer
- Telegram channel admins managing active communities who want intelligent automated engagement beyond simple command bots

### What Pain They Have

1. **Building a persistent bot is a full-time DevOps job.** They have tried OpenAI API wrappers, Telegram bot frameworks, or hosted chatbot tools. Every option either forgets conversations, breaks silently, or requires constant babysitting.
2. **Multi-platform presence is fragmented.** They run separate bots on Telegram, Discord, and X with no shared memory, inconsistent personality, and no centralized management.
3. **Cost is unpredictable.** Direct API usage leads to surprise bills. They want clear, bounded costs.
4. **No operational visibility.** When the bot goes down or behaves oddly, they have no way to diagnose or fix it without reading code.

### Why They Would Pay $9/mo

The Free tier (50 messages/day, 1 platform, no memory) is enough to test the product, but not enough to run a real operation. The upgrade triggers are concrete:

| Free Limit Hit | Pro Unlocks |
|----------------|-------------|
| 50 messages/day exhausted | 500 messages/day |
| No memory (avatar forgets everything) | 30-day memory retention |
| 1 platform only | 3 platforms simultaneously |
| 5 media credits/day | 50 media credits/day |
| No autonomous posting | Autonomous posting enabled |

$9/mo is cheaper than any alternative that provides persistent memory, multi-platform deployment, and operational guardrails. The comparison is not "$9 vs free chatbot" -- it is "$9 vs building and maintaining your own infrastructure."

### Firmographic Filters

- **Community size:** 50-5,000 members across platforms
- **Platform presence:** Active on at least Telegram or Discord; considering expansion to a second platform
- **Web3 affinity:** Familiar with wallets; may hold Orb NFTs or RATI tokens (but not required)
- **Budget:** Has discretionary budget for tooling ($10-50/mo range)
- **Technical level:** Can follow guided setup flows; comfortable with BotFather; does not want to write code

---

## 2. Secondary ICP: Team / Agency Operator (Enterprise Tier, $29/mo)

### Who They Are

Small teams (2-10 people) or agencies managing multiple AI avatars across client communities or internal projects. They need reliability, per-avatar cost visibility, and the ability to scale avatar count without scaling operational burden.

**Typical backgrounds:**
- Agencies managing community engagement for multiple crypto/NFT projects
- Web3 marketing firms offering "AI community manager" as a service
- Multi-project teams (e.g., a studio running 3-5 projects, each with its own community avatar)
- DAO tooling teams providing automated governance or community interfaces

### What Pain They Have

1. **Scaling from 1 bot to many creates drift.** Inconsistent behavior across avatars, unclear per-avatar costs, no shared visibility.
2. **Each new client multiplies operational burden.** Separate bot deployments, separate monitoring, separate debugging.
3. **No centralized management.** Context-switching between different bot platforms and dashboards for each client.
4. **Accountability gaps.** No audit trail for what avatars did, no way to enforce standards across deployments.

### Why They Would Pay $29/mo

The jump from Pro to Enterprise is justified by operational needs that emerge at scale:

| Pro Limit | Enterprise Unlocks |
|-----------|--------------------|
| 500 messages/day | Unlimited messages |
| 3 platforms | Unlimited platforms |
| 50 media credits/day | Unlimited media |
| 30-day memory | 365-day memory retention |
| 5 tool calls/message | 10 tool calls/message |

$29/mo for unlimited capacity across unlimited platforms is the cost of one hour of contractor time. For an agency managing 3+ client avatars, the ROI is immediate.

### Firmographic Filters

- **Team size:** 2-10 people with shared operational responsibility
- **Avatar count:** Managing or planning to manage 3+ avatars
- **Client-facing:** Delivers avatar services to external clients or communities
- **Revenue model:** Charges clients for community management or engagement services
- **Compliance awareness:** Needs audit trails and operational visibility for client reporting

---

## 3. Anti-Personas (Who This Is NOT For)

Clearly defining who we do not serve prevents wasted effort and misaligned expectations.

### Enterprise SaaS Teams

**Why not:** They need SSO, RBAC, SOC2, SLA guarantees, and vendor procurement processes. Our M2 product does not have organizational governance features (M3 roadmap). Premature enterprise sales would overfit the roadmap before validating the core business.

**Exception:** Enterprise design partners who explicitly accept M2 limitations in exchange for influencing the governance roadmap.

### Individual Chatbot Users

**Why not:** People who want a personal AI assistant for private use. Our product is built for avatars that operate in public/community channels. The $9/mo price point is too high for casual personal use, and the platform features (multi-platform deployment, operational monitoring) are irrelevant to individual users.

### Spam / Scam Operators

**Why not:** Accounts using avatars for unsolicited mass messaging, impersonation, market manipulation, or any AUP violation. Auto-suspension and moderation guardrails are enforcement mechanisms, not just policies.

**Detection signals:** Abnormal message volume patterns, multiple avatars with identical personas, community reports, banned platform accounts.

### "Just Exploring" Users

**Why not for paid tiers:** Curiosity-driven signups who create an avatar, send a few messages, and never return. They are fine on the Free tier but should not be targeted for paid conversion. Premature upgrade prompts to explorers degrade the experience for everyone.

**Distinction:** An explorer becomes a prospect when they hit Free tier limits and express frustration -- that is a buying signal, not just usage.

---

## 4. Key Buying Signals

These are observable behaviors that indicate a user is ready to pay or should be approached for design-partner conversations.

### Strong Signals (High Conversion Likelihood)

| Signal | What It Means | How to Detect |
|--------|---------------|---------------|
| Free tier message limit hit repeatedly | Avatar is actively used and the operator wants more | Entitlement enforcement logs: daily limit exhaustion events |
| Second platform connection attempted on Free | Operator wants multi-platform but is blocked by tier | Platform config attempts that fail entitlement check |
| Memory-dependent conversation patterns | Avatar's value depends on remembering context | Operator asks about memory in admin chat; conversation quality degrades without it |
| Avatar active for 7+ consecutive days | Operator has integrated the avatar into their workflow | F4 funnel event (day-7 active) |
| Multiple avatars created (Free allows 1 via Orb) | Operator needs fleet management | Avatar creation attempts beyond free slot |

### Moderate Signals (Nurture, Do Not Hard-Sell)

| Signal | What It Means |
|--------|---------------|
| Orb NFT holder | Web3-engaged, likely to value the platform's hybrid model |
| Active in Swarm community channels | Engaged with the ecosystem, aware of product capabilities |
| Asks about pricing or limits in admin chat | Considering whether to invest |
| Shares avatar publicly (social proof) | Values the avatar enough to associate it with their identity |

### Weak Signals (Monitor Only)

| Signal | What It Means |
|--------|---------------|
| Account created but no avatar | Did not activate -- diagnose onboarding friction, do not sell |
| Avatar created but no live messages | Setup completed but value not proven -- fix activation, do not sell |
| Single session, never returned | Explorer, not a prospect |

---

## 5. Design Partner Beta Criteria

The Project Charter (Section 1b) permits a Design Partner Paid Beta before the full public billing gate. Maximum 10 customers, manual onboarding, with the purpose of validating ICP, testing billing flow, and gathering feedback.

### What Makes a Good Design Partner

| Criterion | Why It Matters | How to Verify |
|-----------|---------------|---------------|
| Active community (Discord or Telegram, 50+ members) | They have a real use case, not a hypothetical one | Check community links, member counts |
| Currently running some form of bot or automation | They understand the problem space and can compare | Ask what they use now and what breaks |
| Willing to give structured feedback | Design partners are not just early customers -- they inform the product | Explicit agreement to monthly check-in calls |
| Has a concrete use case, not "just exploring" | Feedback from real usage is 10x more valuable than speculative feedback | Ask: "What will your avatar do on day 1?" -- specific answer required |
| Budget holder or direct influence on budget | Can validate pricing, not just product | Ask: "If this works, would you pay $9/mo?" -- needs a real yes, not "maybe" |
| Ideally holds Orb NFTs or RATI tokens | Web3-native users understand the hybrid model and provide feedback on both layers | Check wallet holdings via platform auth |
| Available for 30-day pilot minimum | Short trials do not produce meaningful signal | Commitment to 30-day active usage |

### Design Partner Disqualifiers

- No active community (building one "someday")
- Expects enterprise governance features that are on the M3 roadmap
- Unwilling to provide feedback or participate in check-ins
- Primary interest is free access, not product validation
- Use case requires features that do not exist and are not planned

### Design Partner Onboarding Process

1. **Qualification call** (15-30 min): Confirm criteria above. Explain Beta terms (support expectations, refund policy, feedback commitment).
2. **Manual account setup**: Create avatar, assign Pro entitlement manually, connect platforms.
3. **Day-1 checkpoint**: Confirm first live response delivered. Resolve any setup blockers.
4. **Day-7 check-in**: Is the avatar actively used? What is working, what is not?
5. **Day-14 feedback session**: Structured interview covering pricing, feature gaps, competitive alternatives.
6. **Day-30 review**: Continue/cancel decision. Document learnings.

---

## 6. Validation Plan: 5+ Design Partner Conversations

The Project Charter requires ICP validation with at least 5 design-partner conversations before public billing launch. This section defines what "validated" means.

### Conversation Goals

Each design-partner conversation must answer:

1. **Problem validation:** Does this person actually have the pain we described in the ICP? (Or did we invent it?)
2. **Solution validation:** Does the product solve their problem? What is missing?
3. **Pricing validation:** Is $9/mo (Pro) or $29/mo (Enterprise) a price they would pay? What would they compare it to?
4. **Channel validation:** How did they hear about Swarm? Where would they look for this kind of tool?
5. **Retention signal:** After 7 days of use, is the avatar still active? Would they miss it if it disappeared?

### What "Validated" Means

The ICP is validated when at least 5 conversations produce convergent answers to questions 1-5 above. Specifically:

- **3 of 5** confirm the pain described in the ICP (problem-solution fit)
- **3 of 5** say the pricing is "reasonable" or "cheap" (not "too expensive" or "I'd need to think about it")
- **4 of 5** have an avatar that is active on day 7 (retention signal)
- **0 of 5** churn within 30 days due to missing features that are on the M2 roadmap (we shipped enough)

If these thresholds are not met, the ICP must be revised and another round of 5 conversations conducted before public billing launch.

### Conversation Script (Outline)

Use this as a guide, not a rigid script. The goal is honest signal, not leading questions.

**Opening (2 min):**
- Thank them for participating.
- Explain: "We are trying to understand whether we built the right product for the right people. Honest negative feedback is more valuable than polite positive feedback."

**Problem exploration (5-10 min):**
- "Tell me about how you manage your community today."
- "What tools do you use for bots or automation? What breaks?"
- "If you could wave a magic wand, what would your ideal setup look like?"

**Product experience (5-10 min):**
- "Walk me through your experience setting up your avatar."
- "What surprised you? What frustrated you?"
- "Is the avatar doing what you expected? What is missing?"

**Pricing (5 min):**
- "You are on the Pro plan at $9/mo. Does that feel right for what you are getting?"
- "What would you compare this price to? What alternatives did you consider?"
- "At what price would you stop paying?"

**Closing (2 min):**
- "Would you recommend this to someone in a similar situation? Who?"
- "What is the one thing we should fix before launching publicly?"

### Tracking

| Partner | Date | ICP Match? | Pain Confirmed? | Price OK? | Day-7 Active? | Day-30 Retained? | Key Feedback |
|---------|------|-----------|-----------------|-----------|---------------|------------------|--------------|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |

---

## 7. ICP-to-Tier Mapping Summary

| Dimension | Free | Pro ($9/mo) | Enterprise ($29/mo) |
|-----------|------|-------------|---------------------|
| **ICP** | Explorers, evaluators | Creator-Operators (P1) | Team/Agency Operators (P2) |
| **Avatar count** | 1 | 1-3 | 3+ |
| **Platform count** | 1 | Up to 3 | Unlimited |
| **Key need** | Try the product | Run a real avatar operation | Manage a fleet of avatars |
| **Upgrade trigger** | -- | Hit message/memory/platform limits | Multi-avatar, unlimited capacity, audit needs |
| **Revenue per user** | $0 | $9/mo | $29/mo |
| **Support model** | Self-serve (docs + chat) | Self-serve + community | Manual onboarding + priority support |

---

## 8. Acquisition Channels (Where to Find These People)

### For Creator-Operators (Pro)

| Channel | Approach | Expected Yield |
|---------|----------|----------------|
| Telegram bot/automation communities | Share avatar demos, answer setup questions | Medium -- high intent, right platform |
| Discord server operator communities | Show multi-platform value proposition | Medium -- natural expansion audience |
| Crypto/NFT project communities (Twitter/X, Discord) | Target project founders managing communities | High -- acute pain, budget available |
| Solana ecosystem channels | Leverage existing Orb NFT holders | High -- already invested in ecosystem |
| Product Hunt / Indie Hacker communities | Launch with "AI avatar in 10 minutes" angle | Medium -- broad reach, lower intent |

### For Team/Agency Operators (Enterprise)

| Channel | Approach | Expected Yield |
|---------|----------|----------------|
| Web3 marketing agency networks | Direct outreach to agencies managing multiple communities | High -- exact fit, highest ARPU |
| DAO tooling communities | Show multi-avatar governance and cost tracking | Medium -- emerging need |
| Referrals from active Pro users | "Managing avatars for clients? Upgrade to Enterprise." | High -- warm leads, validated need |

---

## 9. Open Questions (Resolve During Validation)

These are assumptions embedded in this ICP that must be tested, not assumed:

1. **Is "NFT community manager" a real job title, or are we inventing a category?** If most target users do not self-identify this way, our messaging will miss.
2. **Is $9/mo the right price, or is it leaving money on the table?** Design-partner conversations should probe willingness to pay $15 or $19.
3. **Does the Web3 layer (Orb NFTs, RATI tokens) attract or repel the primary ICP?** Some operators may see wallet auth as friction, not value.
4. **Is Telegram-first the right beachhead, or should it be Discord-first?** Depends on where the highest-pain operators live.
5. **How many Pro users naturally expand to Enterprise?** If the expansion motion is weak, the two-tier model may need restructuring.

---

## 10. Revision History

| Version | Date | Change |
|---------|------|--------|
| 0.1 (DRAFT) | 2026-03-01 | Initial ICP definition -- needs validation through design-partner conversations |

---

*This document is a DRAFT. Every assumption in it must be tested against real conversations with real potential customers. Do not treat this as validated truth until the tracking table in Section 6 has 5 completed rows with convergent results.*
