# Swarm public positioning

Audience: prospective swarm.rati.chat visitor. Tone: patient, specific, no buzzwords.
Source of truth for claims: code audit at HEAD of `claude/swarm-positioning-strategy-GHCxh`.

---

## Audit flags — fix before any public copy ships

Before rewriting the landing page, the current copy contradicts what's actually in the codebase. These are non-negotiable corrections:

- **"300+ AI models"** — Swarm wires three LLM providers: Bedrock, OpenRouter, Anthropic (`packages/core/src/types/platform.ts:312`). The "300+" number is OpenRouter's own catalogue, accessible via passthrough. There is no model picker UI, no router, no curated list. Saying "300+" reads as inflated to a technical audience.
- **"Multi-agent collaboration — agents interact with each other"** — Raticross is a documented inbound envelope protocol (`packages/handlers/src/messaging/adapters/raticross-adapter.ts`, `docs/raticross-protocol.md`). No avatar-to-avatar tool exists in `packages/mcp-server/src/tools/`. The feature is plumbing, not a product. Drop the claim.
- **"Persistent memory… shared memory across all platforms"** — Memory survives sessions on one platform fine (`packages/core/src/services/brain/canonical-memory.ts`). Cross-platform sharing is gated by an explicit identity-link consent and off by default (`packages/handlers/src/services/cross-platform-consent.ts`). Recall is also substring-based, not semantic — embeddings are written but not queried in the recall path (lines 162 and 216 of `canonical-memory.ts`).
- **"Live in 10 minutes"** — Wiring Telegram requires the user to register with @BotFather and paste a token. Discord requires the user to create a Discord application and grant scopes. The chat-first config is fast; the third-party prerequisites are not. Honest answer is closer to 15–25 minutes for the first platform.
- **"Discord bot creation as a platform feature"** — `packages/admin-api/src/services/platform/discord-admin.ts:38` validates a user-supplied token. Swarm does not provision Discord applications. It's BYO token, the same as Telegram.
- **Free tier shows "CosyWorld branding"** — the current product is Swarm. CosyWorld is the separate open-source substrate. Mixing the two on a paid-tier comparison confuses the buyer.

What is genuinely strong, by contrast: the autonomous-agent-runner pattern (`packages/handlers/src/station/station-agent-runner.ts`, `docs/patterns/autonomous-agent-runner.md`), the tool-loop with per-avatar allowlist and per-message quota, the multi-tenant DynamoDB partitioning with write-only secrets (`docs/design-philosophy.md` §4), and the SQS-based message pipeline with idempotency and DLQs. These are not buzzwords; they are the spine of the product.

---

## Target audience

**Crypto and creator community operators who already run an audience across Telegram, Discord, and X — and want a single persistent persona that lives in all three without writing code or paying someone to babysit a Node process.**

Concretely: the person running a 1k–50k member Telegram group for a token, an NFT project, a DAO, a builder collective, a substack-adjacent community, or a launchpad. They already manage bot tokens. They live in chat all day. They don't want to learn Terraform.

### Why this audience, not the alternatives

| Alternative audience | Why ruled out |
|---|---|
| Web3 / $RATi holders | A small, captive crowd. Already on the existing landing page. Not a growth segment. Acceptable secondary, but the product needs to acquire net-new operators. |
| Builders evaluating frameworks (Eliza, LangGraph, Mastra) | They want code, not a chat-first console. Swarm hides the code on purpose. We lose this audience on day one. |
| End-users wanting an AI companion (Character.AI / Janitor.AI / SpicyChat crowd) | No discovery surface, no public chat directory, no roleplay tooling. Wrong product. |
| Enterprise community managers (Discord ops at a Fortune 500) | Will ask for SOC 2, SSO, DPA. We have none of those today. Wrong stage. |
| Indie creators (Patreon, paid Substack) | Possible eventual fit, but mostly on Discord, less familiar with bot tokens, less urgency. Slower to reach. |

### Why now

