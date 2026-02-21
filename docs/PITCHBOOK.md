# AWS Swarm Pitchbook

Status: Draft v1 (living document)  
Last updated: 2026-02-21  
Primary owner: Product + GTM

## 1) Purpose

This is the canonical messaging and pitch document for AWS Swarm.  
It translates product strategy into talk tracks for:

1. Landing pages and product copy
2. Founder and sales calls
3. Demo scripts
4. Investor and partner conversations
5. Content and social narratives

This document should be refined weekly from real customer conversations and funnel data.

Related strategy docs:

1. `VISION.md`
2. `docs/GTM-STRATEGY-M2.md`
3. `docs/MARKETING-STRATEGY-M2.md`
4. `docs/BILLING-STRATEGY.md`
5. `ROADMAP.md`

## 2) Positioning Core

### Category

Reliable multi-platform AI avatar operations platform.

### Problem we solve

Most teams can launch a bot, but cannot operate one reliably across channels without becoming the on-call engineer.

### Promise

AWS Swarm gives you an always-on AI cast that runs across Telegram, Discord, X, and web from one chat-first control room.

### Why now

1. Teams want persistent AI presence, not one-off demos.
2. Multi-channel operations are becoming mandatory.
3. Cost, safety, and governance constraints are now buyer requirements.

### Proof pillars

1. Reliability by design: queue-based runtime, retries, DLQs, runbooks.
2. Safe autonomy: entitlement enforcement, tool gating, spend controls.
3. Persistent identity: memory + multi-platform continuity.
4. Chat-first operations: configure and operate through conversational workflows.

## 3) Messaging Modes

Use one mode depending on audience and context.

### Mode A: Operator-Credible (default)

"Run persistent AI avatars across channels with reliability and guardrails built in."

Use when:

1. Technical buyers
2. Security/governance-sensitive teams
3. Documentation and product pages

### Mode B: Bold/Creator (high-energy top-of-funnel)

"Build a cast, not a bot."

"Your digital crew works 24/7 while you sleep."

Use when:

1. Social content
2. Creator acquisition
3. Demo trailers

### Mode C: Executive/ROI

"Cut time-to-live-avatar and on-call operational load while keeping autonomy controllable."

Use when:

1. Team/agency buyers
2. Budget owners
3. Enterprise design-partner conversations

## 4) Messaging Library

### Tagline options

1. Build a cast, not a bot.
2. Your avatar. Every platform. Always on.
3. One control room. Infinite personalities.
4. Your digital crew, on duty 24/7.

Recommended current default:

1. Website/docs: "Your avatar. Every platform. Always on."
2. Campaign/social: "Build a cast, not a bot."

### One-liners

Operator-safe:

"AWS Swarm helps you run persistent AI avatars across Telegram, Discord, X, and web with reliability, governance, and cost controls built in."

Sexier top-of-funnel:

"AWS Swarm turns one brand voice into an always-on digital cast that engages everywhere."

### 30-second pitch

"Most teams can spin up a bot, but it breaks the moment traffic, multi-platform complexity, or cost pressure hits. AWS Swarm is the operations layer for autonomous avatars: one chat-first control plane, queue-backed runtime reliability, and policy guardrails so avatars stay useful instead of risky."

### 2-minute founder pitch

"AWS Swarm is the platform for running AI avatars as an operational system, not a demo. We let teams launch one identity across Telegram, Discord, X, and web, then operate it from a chat-first control room. Under the hood we use a reliability-first architecture with queues, deterministic processing, and recovery paths. On top of that we enforce safe autonomy with entitlement limits, tool gating, and observability. The result is simple: you get the upside of always-on AI presence without becoming on-call for fragile bot infrastructure."

## 5) ICP Talk Tracks

| Segment                        | Core pain                                                   | Promise                                      | Proof                                                    | CTA                           |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| Creator-Operator (P1)          | Bot is brittle, hard to scale, and expensive when it drifts | Launch fast, stay live, and keep control     | Chat-first setup, guardrails, multi-platform continuity  | Launch first avatar           |
| Small Team / Agency (P2)       | 5+ bots create operational chaos and no shared visibility   | Operate many avatars from one system         | Shared runtime, account model, diagnostics               | Start Pro / team conversation |
| Enterprise Design Partner (P3) | Autonomy is risky without governance                        | Controlled automation with auditability path | Policy direction, observability, roadmap to org controls | Apply as design partner       |

## 6) Claim-to-Proof Map

Only use claims in public that are defensible with current product state.

