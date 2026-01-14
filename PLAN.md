# AWS Swarm - Remaining Work

> **Last Updated:** 2026-01-13
> Extracted from PLAN.md - uncompleted items only

---

## Overall Progress Summary

| Component | Status | Notes |
|-----------|--------|-------|
| **Voice Messages** | ✅ DONE | Voice tools consolidated into `create_my_voice`, TTS, transcription complete |
| **Tool Routing** | ✅ DONE | Removed keyword-based routing; tools now selected by platform + enabled toolsets |
| **Avatar Chat Domains** | ⏳ NOT STARTED | `{avatar_wallet}.rati.chat` chat homes with NFT gating |
| **Billing + Entitlements** | ⏳ NOT STARTED | Paid plan gating and subscription lifecycle |
| **Privacy + Retention Defaults** | ⏳ NOT STARTED | Stateless free tier and opt-in durable memory |

### Admin Interface Features (Remaining)

| Feature | Status | Description |
|---------|--------|-------------|
| Deploy Trigger | ❌ | Not implemented (no deploy hook yet) |

---

## Critical Path to MVP (Remaining)

```
[ ] Billing + entitlements (paid plans, subscription lifecycle)
[ ] Memory opt-in + retention defaults (stateless free tier)
[ ] Deploy trigger from admin UI/API
```

---

## Prioritized Plan

### 1. Avatar Chat Domains
- Deterministic subdomain issuance
- NFT gate enforcement for chat rooms
- Staging vs production domains

### 2. Billing + Entitlements (MVP gate)
- Choose billing provider and plan model
- Implement subscription lifecycle and plan gating in runtime

### 3. Usage Metering + Spend Controls
- Track per-agent usage across handlers
- Enforce limits and expose usage in admin UI/API

### 4. Memory Opt-In + Retention
- Stateless free tier default
- Paid opt-in durable memory with retention windows and deletion/export flows

### 5. Control Plane Productization
- Deploy trigger from admin UI/API
- Template import/export + agent config versioning

### 6. Reliability + Observability
- Standardized logs + correlation IDs
- End-to-end Telegram test + canary rollout

### 7. Platform Expansion
- Harden X/Twitter adapter
- Discord slash commands

---

## MCP Registration Plan (Remaining)

### MCP Catalog + Ingestion
- ⏳ Trust score, allowlists, and rate limits

### Client Registration
- Document MCP client setup (command, args, env, metadata)
- Provide reference config for target clients (Claude Desktop, etc.)

### Deployment Mode
- Local stdio for dev; hosted MCP service for shared access
- Add rate limits and audit logging for MCP calls

---

## Avatar Chat Domain Plan

### Domain Assignment
- Deterministic domains for staging and production
- Optional vanity domains as upgrades

### Access Gating
- NFT ownership verification
- Session tokens with wallet proof

### Chat UX
- Minimal landing page + join flow
- Audit logging for join attempts

---

## Implementation Checklist (Remaining)

### Secrets Management
- [ ] Add audit logging to DynamoDB

### Wallet Management
- [ ] Add devnet airdrop tool

### Security
- [ ] Configure Cloudflare Access application
- [ ] Setup access policies (WebAuthn/fingerprint, Google, GitHub)
- [ ] Add audit logging for all admin actions
- [ ] Penetration testing

### Tooling & Context
- [x] Remove keyword-based tool routing; select tools by platform context + enabled toolsets only ✅ DONE
- [ ] Admin UI should list enabled vs disabled toolsets (disabled mentions only in admin prompt)
- [ ] Add explicit toolset toggles to agent config (ex: property research)
- [ ] Remove property research authorization gating; rely on toolset enablement
- [ ] Extend feature toggle UI/tooling to include property toolset (and future toolsets)
- [ ] Replace generic secret requests with feature-toggle flows (Twitter/Telegram/Discord/Media keys + OAuth)

#### Toolset Config Shape (Proposed)
- `AgentRecord.toolsets?: { property?: { enabled: boolean }; memory?: { enabled: boolean } }`
- `AgentConfig.toolsets?: { property?: { enabled: boolean }; memory?: { enabled: boolean } }`
- Keep platform toggles in `platforms.*.enabled`, voice in `voiceConfig.enabled`

#### Toolset Resolution Rules (Proposed)
- Admin UI:
  - Enabled toolsets = `core + admin + config + jobs` + enabled platform toolsets + enabled `toolsets.*` + voice when `voiceConfig.enabled`
  - Disabled toolsets listed in prompt (admin only) with enable instructions via `request_feature_toggle`