- **Character.AI and OpenAI Custom GPTs don't deploy to Telegram or Discord.** Their distribution is captured inside their own apps. A creator who already has a Telegram group cannot bring those agents in.
- **ElizaOS is technically capable but operationally hostile.** Self-hosting, Postgres, key rotation, and cost-spike risk fall on the operator. Community ops people are not DevOps people.
- **The default "Telegram AI bot" market is undeserved.** Combot, Rose, and similar are moderation tools, not personas. Most Telegram AI bots are single-platform, no memory, no persona.
- **Per-conversation LLM cost has dropped 10× in two years.** $9/mo can carry a small group with real margin on gemini-flash class models.
- **Swarm's serverless architecture (scales to zero) means we can afford to wait for this audience to find us.** No growth-or-die pressure.

### Why Swarm beats what they currently use

| What they use today | Their pain | Swarm's answer (with code evidence) |
|---|---|---|
| MEE6 / Carl-bot / Combot / Rose | No persona, no memory, no real conversation | Per-avatar persona + DynamoDB-backed recall; 35+ tools incl. media, wallets, voice (`packages/mcp-server/src/tools/`) |
| ChatGPT in another tab | No platform delivery, no group context, copy-paste | One avatar replies natively in Telegram/Discord/X via mature webhook handlers (`packages/handlers/src/telegram/*`, `discord/*`, `twitter/*`) |
| ElizaOS / self-hosted Node bot | DevOps tax, no cost cap, key management is on you | Hosted, write-only secrets in AWS Secrets Manager, per-avatar daily entitlements (`packages/admin-api/src/services/billing/entitlements.ts`) |
| Hiring a part-time community manager | $400–$1500/mo, timezone-limited | $9/mo, 24/7 |
| Character.AI / Custom GPTs | Live only inside the host app, no deployment | Pastes a bot token and the persona shows up in your existing group |

---

## a. Positioning statement

Swarm is the hosted way to run one AI persona across your Telegram group, Discord server, and X account — set up entirely in chat, with no code, no servers, and no DevOps. It's for community operators who already have an audience on multiple platforms and want a 24/7 voice that stays in character and remembers regulars. Unlike ElizaOS (self-hosted, ops-heavy) or Character.AI and OpenAI Custom GPTs (web-only, no deployment to your platforms), Swarm runs as an isolated tenant on AWS, charges from $9/month, and idles to zero when nobody's talking — so you can leave a small community bot live for the cost of a coffee.

---

## b. Landing page rewrite — swarm.rati.chat

### Headline

**One AI persona. Your Telegram, Discord, and X. Set up in chat.**

### Subhead

For community operators who'd rather not run servers. Paste a bot token, describe a personality, and Swarm handles the rest — every reply, every day, with memory of the regulars in your group.

### Three-bullet value prop

