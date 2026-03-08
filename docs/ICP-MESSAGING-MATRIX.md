# ICP Messaging Matrix

**Status:** DRAFT
**Date:** 2026-03-01
**Owner:** Leadership

**Related documents:**
- [ICP.md](ICP.md) -- ideal customer profiles, buying signals, anti-personas
- [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md) -- funnel KPIs, channel strategy
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- tier definitions, pricing
- [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) -- per-ICP setup playbooks
- [design-philosophy.md](design-philosophy.md) -- chat-first design principles

---

## How to Use This Document

Each ICP segment has tailored positioning, messaging, and proof claims. Use these when writing landing pages, outreach messages, demo scripts, or community posts.

**Rules:**
- Only claim features that are shipped and working. Do not reference roadmap items as current capabilities.
- All messaging must reflect the chat-first design: no dashboards, no settings pages, no config files.
- Pricing claims must match [BILLING-STRATEGY.md](BILLING-STRATEGY.md) exactly.

---

## Segment 1: Creator-Operator (Pro, $9/mo)

**Who:** Solo operators managing 1-3 AI avatars across Telegram and Discord for their community.

### Positioning

> Deploy a persistent AI avatar that lives in your Telegram and Discord channels -- with shared memory, consistent personality, and zero infrastructure. Manage everything through chat.

### Key Messages

| Message | Supporting Proof |
|---------|-----------------|
| **"Live in 10 minutes."** Set up an AI avatar on Telegram without writing code or managing servers. | Activation flow: sign in, create avatar, paste BotFather token, send test message. See [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) Playbook 1. |
| **"One personality, every platform."** Your avatar remembers conversations and stays in character across Telegram, Discord, and X. | Platform abstraction layer normalizes all messages to a unified format. Same persona, same memory, different channels. |
| **"Chat is the control panel."** Create avatars, connect platforms, check status, and manage everything by talking to the admin AI. No dashboards, no config files. | Chat-first architecture. See [design-philosophy.md](design-philosophy.md). |
| **"Predictable cost."** $9/mo for 500 messages/day, 3 platforms, 30-day memory. No surprise API bills. | Entitlement-enforced limits. See [BILLING-STRATEGY.md](BILLING-STRATEGY.md). |
| **"Crypto-native, not crypto-required."** Optional Solana wallet integration for Orb NFT holders gets boosted free limits. Email sign-up works without Web3. | Web2 Floor + Web3 Ceiling model. Orb holders get 100 msg/day on free tier. |

### Objection Handling

| Objection | Response |
|-----------|----------|
| "I can build this with the OpenAI API myself." | You can build a stateless chatbot. You cannot easily build persistent memory, multi-platform deployment, webhook management, and operational monitoring. That is what you are paying $9/mo for. |
| "Why not just use Chatfuel or ManyChat?" | Those are rule-based flow builders. AWS Swarm runs a real LLM with persistent memory and consistent personality across platforms. It is an AI avatar, not a decision tree. |
| "What if my avatar says something wrong?" | You control the persona with explicit guardrails. Pause the avatar instantly from the admin chat. All interactions are logged (metadata only, no content stored). |
| "$9/mo is too much for a bot." | $9/mo replaces maintaining your own server, managing API keys, handling webhook failures, and debugging message queues. It is cheaper than one hour of developer time per month. |

### Call to Action

> Create your first avatar free at swarm.rati.chat. Upgrade to Pro when you hit the limits.

---

## Segment 2: Team / Agency Operator (Enterprise, $29/mo)

**Who:** Small teams (2-10 people) or agencies managing multiple AI avatars across client communities.

### Positioning

> Manage a fleet of AI avatars for your clients from one chat interface. Separate personas, separate secrets, separate usage tracking -- one operational view.

### Key Messages

| Message | Supporting Proof |
|---------|-----------------|
| **"One interface, unlimited avatars."** Create and manage avatars for every client without switching tools or dashboards. | Multi-tenant isolation with per-avatar secrets, state, and usage tracking. Admin chat shows all avatars in the sidebar. |
| **"Per-avatar isolation."** Each avatar has its own secrets, memory, persona, and usage counters. No cross-contamination. | DynamoDB partition key isolation (`AVATAR#{id}`). Write-only secrets per avatar in AWS Secrets Manager. |
| **"Unlimited capacity."** Unlimited messages, platforms, and media. 365-day memory retention. | Enterprise tier entitlements. See [BILLING-STRATEGY.md](BILLING-STRATEGY.md). |
| **"Audit-ready operations."** Every interaction logged with structured metadata. Avatars can be paused and resumed instantly. | Structured JSON logging with avatarId, platform, event type, requestId. No PII in logs. |
| **"$29/mo, not $29/avatar."** Flat rate for unlimited capacity. The cost of one hour of contractor time covers your entire avatar fleet. | Single subscription covers all avatars under the account. |

