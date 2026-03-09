# Product Positioning

**Date:** 2026-03-08

---

## One-liner

**Swarm** gives you AI avatars that live on Telegram, Discord, and X — with persistent memory, a personality you define, and zero infrastructure to manage.

## The problem

Running an AI presence across messaging platforms is a full-time DevOps job. Every option today forces a tradeoff:

| What exists | What's wrong with it |
|-------------|---------------------|
| Raw API wrappers (OpenAI + Telegram bot framework) | No memory, no personality persistence, breaks silently, you maintain the server |
| Hosted chatbot builders (Chatfuel, ManyChat, Botpress) | Template-driven, no real AI reasoning, no cross-platform identity |
| Custom deployments (self-hosted LLM + message queue) | Works great until it doesn't — costs spiral, debugging is blind, scaling means rewriting |

The gap: **there is no managed platform where you define an AI personality once and it operates autonomously across multiple platforms with persistent memory, operational visibility, and predictable costs.**

## What Swarm does

You chat with Swarm's admin interface to create and manage AI avatars. Everything is conversational — no dashboards, no config files, no deploy scripts.

```
You:     "Create an avatar called Astra"
Swarm:   ✅ Created! Give her a personality?
You:     "She's a friendly crypto nerd who explains DeFi simply"
Swarm:   ✅ Persona set. Connect her to Telegram?
You:     "Yes, here's the bot token: 123456:ABC..."
Swarm:   ✅ Astra is live on Telegram and responding.
```

From that point, Astra:
- Responds to messages in your Telegram group 24/7
- Remembers conversations across sessions (30-day memory on Pro)
- Stays in character according to her persona
- Can generate images, voice messages, and video on request
- Can be connected to Discord and X with the same personality and shared memory

You manage everything through chat: change her personality, connect new platforms, check usage, generate media. No context-switching to a different UI.

## Who it's for

### Primary: Community operators ($9/mo Pro)

Solo operators or tiny teams (1-2 people) running Telegram/Discord communities who want a persistent AI presence without managing infrastructure.

**Typical profiles:**
- NFT project community managers
- Crypto/Web3 founders who need a 24/7 community avatar
- Content creators building an AI-powered social presence
- Telegram channel admins who've outgrown command bots

**They pay because the Free tier (50 messages/day, 1 platform, no memory) is enough to test, but not enough to run a real operation.** The upgrade triggers are concrete: they hit the message limit, they want memory, they want a second platform.

### Secondary: Multi-avatar operators ($29/mo Enterprise)

Small teams or agencies managing AI avatars for multiple communities or clients.

**They pay because:** managing 3+ avatars across platforms with per-avatar cost visibility and audit trails is worth more than one hour of contractor time per month.

### Not for:

- Enterprise SaaS teams needing SSO/RBAC/SOC2 (not yet)
- Individual users wanting a personal AI assistant (wrong product)
- "Just exploring" users who create an avatar and never return (fine on Free, don't upsell)

## Why not just use [competitor]?

| Alternative | Swarm advantage |
|-------------|----------------|
| **OpenAI API + your own code** | Swarm handles hosting, memory, multi-platform routing, personality persistence, and operational monitoring. You just chat. |
| **Character.ai / ChatGPT** | Those are consumer products. Your avatar lives on *your* platforms (Telegram, Discord, X), responds to *your* community, with *your* personality. |
| **Botpress / Chatfuel** | Flow-based chatbots, not AI reasoning. Swarm avatars understand context, generate media, use tools, and maintain long-term memory. |
| **Self-hosted (Ollama, vLLM)** | If you want to run inference yourself, you don't need Swarm. Swarm is for people who want the avatar running without thinking about infrastructure. |

## Pricing logic

| Tier | Price | Who | Key limits |
|------|-------|-----|------------|
| Free | $0 | Evaluators | 50 msg/day, 1 platform, no memory |
| Pro | $9/mo | Creator-operators | 500 msg/day, 3 platforms, 30-day memory |
| Enterprise | $29/mo | Teams/agencies | Unlimited everything, 365-day memory |

**$9/mo is cheaper than any alternative that provides persistent memory + multi-platform deployment + operational guardrails.** The comparison is not "$9 vs free chatbot" — it is "$9 vs building and maintaining your own infrastructure."

Web3 users get bonus capacity: Orb NFT holders get boosted Free limits, RATI token holders get energy refill bonuses, and Ascension (burn mechanic) grants permanent Pro-equivalent access.

## Messaging by channel

### For Telegram/Discord communities (where operators hang out)

> **"Your AI avatar, live on Telegram in 10 minutes. Persistent memory. Zero infrastructure."**
>
> Create an avatar, give it a personality, paste your bot token. It's live. No servers, no code, no babysitting.

### For crypto/Web3 audiences

> **"AI avatars with Solana wallet auth, NFT gating, and on-chain identity."**
>
> Hold an Orb NFT? You get boosted limits automatically. Burn RATI to ascend to Pro for life. Your avatar's identity lives on-chain.

### For Product Hunt / indie hackers

> **"Ship an AI personality to Telegram, Discord, and X — from one chat interface."**
>
> All configuration happens through conversation. No dashboards. No YAML. Tell your avatar who to be, connect it to your platforms, and it runs autonomously.

## Channel strategy

Focus acquisition where the operators already are:

| Channel | Approach | Why |
|---------|----------|-----|
| **Telegram bot communities** | Demo in channels, answer setup questions | High-intent, right platform, low CAC |
| **Crypto/NFT project Discords** | Target community managers who run bots today | Acute pain, budget available |
| **Solana ecosystem** | Leverage existing Orb NFT holders | Already invested in the ecosystem |
| **X/Twitter** | Avatar demos (let Astra tweet) | Social proof, viral potential |
| **Product Hunt** | "AI avatar in 10 minutes" launch | Broad reach for initial awareness |

**Do not pursue** enterprise sales, paid ads, or outbound email. The product sells through demonstration — people see an avatar working in a community and ask "how do I get one?"

## What success looks like (next 90 days)

1. **5 paying design partners** validating the ICP (see [ICP.md](ICP.md) Section 6)
2. **Avatar-as-demo**: Astra and Kyro operating visibly in public communities, generating inbound interest
3. **Stripe checkout live** so Free users can self-serve upgrade to Pro
4. **One organic viral moment**: a community shares their avatar doing something impressive

Revenue target: $500 MRR from design partners. This is a validation milestone, not a growth target.

---

*Related: [ICP.md](ICP.md) (buyer profiles), [BILLING-STRATEGY.md](BILLING-STRATEGY.md) (tier mechanics), [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) (onboarding flows)*