- **Deploy to Telegram, Discord, and X from one chat.** No framework to install, no Lambda to write, no Postgres to keep awake. Bring the bot token; we run the rest. (`packages/handlers/src/{telegram,discord,twitter}/`)
- **Per-user memory that survives the session.** Your bot remembers the regulars in your group across days and conversations. (Cross-platform memory merge is opt-in and gated by explicit consent — we don't silently correlate identities.) (`packages/core/src/services/brain/canonical-memory.ts`, `packages/handlers/src/services/cross-platform-consent.ts`)
- **Daily spend caps, write-only secrets, per-tenant isolation.** Built like infrastructure — DynamoDB partitions per avatar, SQS with idempotency, structured CloudWatch logs. Priced like a SaaS. $9/month, scales to zero. (`docs/design-philosophy.md` §4, `packages/admin-api/src/services/billing/entitlements.ts`)

Below the fold, the existing "How it works" chat demo stays — it's the cleanest part of the page. Cut the "300+ models" line, cut the "multi-agent collaboration" feature card, cut the "CosyWorld branding" line in the free tier.

---

## c. Five hardest objections, with honest answers

**1. "Why not just run ElizaOS or my own Node bot? I can read docs."**

You can, and if you enjoy that, you should. Swarm trades flexibility for operational sanity: no Docker, no Postgres babysitting, no key rotation, no surprise bill when someone tries to abuse your bot. Per-avatar daily quotas and a per-message tool-call cap are wired into the message processor (`packages/handlers/src/messaging/tool-loop.ts`). If those guardrails don't matter to you, Swarm isn't worth $9/mo.

**2. "Your front page used to say '300+ models.' Which ones actually work?"**

That line was overselling. Under the hood, Swarm calls three providers — Amazon Bedrock, OpenRouter, and Anthropic direct — and the default model is `google/gemini-3-flash-preview`. You can set any OpenRouter-routed model string per avatar (which is where the "300+" came from — OpenRouter's catalog). The page now describes this as OpenRouter catalog model choice. We don't support fine-tuned private models today.

**3. "Does the bot actually remember a user across Telegram and Discord?"**

Within one platform: yes, by default. The bot remembers what your regulars said across sessions. Across platforms — the same person on Discord and on Telegram — memory sharing is gated by an explicit identity-link consent flow and is off by default (`packages/handlers/src/services/cross-platform-consent.ts`). We deliberately don't auto-correlate identities; that would be a privacy footgun for a community-ops tool. Also worth flagging: recall today is keyword/substring-based; embeddings are written to DynamoDB but not yet used in the recall path. Semantic recall is on the work queue (issue #183 follow-ups).

**4. "What stops the bot from saying something stupid and getting our community pissed at us?"**

Not a content filter — we don't ship one. Three things do help: (a) tool calls are bounded by a per-avatar allowlist and a per-message cap, so even a jailbroken model can't run away with your wallet tools; (b) all processing is on SQS with idempotency keys, so retries don't double-post; (c) every action is in CloudWatch with avatar/conversation correlation IDs, so when something does go wrong you can see it. The persona's content guardrails belong in the system prompt — that part is on you, and the chat-first config makes it editable in 30 seconds.

**5. "Cenetex Inc. — who are you, and what happens to my bot if you disappear?"**

Cenetex Inc. operates the production AWS account; the architecture (`packages/infra/`) is plain AWS CDK — DynamoDB, SQS, Lambda, Secrets Manager. Because the runtime scales to zero, our burn at low volume is near zero, so we're not in a growth-or-die spiral. We don't have SOC 2 today — if you need a signed DPA or a controls report, we're not the right vendor yet, and we'd rather you know that now. Your avatar config and message history live in our DynamoDB; export is currently per-avatar via the admin chat ("export my memory"), which works but is not polished. If we ever shut Swarm down, you keep your bot token and your audience — nothing platform-side is locked to us.

---

## d. Pricing

### What the current Stripe tiers actually fit

Free / $9 / $29 are roughly right for this audience, but $29 is awkwardly placed and the gating is unclear in the current copy.

For a crypto/creator community operator:
- **$0–9 range** is impulse — "I'll try it on my small Telegram group."
- **$29** is the dead zone — too much for an experiment, too little to feel like a real tool.
- **$99–199** is where serious community ops actually budget — but at that price the buyer expects multi-seat admin, analytics, scheduled posting, audit logs.

### Recommended structure

| Tier | Price | Who it's for | Gated on |
|---|---|---|---|
| **Free** | $0 | "Let me see if this even works for my group" | 1 avatar, 1 platform (Telegram), 50 msgs/day, default Gemini Flash model, "powered by Swarm" in `/start` reply |
| **Creator** | $9/mo | A single community, one persona, three platforms | 1 avatar, Telegram + Discord + X, 500 msgs/day, OpenRouter catalog model choice, 30-day memory, no Swarm footer |
| **Operator** | $29/mo *(rename from current Pro)* | A serious solo operator with several brands | Up to 3 avatars, autonomous-runner schedules (`packages/handlers/src/station/station-agent-runner.ts`), 90-day memory, per-avatar logs export |
| **Team** | "Contact us" | Communities that actually need multi-seat, audit, SOC-2 conversation | Hide on landing page until there's a real product behind it. Don't show $299 to an audience that can't sanity-check it. |

What changes from today:
- Drop the $299 tier from the public page. It's there to be aspirational; for a $0-paying-user starting point it just adds noise.
- Make $29 distinct from $9 by giving it the autonomous-runner feature — that's the actual operational upgrade and it's already shipped.
- Replace "300+ models" in the Creator tier with "Choose any model in OpenRouter's catalog." Honest, technical, defensible.
- Replace "CosyWorld branding" in the Free tier with "Swarm footer in bot replies." (And remove CosyWorld from the page entirely — it's a separate product.)

### Add-on rather than a tier

This audience runs in bursts: token launches, NFT mints, AMAs, raid days. A flat $29/mo doesn't capture that. Once there's signal, add a usage-based "boost pack" — e.g., $5 buys an extra 2,500 messages and 50 media credits, applied to the avatar's daily quota for 7 days. The entitlement system already supports per-avatar quotas (`packages/admin-api/src/services/billing/entitlements.ts`); a boost pack is a few SKUs in Stripe and a credit-bucket field, not a re-architecture.

### Where Solana / $RATi fits

Optional. The burn-tier system (`packages/core/src/constants.ts:93-148`) is already wired: a $RATi burn or Orb NFT can grant Pro entitlement (`packages/admin-api/src/services/avatar-ascend.ts`). For crypto-native operators, this is a real on-ramp — you already hold the token, you already know the wallet flow. For everyone else, it's not surfaced. That's the right call. Don't decorate the page with Solana logos for non-crypto visitors; do keep the burn path live for the people who'll actually use it.

---

## e. 30-day distribution plan

### Where this audience actually hangs out

- **Crypto Twitter / X.** Community-ops folks (token founders, NFT project comms leads, DAO operators) live here. They post about tooling pain.
- **Telegram operator networks.** People who run one community often run three or four. Word travels by DM, not by ad.
- **Solana ecosystem Discord servers** — Superteam, Helius, Drift, MagicEden community channels. Builders and community ops.
- **Farcaster.** Smaller, but high signal density for builders who'd evaluate this seriously.
- **Builder substacks** — Dan Romero, Polynya, Yuga-adjacent operators write about exactly this kind of tooling.
- **NOT Reddit, NOT LinkedIn, NOT HN front page.** Wrong audience density, wrong signal.

### Content that reaches them

- **A single reproducible deploy story.** "From @BotFather to a live Telegram persona in 14 minutes" — screen recording, no cuts. Posted as an X thread and a Farcaster cast. (Honesty: don't claim 10.)
- **Side-by-side vs. ElizaOS.** Same persona, same prompt, deployed to the same Telegram group. Show the ElizaOS docker-compose vs. the Swarm chat flow. Show the AWS bill at the end of week one.
- **One "what we don't do yet" post.** Counter-positioning. We don't have SOC 2, semantic memory recall, automatic Discord provisioning. Calling it out builds trust faster than another feature list does.
- **Public bot examples to talk to.** A live Swarm-run persona in a public Telegram group readers can join and message. The product is conversational; the demo should be conversational.

### Single first experiment

**Recruit five mid-sized crypto/creator Telegram communities (target: 1k–10k members, active in the last 7 days) and set up Swarm avatars for them free for 60 days in exchange for: (a) an honest end-of-trial write-up, and (b) "powered by Swarm" in the bot's `/start` and `/help` replies.**

Why this and not a paid ads campaign:
- The product's edge is operational relief, which only shows up after a real operator has run it for a few weeks. Ads optimise for click, not for retention.
- This audience is referral-driven — one operator who likes the tool tells two others in DM. Five operators × ~3 communities each ≈ 15 community-level deployments and a non-zero number of paying conversions inside 30 days.
- Cost is near zero (the avatars run on the free tier infrastructure; the giveaway is mostly LLM tokens).
- Negative result is still useful: if five operators take the trial and three churn inside two weeks, that tells you something the analytics dashboard won't.

### Success criteria for the first 30 days

- 5 operator-recruited deployments live with weekly check-ins.
- 50 net-new signups attributable to the experiment (via tracked referral links from the operators' communities).
- Three of the five operators willing to be quoted publicly.
- One "what we learned" write-up published by day 30, including the things we got wrong.

If by day 30 fewer than three operators are still actively using the product daily, the positioning is wrong, not the funnel. Re-pick the audience before spending on ads.