### Objection Handling

| Objection | Response |
|-----------|----------|
| "We need RBAC and SSO." | Those are M3 roadmap items. Enterprise design partners can influence the governance roadmap. Current controls: per-avatar isolation, audit logging, pause/resume, memory management. |
| "Can we white-label this for clients?" | Not currently. Each client would interact with the avatar on their own platform (Telegram, Discord). The admin interface at swarm.rati.chat is your operational layer. |
| "What happens if you go down?" | Operational runbook covers incident response. See [RUNBOOK.md](RUNBOOK.md). SQS queues buffer messages during outages. Webhook retries handle transient failures. |
| "$29/mo seems too cheap. What is the catch?" | No catch. The M2 price is set low to acquire design partners and validate the model. Pricing may adjust for GA based on usage patterns and feedback. |

### Call to Action

> Start with Pro. When you are managing 3+ avatars, upgrade to Enterprise for unlimited capacity and audit controls.

---

## Segment 3: Enterprise Design Partner

**Who:** Governance-sensitive organizations evaluating the platform during M2. Participating under a design partner agreement.

### Positioning

> Shape the governance layer of a next-generation AI avatar platform. Get Enterprise access, direct feedback channel, and influence over the security and compliance roadmap.

### Key Messages

| Message | Supporting Proof |
|---------|-----------------|
| **"Write-only secret management."** Bot tokens and API keys are stored encrypted and can never be read back through the UI or API. | AWS Secrets Manager with KMS encryption. Write-only access pattern enforced at the API layer. |
| **"Metadata-only audit trail."** Every interaction is logged with structured metadata (avatar, platform, event type, timestamp). Message content is never stored in logs. | Structured JSON logging. See [design-philosophy.md](design-philosophy.md) logging section. |
| **"Instant operational controls."** Pause an avatar with one command. Resume when ready. No deployment needed. | Admin chat commands: `Pause <avatar>`, `Resume <avatar>`. State change is immediate. |
| **"Memory is inspectable and deletable."** View, export, and delete avatar memories. Full DSAR support. | Memory TTL, selective delete, bulk delete, and export implemented. See [DSAR-WORKFLOW.md](DSAR-WORKFLOW.md). |
| **"Bi-weekly feedback loop."** Design partners get direct access to the platform team to report governance gaps and request features. | Design partner agreement includes structured feedback cadence. |

### Objection Handling

| Objection | Response |
|-----------|----------|
| "We need SOC2 / ISO 27001." | Not certified yet. The platform implements the underlying controls (encryption at rest, write-only secrets, audit logging, data retention policies). Certification is a future milestone. |
| "Where is the data stored?" | All data is in AWS (us-east-1). DynamoDB for state, Secrets Manager for credentials, S3 for media. See [DATA-RETENTION-MATRIX.md](DATA-RETENTION-MATRIX.md) for retention schedule. |
| "Can we run this on our own infrastructure?" | Not currently. The platform is multi-tenant SaaS on AWS serverless. Dedicated tenancy is a potential M3+ offering for large enterprise customers. |

### Call to Action

> Apply for the Design Partner Program. Limited to 10 organizations. Contact the platform team to discuss your governance requirements.

---

## Messaging Do's and Don'ts

### Do

- Emphasize "chat-first" as the primary differentiator. No other platform manages AI avatars entirely through conversation.
- Lead with the 10-minute activation claim -- it is verifiable and compelling.
- Reference specific entitlement limits and pricing from BILLING-STRATEGY.md.
- Mention Web3 as optional, not required. Email sign-up is the default path.

### Don't

- Do not claim features on the roadmap as shipped (e.g., Stripe self-serve checkout, RBAC, SSO).
- Do not position AWS Swarm as a consumer chatbot or personal assistant. It is an operator tool for deploying avatars in communities.
- Do not overemphasize Web3/NFT to non-crypto audiences. Lead with the product, mention Web3 as an augmentation.
- Do not promise SLAs or uptime guarantees that are not backed by operational infrastructure.

---

*This document is a DRAFT. Messaging will be refined based on design-partner feedback and conversion data.*
