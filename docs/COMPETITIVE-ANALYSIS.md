# Competitive Analysis: aws-swarm vs elizaOS Cloud

**Date:** 2026-03-20
**Version:** v0.24.0 (aws-swarm) vs v0.1.0 (elizaOS Cloud)
**Next review:** 2026-04-20

> This document maps the competitive landscape against the [Portfolio-Inspired Roadmap](PORTFOLIO-INSPIRED-ROADMAP.md) and [RATiMICS Unified Roadmap](../../ROADMAP.md). Findings should inform issue creation during roadmap reviews — not replace the issue queue.

---

## Executive Summary

**elizaOS Cloud** is the managed hosting layer for the elizaOS framework (~18k GitHub stars), offering AI agent deployment as a service with credit-based billing. It targets individual developers and Web3-native users who want to launch agents without DevOps knowledge.

**aws-swarm** is a multi-tenant AI avatar operating system with serverless architecture, chat-first admin, deep Solana/NFT integration, and mature multi-modal generation. It targets platform operators running many avatars across many channels.

**Key takeaway:** These are complementary, not head-on competitors. elizaOS Cloud is B2C/B2D (deploy your own agent). aws-swarm is B2B (operate a fleet of avatars for your community). The strategic opportunity is **interoperability via raticross**, not feature-parity competition.

---

## Architecture Comparison