- Runtime channels (telegram/web/discord/twitter):
  - Enabled toolsets = `core` + toolsets relevant to that platform + enabled `toolsets.*` + voice when `voiceConfig.enabled`
  - Do not mention disabled toolsets in system prompt

#### Implementation Touchpoints (Plan)
- [x] Remove `routeTools` usage from admin + handlers; deprecate `tool-router` tests ✅ DONE
- [ ] Update dynamic prompts to include enabled + disabled toolsets (admin only)
- [ ] Update admin UI toggles to write `toolsets.*.enabled` for property (and future sets)
- [ ] Use `request_feature_toggle` to launch integration flows (Twitter OAuth, Telegram/Discord tokens, Replicate key)
- [ ] Remove `request_secret` from prompts/tool registry (or keep as hidden back-compat)
- [ ] Remove property auth checks + `request_property_research` flow; replace with toolset toggle

---

## File Structure (Remaining)

```
packages/core/src/platforms/
    └── discord.ts               # [ ] MISSING - Full Discord adapter
```

---

## Next Steps (Remaining)

### Immediate (Reliability + Security)

1. **Admin deployment verification**
   - [ ] Configure Cloudflare Access policies

2. **Admin feature gaps**
   - [ ] Add audit logging service to DynamoDB
   - [ ] Optional: deploy trigger integration (CodePipeline/Actions)
   - [ ] Toolset enable/disable controls in admin UI (property research, voice, etc)

### Short-term (First Agent)

3. **Create first agent via Admin UI**
   - [ ] Use local UI or deployed UI to create agent
   - [ ] Configure Telegram platform and set bot token
   - [ ] Set global OpenRouter API key
   - [ ] Generate Solana wallet for agent

4. **Deploy and verify**
   - [ ] Push to `main` to trigger GitHub Actions deploy
   - [ ] Register Telegram webhook URL
   - [ ] Run end-to-end Telegram test

### Medium-term (Polish)

5. **Twitter & Web adapters**
   - [ ] End-to-end testing

6. **Media generation in runtime pipeline**
   - [ ] Handle payload size limits (SQS 256KB) via S3 pointers for large prompts/metadata

### Operational Readiness
- [ ] Enable DynamoDB PITR + backup strategy for agent configs/state
- [ ] Define secrets rotation policy + admin audit trail requirements
- [ ] Add model allowlist/budget caps to control OpenRouter spend
- [ ] Document DLQ redrive/runbook for media/message queues

### Long-term (Additional Platforms)

7. **Discord adapter**
   - [ ] Implement slash commands

8. **Observability**
   - [ ] Standardize structured logging fields (`agentId`, `level`, `component`) for reliable filters
   - [ ] CloudWatch dashboards
   - [ ] X-Ray tracing

9. **CLI Tool**
   - [ ] `swarm agent create <name>`
   - [ ] `swarm agent deploy <name>`
   - [ ] `swarm secrets set <agent> <key> <value>`

---

## Consolidated Logging (Remaining)

### Implementation Steps
- [ ] Standardize JSON logging in all Lambdas (shared logger helper)
- [ ] Add agentId-aware log fields to handlers and admin API
- [ ] Optionally enable tracing (`traceId`) and OpenSearch indexing

---

## MVP Definition (Paid Platform)

To count as an MVP platform service, the system must let a user pay, activate a plan, and receive the corresponding runtime entitlements.

**Acceptance Criteria**
- Self-serve flow: create agent → connect Telegram → purchase plan → deploy → verify with logs
- Paid entitlements enforced in runtime (memory opt-in, higher limits, premium tools)
- Free tier is stateless beyond request processing; paid tier explicitly enables durable memory
- Usage metering for messages/tools/media with spend limits and exportable records
- Telegram path is stable with an end-to-end test and canary playbook

---

## Summary of Remaining Work

| Category | Items |
|----------|-------|
| **Core Features** | Avatar Chat Domains, Billing + Entitlements, Memory Opt-In |
| **Admin** | Deploy trigger, Audit logging |
| **Security** | Cloudflare Access policies, Penetration testing |
| **Platforms** | Discord slash commands, E2E testing for Twitter/Web |
| **Observability** | Structured logging, CloudWatch dashboards, X-Ray tracing |
| **Operations** | DynamoDB PITR, Secrets rotation, DLQ runbook |
| **Tooling** | CLI tool for agent management |