| Claim                                           | Can we claim now?  | Evidence anchor                                      |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------- |
| "Launch first outcome in under 10 minutes"      | Yes (target claim) | `VISION.md` success criteria + onboarding flows      |
| "Built for reliability, not just demos"         | Yes                | Queue-based runtime, DLQ, runbook, alarms            |
| "Safe by default"                               | Yes                | Entitlements, gating, internal policy controls       |
| "Persistent memory with retention controls"     | Yes                | M1 completion and memory controls                    |
| "Enterprise-grade compliance controls complete" | Not yet            | Position as roadmap/design-partner direction         |
| "Fully automated self-serve billing live"       | Partially          | Entitlements live; Stripe positioned as M2 evolution |

## 7) Objection Handling

### "We already have a custom bot."

Response:

"Keep your persona logic. AWS Swarm replaces the brittle operations layer: reliability, multi-platform orchestration, and guardrails."

### "Is this just another chatbot?"

Response:

"No. Chatbots answer prompts. AWS Swarm runs persistent channel operations with policy, limits, and observability."

### "Web3 sounds risky/confusing for our users."

Response:

"Core product is web2-first. Web3 is optional augmentation, never a paywall."

### "How do you prevent runaway costs?"

Response:

"Limits are enforced at runtime, with usage tracking and explicit entitlement controls."

### "How do we trust autonomous actions?"

Response:

"Boundaries come first: tool gating, approval patterns for risky actions, and auditable operational traces."

## 8) Packaging Narrative

Use the same frame everywhere:

1. Entitlements set the floor (predictable capacity and features).
2. Web3 augments the ceiling (optional boosts and unlocks).
3. Energy acts as burst capacity, not a confusing parallel billing model.

Do not present pricing as token-first. Present plan value first, augmentation second.

## 9) Deck Spine (12 Slides)

1. Title: Build a cast, not a bot.
2. Problem: Bots are easy to launch, hard to operate.
3. Why now: always-on communities + multi-platform pressure.
4. Product: what AWS Swarm is (control plane + runtime plane).
5. Demo flow: create -> configure -> first live response.
6. Reliability story: queue runtime, recovery, observability.
7. Safety story: limits, policy, governance primitives.
8. ICP and use cases: creator, team/agency, design partner.
9. Business model: free/pro/enterprise + optional web3 augmentation.
10. Traction/KPIs: activation, retention, conversion.
11. Roadmap: M2 hardening -> M3 persistence -> M4 ecosystem.
12. Close: CTA and next step.

## 10) Demo Storyline

Use this sequence for calls and videos:

1. Create avatar in admin chat.
2. Configure channel credentials and safety limits.
3. Send first live message in Telegram.
4. Show usage/limits and operational visibility.
5. Show one multi-platform extension (Discord or X).
6. Close with "what changes when you scale to 10 avatars."

## 11) What We Say vs Avoid

### Say

1. Reliable by design
2. Chat-first operations
3. Persistent identity across channels
4. Guardrails and cost control
5. Web3 as optional upside

### Avoid

1. "Set and forget AI"
2. "Fully autonomous with no oversight"
3. "Enterprise-complete compliance today" (until controls are delivered)
4. Token/speculation-heavy framing for mainstream buyers

## 12) Weekly Refinement Workflow

### Inputs

1. Funnel data (`F0` to `F6` from GTM strategy)
2. Sales/discovery call notes
3. Objection frequency in onboarding/support
4. Content performance (CTR, activation contribution)

### Weekly review questions

1. Which line got the highest conversion?
2. Which promise triggered the most skepticism?
3. Which ICP is converting fastest right now?
4. Which claim needs stronger proof or softer wording?

### Update cadence

1. Update this pitchbook weekly.
2. Update top-level website/social copy biweekly.
3. Run at least one messaging experiment per week.

## 13) Open Decisions (Leadership)

1. Which primary tagline should anchor M2 launch?
2. Do we lead with "operator reliability" or "digital cast" on homepage hero?
3. How much web3 language appears above the fold for P1/P2 audiences?
4. Which 2-3 proof metrics are public in launch materials?
5. Which segment owns week-1 focus: creator-operator only, or creator + team split?

---

## Appendix A: Short-form Copy Bank

### Hero options

1. Build a cast, not a bot.
2. Your avatar. Every platform. Always on.
3. One brand voice, running everywhere.
4. The ops layer for autonomous avatars.

### CTA options

1. Launch your first avatar
2. See a live demo
3. Run your first channel in 10 minutes
4. Start free, scale with guardrails

### Social hooks

1. "Most bots fail in ops, not in demos."
2. "You don't need another prompt toy. You need a reliable AI crew."
3. "From one avatar to ten, without becoming on-call."