| Dimension | aws-swarm (v0.24.0) | elizaOS Cloud (v0.1.0) |
|---|---|---|
| **Runtime** | Lambda + SQS (fully serverless) | Next.js 15 monolith on Vercel |
| **Database** | DynamoDB (partition-isolated multi-tenant) | PostgreSQL (Neon) + pgvector |
| **Auth** | Solana wallet + NFT gating + Privy | Privy (email, wallet, social) |
| **Billing** | Entitlement tiers (Web2 Floor + Web3 Ceiling) | Stripe credits (20% markup on provider costs) |
| **AI Routing** | OpenRouter SDK (pinned v0.3.12) | Vercel AI SDK Gateway (multi-provider) |
| **Containers** | ECS Fargate (Discord gateway only) | ECS EC2 (t4g.small per user) + K8s operator |
| **IaC** | AWS CDK (TypeScript) | Terraform + Vercel |
| **Media Storage** | S3 + CloudFront | Vercel Blob |
| **CI/CD** | GitHub Actions → staging → tag → prod | Vercel auto-deploy |
| **Testing** | bun test (3,807 tests, 226 files) | No test strategy (open issue #309) |

### Architecture Assessment

**aws-swarm advantages:**
- True serverless: Lambda cold starts are sub-second; no persistent compute costs at idle
- DynamoDB partition isolation: `AVATAR#{id}` prefix gives natural multi-tenant sharding
- SQS-based pipeline: retry, DLQ, correlation IDs, offload to S3 for large payloads
- Operational maturity: structured deploys, release gates, runbook, security audit pipeline

**elizaOS Cloud advantages:**
- PostgreSQL + pgvector: native vector search for agent memory (DynamoDB requires external vector store)
- Kubernetes operator: more flexible container orchestration for heterogeneous workloads
- Vercel edge network: global CDN with minimal config
- Next.js App Router: SSR + API routes in one deployment unit (simpler for small teams)

**elizaOS Cloud risks:**
- `ignoreBuildErrors: true` in production Next.js config
- No test strategy (acknowledged in issue #309)
- OOM on type checking (issue #311)
- Single PostgreSQL instance — no partition-based scaling
- Pre-v1 with zero GitHub releases

---

## Feature Matrix

### Platform Integrations

| Platform | aws-swarm | elizaOS Cloud |
|---|---|---|
| Telegram | Full (webhook, inline, groups, voice) | Supported |
| Discord | Full (gateway, webhooks, shared rooms, embeds) | Supported |
| Twitter/X | Full (threaded replies, media, autonomous posting) | Supported |
| Web Chat | Admin UI + public avatar page | Dashboard UI |
| iMessage | Not supported | Supported (via Blooio) |
| WhatsApp | Not supported | Supported |
| n8n/Workflows | Not supported | Supported |

### Multi-Modal Generation

| Capability | aws-swarm | elizaOS Cloud |
|---|---|---|
| **Image generation** | Replicate (nano-banana-pro default, model-swappable, schema validation, 3-layer cache) | Gemini |
| **Video generation** | Replicate (minimax/video-01, async webhook pipeline) | Fal.ai |
| **Voice cloning** | 3-step pipeline: audio seed → clone → smooth (xtts-v2) | ElevenLabs ($0.50-$2.00/clone) |
| **Text-to-speech** | xtts-v2 via Replicate | ElevenLabs |
| **Transcription** | OpenAI Whisper | Not documented |
| **Sticker generation** | Full pipeline: generate → background remove → resize → pack | Not supported |
| **Model discovery** | Replicate schema caching + search + MCP tools | Vercel AI SDK model list |
| **Media job system** | SQS queue + webhook callbacks + S3 storage + gallery tracking | Inline API calls |

**Assessment:** aws-swarm has a significantly more mature multi-modal pipeline with async job handling, model validation, sticker processing, and cross-platform delivery. elizaOS Cloud uses simpler inline calls to hosted APIs. aws-swarm's Replicate integration allows model swapping without code changes.

### Agent Runtime

| Feature | aws-swarm | elizaOS Cloud |No
|---|---|---|
| **Memory** | Scoped (ephemeral/durable/archival/canonical), TTL, export, delete | PostgreSQL + pgvector embeddings |
| **Shared rooms** | Deterministic turn arbitration, presence scoring, room ledger | Basic room support |
| **Tool system** | Chat-driven tools (media, wallets, secrets, integrations) | Plugin-based (elizaOS plugin ecosystem) |
| **Evaluators** | LLM-driven action selection with tool constraints | elizaOS evaluator framework |
| **Context window** | Channel summary + memory retrieval + shared room overlay | Vector-similarity retrieval |
| **Autonomous posting** | Proactive scheduler with budget/rate-limit gates | Plugin-dependent |

### Billing & Web3

| Feature | aws-swarm | elizaOS Cloud |
|---|---|---|
| **Billing model** | Entitlement tiers + energy burst pool + NFT augmentation | Flat credit pricing (20% markup) |
| **Web3 auth** | Solana wallet + NFT gating (Orb, Lineage, Ascension) | Wallet connect (generic) |
| **Token integration** | $RATI holder tracking, on-chain augmentation | ELIZAOS token for payments |
| **NFT mechanics** | Orb resonance tracking, Lineage enrichment, Ascension evolution | ERC-8004 agent discovery |
| **On-chain** | Solana-native | EVM-native (Coinbase X402) |

### Developer Experience

| Feature | aws-swarm | elizaOS Cloud |
|---|---|---|
| **Deploy** | CDK + GitHub Actions (operator-managed) | `elizaos deploy` (2-command) |
| **Admin UX** | Chat-first (no dashboards, no modals) | Traditional dashboard |
| **MCP server** | Full MCP server with media, voice, model tools | MCP integration for agents |
| **CLI** | devctl (ecosystem management) | elizaos CLI |
| **Docs** | Runbook, security policy, data retention, release gates | Standard docs site |

---

## Strategic Positioning

### Where aws-swarm wins

1. **Multi-tenant operations** — One operator, many avatars, shared infrastructure, isolated data. elizaOS Cloud gives each user their own container; aws-swarm runs a fleet on shared serverless.

2. **Chat-first admin** — The admin interface IS the product. No context-switching to dashboards. This is a genuine UX differentiation per [design-philosophy.md](design-philosophy.md).

3. **Serverless cost efficiency** — Lambda + DynamoDB + SQS has near-zero idle cost. elizaOS Cloud runs t4g.small EC2 instances per user (~$15/month/agent even when idle).

4. **Operational maturity** — 3,807 tests, release gates, correlation IDs, DLQ monitoring, staged deploys. elizaOS Cloud has acknowledged tech debt and no test strategy.

5. **Multi-modal depth** — async job pipelines, model validation, sticker processing, voice cloning pipeline. Not just "we can generate images" but production-grade media handling.

6. **Shared room coordination** — Deterministic turn arbitration, presence scoring, room ledger. Purpose-built for multi-avatar scenarios that elizaOS Cloud doesn't address.

### Where elizaOS Cloud wins

1. **Ecosystem gravity** — 18k+ stars on the core framework. Community network effects for plugins, models, and agent templates.

2. **Developer onboarding** — 2-command deploy vs CDK setup. Lower barrier for individual developers.

3. **Platform breadth** — iMessage, WhatsApp, n8n workflow automation. We cover the big 3 (Telegram, Discord, Twitter) but not messaging apps.

4. **AI provider gateway** — Unified API key routing to any LLM provider. We depend on OpenRouter as a single intermediary.

5. **Plugin ecosystem** — Open plugin architecture with community contributions. Our tool system is powerful but closed.

6. **Agent marketplace direction** — Building toward an app store for agents. We don't have a marketplace or template sharing mechanism yet.

---

## Gap Analysis & Roadmap Integration

### Gaps that align with existing roadmap lanes

These gaps map directly to the [Portfolio-Inspired Roadmap](PORTFOLIO-INSPIRED-ROADMAP.md) strategic lanes.

#### Lane 1: Productization & Deployment Velocity

| Gap | elizaOS equivalent | Swarm-native framing | Priority |
|---|---|---|---|
| Persona templates | Character creator with AI-assisted building | "Persona template system for repeatable tenant launches" (already a Lane 1 candidate) | **High** — already planned |
| Simplified deploy | `elizaos deploy` 2-command flow | Not applicable — aws-swarm is operator-deployed infrastructure, not self-serve. This is a feature of our B2B positioning, not a gap. | N/A |

#### Lane 2: Identity & Memory Continuity

| Gap | elizaOS equivalent | Swarm-native framing | Priority |
|---|---|---|---|
| Vector memory | pgvector for semantic similarity retrieval | "Add vector-indexed memory retrieval for contextual recall quality" | **Medium** — would strengthen memory synthesis |
| Cross-platform identity | Generic wallet + social login | "Cross-platform user identity linking" (already a Lane 2 candidate) | **Medium** — already planned |

#### Lane 3: Shared-Room Presence & Cast Design

No gaps — aws-swarm is significantly ahead with deterministic turn arbitration, presence scoring, and room coordination. elizaOS Cloud has basic room support only.

#### Lane 4: Labs & Frontier Validation

| Gap | elizaOS equivalent | Swarm-native framing | Priority |
|---|---|---|---|
| Agent marketplace | App store + monetization | "Avatar template marketplace for community-contributed personas" | **Low** — Labs candidate, validate demand first |
| Workflow automation | n8n bridge | "External workflow trigger system for avatar actions" | **Low** — evaluate if operators need this |

### New gaps not in existing roadmap

| Gap | Description | Recommendation |
|---|---|---|
| **AI provider abstraction** | We depend on OpenRouter (pinned v0.3.12 due to breaking change). elizaOS uses Vercel AI SDK for multi-provider routing. | Create issue: "Abstract LLM provider routing to reduce single-vendor dependency." Lane: Productization. Priority: Medium. Mitigates supply chain risk. |
| **iMessage / WhatsApp** | Messaging app integrations we don't cover. | Defer. Our Telegram/Discord/Twitter coverage matches our operator audience. Consumer messaging apps are a different market segment. |
| **Plugin/extension system** | elizaOS has open plugin architecture; our tool system is closed. | Defer. Closed system = tighter security + simpler operations. Revisit when operator demand exists. |

---

## Interoperability Opportunity: raticross

The most strategic response to elizaOS is **not** to compete feature-for-feature but to **bridge** via [raticross](raticross-protocol.md).

### Current state

Per [ROADMAP.md](../../ROADMAP.md) Phase 1:
- Envelope schema defined (`RaticrossEnvelope`)
- Swarm adapter implemented (`raticross-client.ts`, inbound/outbound handlers)
- Kyro adapter stubbed
- **Eliza adapter stubbed** — this is the key integration point

### Proposed: elizaOS adapter for raticross

| Component | Description |
|---|---|
| `ElizaAdapter` | Translate `RaticrossEnvelope` ↔ elizaOS agent message format |
| Use case | aws-swarm avatars can delegate tasks to elizaOS agents (and vice versa) |
| Value | Access elizaOS plugin ecosystem without absorbing it. Swarm avatars gain capabilities (e.g., on-chain actions via elizaOS plugins) without architecture contamination. |
| Dependency | raticross v0.1 must ship first (Swarm ↔ Kyro working) |

This aligns with the unified roadmap thesis: "raticross is the nervous system that connects them all."

### Integration architecture

```
aws-swarm avatar                    elizaOS agent
     │                                    │
     ├── RaticrossAdapter ──────────────► ElizaAdapter
     │   (POST /raticross/inbound)        (elizaOS message format)
     │                                    │
     ◄── RaticrossInbound ◄────────────── ElizaAdapter
         (SwarmEnvelope)                  (POST /raticross/inbound)
```

Both systems process messages through their own pipelines. Raticross is the wire format, not a runtime dependency.

---

## Competitive Moats

### Our durable advantages

1. **Multi-tenant serverless** — Architectural moat. Retrofitting multi-tenancy into a Next.js monolith is a rewrite.
2. **Chat-first admin** — UX moat. Traditional dashboards are easier to build but harder to differentiate.
3. **Shared room coordination** — Feature moat. Deterministic turn arbitration for multi-avatar rooms is non-trivial to replicate.
4. **Operational maturity** — Quality moat. 3,807 tests, release gates, DLQ monitoring, correlation IDs.
5. **Web2+Web3 billing** — Business model moat. `max(entitlement, web3_augmented)` is novel.

### Their durable advantages

1. **Community** — 18k+ stars, active plugin ecosystem. Network effects compound.
2. **Developer gravity** — First-mover in "AI agent framework" mindshare.
3. **Plugin extensibility** — Open architecture attracts contributor ecosystem.

### Neither side's moat

- Platform integrations (both support Telegram/Discord/Twitter)
- Multi-modal generation (both have image/video/voice)
- Web3 payments (both have token integration)
- MCP support (both have MCP servers)

---

## Streaming Avatar Phase — The Killer Differentiator

Neither elizaOS Cloud nor any comparable AI agent platform offers **live streaming AI avatars with real-time voice conversation**. We already have the full stack prototyped across the RATiMICS ecosystem. Integrating these into aws-swarm creates a moat that is extremely difficult to replicate.

### What We Already Have

The streaming avatar pipeline spans three existing projects:

| Component | Project | Status | Key Capabilities |
|---|---|---|---|
| **VRM Avatar Rendering** | [PoseLab](../../project89-reaction-forge/) (project89-reaction-forge) | Shipped (v1.2.1, [poselab.studio](https://poselab.studio)) | VRM + Live2D loading, Three.js rendering, emotion/gesture blendshapes, MediaPipe motion capture, WebRTC multiplayer, video export |
| **Live Streaming Engine** | [vtuber-stream](../../vtuber-stream/) | Active (v1.0.0) | Multi-platform RTMP (Twitch, YouTube, pump.fun), Playwright browser capture, scene composition, PoseLab WebSocket bridge, guest avatar rotation |
| **Voice Pipeline** | aws-swarm + vtuber-stream | Production | aws-swarm: 3-step voice clone (Stable Audio → XTTS v2), TTS, Whisper transcription. vtuber-stream: XTTS local clone, Kokoro TTS, RMS lip sync |
| **Chat Integration** | aws-swarm + vtuber-stream | Production | aws-swarm: Telegram/Discord/Twitter webhook pipeline. vtuber-stream: Twitch EventSub, pump.fun Socket.IO, chat aggregation |
| **Avatar Bridge** | vtuber-stream ↔ PoseLab | Working | WebSocket at port 8765 for real-time emotion/gesture/mouth control. `window.project89Reactor` API for external avatar driving |
| **Guest System** | vtuber-stream | Working | Avatar rotation (240s duration/180s cooldown), CosyWorld + aws-swarm avatar fetching, location-based backgrounds |
| **Scene System** | vtuber-stream | Working | Multi-scene layouts, transitions, lower thirds, camera choreography, soundscape generation (ACE-Step) |

### Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     STREAMING AVATAR PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────────────┐     ┌──────────────────────────────────────┐   │
│  │  aws-swarm         │     │  vtuber-stream orchestrator          │   │
│  │  (Message Pipeline) │     │  (Show Runner + Stage Director)      │   │
│  │                    │     │                                      │   │
│  │  Telegram ──┐      │     │  ┌────────────┐  ┌───────────────┐  │   │
│  │  Discord ───┤ SQS ─┼─────┼─►│ Chat Mgr   │  │ Soundscape    │  │   │
│  │  Twitter ───┤      │     │  │ (aggregate) │  │ (ACE-Step)    │  │   │
│  │  Web Chat ──┘      │     │  └──────┬─────┘  └───────┬───────┘  │   │
│  │                    │     │         │                 │          │   │
│  │  ┌──────────────┐  │     │         ▼                 │          │   │
│  │  │ LLM Evaluator│  │     │  ┌────────────────┐       │          │   │
│  │  │ + Tool Call   │◄─┼─────┼──┤ AI Personality │       │          │   │
│  │  └──────┬───────┘  │     │  │ (OpenRouter)   │       │          │   │
│  │         │          │     │  └──────┬─────────┘       │          │   │
│  │         ▼          │     │         │                 │          │   │
│  │  ┌──────────────┐  │     │    ┌────┴────┐            │          │   │
│  │  │ Voice Pipeline│  │     │    ▼         ▼            │          │   │
│  │  │ (XTTS clone)  │──┼─────┼─► TTS    Emotion/       │          │   │
│  │  └──────────────┘  │     │    │      Gesture         │          │   │
│  │                    │     │    │         │             │          │   │
│  │  ┌──────────────┐  │     │    ▼         ▼             │          │   │
│  │  │ Media Gen    │  │     │  ┌─────────────────────┐  │          │   │
│  │  │ (Replicate)  │  │     │  │ PoseLab Bridge      │  │          │   │
│  │  └──────────────┘  │     │  │ (WebSocket :8765)   │  │          │   │
│  │                    │     │  │ VRM Avatar Control   │  │          │   │
│  └────────────────────┘     │  └──────────┬──────────┘  │          │   │
│                             │             │             │          │   │
│                             │             ▼             ▼          │   │
│                             │  ┌──────────────────────────────┐   │   │
│                             │  │ Scene Compositor              │   │   │
│                             │  │ (Background + Avatar + Chat   │   │   │
│                             │  │  + Lower Thirds + Overlays)   │   │   │
│                             │  └──────────────┬───────────────┘   │   │
│                             │                 │                   │   │
│                             │       ┌─────────┼──────────┐       │   │
│                             │       ▼         ▼          ▼       │   │
│                             │  ┌─────────┐ ┌──────┐ ┌────────┐  │   │
│                             │  │ RTMP    │ │ VCam │ │ WebRTC │  │   │
│                             │  │ Twitch  │ │ OBS  │ │ (new)  │  │   │
│                             │  │ YouTube │ │      │ │        │  │   │
│                             │  │ pump.fun│ │      │ │        │  │   │
│                             │  └─────────┘ └──────┘ └────────┘  │   │
│                             └──────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### What Needs To Be Built

The pieces exist — the work is **integration, not invention**.

#### Phase S1: Swarm ↔ VTuber Bridge (4-6 issues)

Connect aws-swarm's message pipeline to vtuber-stream so that chat messages processed by Swarm avatars can drive live streaming output.

| Work Item | Description | Packages |
|---|---|---|
| **Streaming adapter for raticross** | New transport: `StreamingTransport` in raticross that sends avatar responses to vtuber-stream via WebSocket instead of (or in addition to) platform delivery | `core`, `handlers` |
| **Avatar-to-PoseLab emotion mapping** | Map Swarm evaluator outputs (tool calls, response tone) to PoseLab emotion/gesture actions (wave, nod, laugh, think, etc.) | `core`, `handlers` |
| **Voice-to-lip-sync bridge** | Route aws-swarm's XTTS voice output to vtuber-stream's RMS lip sync analyzer for real-time mouth movement | `handlers`, vtuber-stream |
| **Stream session management** | Start/stop streaming sessions via admin chat commands. Bind avatar to a PoseLab instance + RTMP destination. | `admin-api`, `admin-ui` |
| **Guest avatar integration** | vtuber-stream's `GuestAvatarFactory` already supports aws-swarm avatar fetching (`swarm_chance: 0.0` — just enable it). Wire VRM URLs from avatar profiles. | vtuber-stream config |

#### Phase S2: Interactive Live Conversations (3-4 issues)

Enable real-time bidirectional voice conversations with streaming avatars.

| Work Item | Description | Packages |
|---|---|---|
| **WebRTC voice input** | Browser-based voice capture → Whisper transcription → Swarm message pipeline → LLM → voice response → lip sync | `admin-ui`, `handlers`, `core` |
| **Streaming voice response** | Chunk XTTS output and stream audio as it generates rather than waiting for full synthesis. Progressive lip sync from audio chunks. | `admin-api`, vtuber-stream |
| **Real-time emotion inference** | Infer avatar emotional state from conversation context and apply to VRM blendshapes continuously, not just per-message | `core`, vtuber-stream |
| **Multi-avatar conversation streaming** | Shared room turn arbitration drives which avatar is animating. Visual indicators for "thinking" and "speaking" states. | `handlers`, vtuber-stream |

#### Phase S3: Platform-Native Streaming (2-3 issues)

Expose streaming avatars as embeddable experiences.

| Work Item | Description | Packages |
|---|---|---|
| **Embeddable avatar widget** | WebRTC-based embed that operators can place on any website. Avatar renders in browser via PoseLab, voice via WebRTC, chat via WebSocket. | `profile-page`, PoseLab |
| **Telegram video chat integration** | Bot joins Telegram video chats with streaming avatar output | `handlers`, vtuber-stream |
| **Discord Stage integration** | Bot joins Discord Stage channels with avatar + voice | `handlers`, vtuber-stream |

### Why This Is A Moat

| Competitor | Live streaming avatars? | Voice conversation? | Multi-platform? |
|---|---|---|---|
| **elizaOS Cloud** | No | No | Text only across platforms |
| **Character.ai** | No | Voice calls (no avatar) | Web only |
| **Replika** | Static 3D model | Voice calls | Mobile only |
| **VTuber Studio** | Avatar only (no AI) | No AI | OBS only |
| **aws-swarm + PoseLab + vtuber-stream** | Full VRM streaming | Voice clone + lip sync | Twitch, YouTube, Telegram, Discord, Web |

**No existing platform combines autonomous AI agents + live VRM avatar streaming + real-time voice conversation + multi-platform chat integration.** This is a unique capability made possible by the RATiMICS ecosystem's breadth.

### Cost Model

| Component | Runtime Cost | Notes |
|---|---|---|
| PoseLab rendering | ~0 (browser-side, client GPU) | For embeds; server-rendered via Playwright for RTMP |
| XTTS voice synthesis | ~$0.002/message (Replicate) | Already in billing pipeline |
| Whisper transcription | ~$0.006/minute (OpenAI) | Already integrated |
| RTMP streaming | EC2 g4dn.xlarge (~$0.526/hr) | GPU for Playwright + FFmpeg. Could use CPU with lower FPS. |
| WebRTC (embed mode) | ~$0 (P2P) | TURN relay adds ~$0.01/hr if NAT traversal needed |

**Key insight:** The embed model (Phase S3) is nearly free — PoseLab renders in the visitor's browser. Only server-rendered RTMP streaming requires GPU compute.

### Roadmap Lane Alignment

This work maps to a **new Lane 5** in the [Portfolio-Inspired Roadmap](PORTFOLIO-INSPIRED-ROADMAP.md):

| Lane | Primary source | Swarm-native outcome |
|---|---|---|
| **5. Streaming Avatar Presence** | `vtuber-stream` + `PoseLab` | Live conversational AI avatars as a deployable product surface |

**Promotion gate:** Phase S1 (bridge) can begin after raticross v0.1 ships. Phase S2 (interactive) requires Phase S1. Phase S3 (embeds) requires Phase S2.

---

## Recommended Actions

### Immediate (no new issues needed)

- [x] Document competitive landscape (this document)
- [x] Update [ROADMAP.md](../../ROADMAP.md) with elizaOS interop as a Phase 2 target
- [x] Multi-modal pipeline inventory (image, video, voice, sticker — all production-grade)
- [x] Streaming avatar feasibility assessment (all components prototyped, integration work only)

### Next roadmap review — issue candidates

| Candidate | Lane | Priority | Rationale |
|---|---|---|---|
| **Swarm ↔ VTuber streaming bridge** | Streaming Avatar Presence | **High** | Unique competitive moat; components already exist across ecosystem |
| **Avatar-to-PoseLab emotion mapping** | Streaming Avatar Presence | **High** | Required for streaming bridge; maps evaluator tone → VRM blendshapes |
| raticross v0.1 ship (Swarm ↔ Kyro) | Infrastructure | **High** | Prerequisite for elizaOS interop AND streaming transport |
| Abstract LLM provider routing | Productization | Medium | Reduce OpenRouter single-vendor risk |
| Persona template system | Productization | Medium | Already planned; elizaOS character creator validates demand |
| Vector-indexed memory retrieval | Identity & Memory | Medium | Competitive parity for semantic recall |
| WebRTC voice input for avatar conversations | Streaming Avatar Presence | Medium | Phase S2; after bridge ships |
| elizaOS raticross adapter (design doc) | Infrastructure | Low | After raticross v0.1 ships |
| Embeddable avatar widget | Streaming Avatar Presence | Low | Phase S3; after interactive voice ships |

### Not recommended

| Feature | Why skip |
|---|---|
| iMessage/WhatsApp integration | Different market segment; our operators use Telegram/Discord/Twitter |
| Plugin/extension system | Premature abstraction; closed system is a security advantage |
| Agent marketplace | No operator demand signal yet; Labs candidate at best |
| 2-command deploy CLI | We're B2B infrastructure, not self-serve SaaS |
| Dashboard UI | Counter to our chat-first differentiation |
| Build our own VRM renderer | PoseLab already ships this; use it, don't rebuild it |
| Self-hosted TTS | Replicate-hosted XTTS v2 is cost-effective; local GPU not justified yet |

---

## Monitoring

### elizaOS Cloud — quarterly review
- GitHub release cadence (currently: zero releases)
- Test infrastructure maturity (currently: no strategy)
- Pricing model changes (currently: 20% markup)
- Plugin ecosystem growth
- Enterprise adoption signals
- raticross/elizaOS interop interest

### Streaming avatar competitors — quarterly review
- Character.ai voice/avatar features (currently: voice calls, no visual avatar)
- Replika visual updates (currently: static 3D model, mobile only)
- VTuber Studio AI integration (currently: manual only, no AI)
- New entrants combining AI agents + live streaming
- pump.fun / Twitch AI streamer ecosystem growth

---

## Appendix A: Data Sources

- [elizaOS Cloud repository](https://github.com/elizaOS/cloud) — analyzed 2026-03-20
- [elizaOS core framework](https://github.com/elizaOS/eliza) — ~18k stars
- [elizaCloud.ai](https://elizacloud.ai) — managed platform site
- [elizaOS documentation](https://docs.elizaos.ai)
- aws-swarm internal docs: [design-philosophy.md](design-philosophy.md), [PORTFOLIO-INSPIRED-ROADMAP.md](PORTFOLIO-INSPIRED-ROADMAP.md), [raticross-protocol.md](raticross-protocol.md), [SECURITY.md](SECURITY.md), [RUNBOOK.md](RUNBOOK.md)

## Appendix B: Ecosystem Project Inventory (Streaming)

| Project | Path | Key Tech | Integration Point |
|---|---|---|---|
| **PoseLab** | `~/develop/project89-reaction-forge/` | Three.js, three-vrm, MediaPipe, PeerJS, WebRTC | `window.project89Reactor` API, WebSocket bridge |
| **vtuber-stream** | `~/develop/vtuber-stream/` | Python, FFmpeg, Playwright, XTTS, sounddevice | PoseLab bridge (:8765), RTMP output, chat aggregation |
| **aws-swarm** | `~/develop/aws-swarm/` | Lambda, SQS, DynamoDB, Replicate, XTTS v2 | Voice pipeline, evaluator, platform delivery |
| **rtmp-multi-proxy** | `~/develop/rtmp-multi-proxy/` | Puppeteer, FFmpeg | Browser-to-RTMP utility |
| **Biome** | `~/develop/Biome/` | Tauri, Rust, React | Desktop client for GPU-rendered worlds |
| **CosyWorld** | `~/develop/cosyworld/` | Node.js | Avatar source for guest rotation |

### Key Integration Protocols

| Protocol | Port/URL | Direction | Purpose |
|---|---|---|---|
| **PoseLab WebSocket** | `ws://localhost:8765` | vtuber-stream → PoseLab | Emotion, gesture, mouth blend shape control |
| **PoseLab External API** | `window.project89Reactor` | Any → PoseLab (browser) | `setAvatarUrl()`, `setAvatarFile()`, `resetAvatar()` |
| **VMC Input** | `ws://localhost:39540` | XR devices → PoseLab | Motion capture data (OSC over WebSocket) |
| **Twitch EventSub** | WSS | Twitch → vtuber-stream | Chat messages, subscriptions, events |
| **pump.fun** | WSS (Engine.IO v4) | pump.fun → vtuber-stream | Live token chat |
| **RTMP** | `rtmp://<dest>/live/<key>` | vtuber-stream → platforms | H.264/AAC stream output |
| **raticross** | `POST /raticross/inbound` | Swarm ↔ peers | Agent-to-agent envelope relay |
| **Replicate webhook** | `POST /replicate-webhook` | Replicate → aws-swarm | Async media generation callbacks |

## Appendix C: Multi-Modal Pipeline Summary

### Current Production Capabilities (v0.24.0)

| Capability | Model | Provider | Async | Platform Delivery |
|---|---|---|---|---|
| Image generation | nano-banana-pro (swappable) | Replicate | Yes (webhook) | Telegram photo, Discord embed, Twitter media |
| Video generation | minimax/video-01 | Replicate | Yes (webhook) | Telegram video, Discord attachment |
| Voice cloning | 3-step: Stable Audio 2.5 → XTTS v2 → XTTS v2 | Replicate | Sync (chained) | Voice profile stored in DynamoDB |
| Text-to-speech | XTTS v2 | Replicate | Sync | Telegram voice, Discord audio |
| Transcription | Whisper-1 | OpenAI | Sync | Input processing (not delivery) |
| Sticker generation | nano-banana-pro + sharp | Replicate + local | Yes | Telegram sticker, Discord image fallback |
| Model discovery | Replicate API + schema caching | Replicate | N/A | MCP tool (`browse_image_models`) |

### Pipeline Architecture

```
User message → LLM evaluator → Tool call (generate_image, generate_video, etc.)
                                    │
                                    ▼
                            MediaJob created in DynamoDB
                                    │
                                    ▼
                         SQS MEDIA_QUEUE enqueue
                                    │
                                    ▼
                       MediaProcessor Lambda consumes
                         ├── Entitlement check (energy fallback)
                         ├── Replicate API call (async webhook)
                         └── Job status → "processing"
                                    │
                                    ▼ (10s–5min later)
                       Replicate Webhook callback
                         ├── Signature verification (HMAC-SHA256)
                         ├── Download → S3 upload
                         ├── Gallery entry created
                         ├── Job status → "completed"
                         └── Continuation message → RESPONSE_QUEUE
                                    │
                                    ▼
                       ResponseSender Lambda
                         ├── Platform adapter selection
                         ├── Media compression (Telegram: 4MB limit)
                         └── Delivery (sendPhoto, sendVoice, webhook embed, etc.)
```

### Voice Pipeline Detail

```
Step 1: Audio Seed                Step 2: First Clone              Step 3: Smoothed Clone
┌──────────────────┐             ┌──────────────────┐             ┌──────────────────┐
│ Stable Audio 2.5 │             │ XTTS v2          │             │ XTTS v2          │
│                  │             │                  │             │                  │
│ Input: text      │────────────►│ Input: seed audio│────────────►│ Input: raw clone │
│ prompt describing│  abstract   │ + reference text │  raw voice  │ + reference text │
│ voice character  │  .ogg file  │ cleanup: true    │  .ogg file  │ cleanup: false   │
│                  │             │                  │             │                  │
│ Output: 10s of   │             │ Output: voice    │             │ Output: smoothed │
│ tonal frequencies│             │ from pure sound  │             │ production voice │
└──────────────────┘             └──────────────────┘             └──────────────────┘
                                                                          │
                                                                          ▼
                                                                  VoiceProfile record
                                                                  (DynamoDB, reusable)
```
