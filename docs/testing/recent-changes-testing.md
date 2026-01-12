# Testing Document: Recent Changes

Generated: 2026-01-12

This document covers testing procedures for recent changes to the AWS Swarm platform.

---

## 1. Property Research System

**Files Changed:**
- `packages/admin-api/src/services/property-research.ts` (new)
- `packages/mcp-server/src/tools/property.ts` (new)
- `packages/admin-ui/src/components/ToolPrompts.tsx`

### Test Cases

#### 1.1 Property Research Authorization
- [ ] In admin UI, ask agent: "enable property research"
- [ ] Verify amber authorization card appears with Grant/Deny buttons
- [ ] Click "Grant Access" - verify success message
- [ ] Click "Deny" on a fresh request - verify agent acknowledges denial

#### 1.2 Property Research Job Creation
- [ ] After granting auth, ask: "research 123 Main St, Austin, TX 78701"
- [ ] Verify job is created and queued
- [ ] Check job status with: "check my research queue"

#### 1.3 Property Research Execution
- [ ] Verify web search is triggered for listings, comparables, etc.
- [ ] Verify report is generated in markdown format
- [ ] Verify job status updates (queued → researching → completed/failed)

---

## 2. Telegram Image Generation Fix

**Files Changed:**
- `packages/infra/src/constructs/admin-api.ts` (added REPLICATE_WEBHOOK_URL)

### Test Cases

#### 2.1 Image Generation on Telegram
- [ ] In Telegram, ask bot to generate an image
- [ ] Verify job is created (not immediate error)
- [ ] Wait 30-60 seconds for generation
- [ ] Verify image is sent back to Telegram chat
- [ ] Check CloudWatch logs for webhook callback from Replicate

#### 2.2 Video Generation on Telegram
- [ ] Ask bot to generate a video
- [ ] Verify job queued successfully
- [ ] Verify video delivered after processing

---

## 3. NFT Inhabitation System

**Files Changed:**
- `packages/admin-api/src/handlers/wallet-auth.ts`
- `packages/admin-api/src/services/agents.ts`
- `packages/admin-api/src/services/lineage-nft.ts`
- `packages/mcp-server/src/tools/nft.ts`
- `packages/admin-ui/src/store/walletAuth.ts`

### Test Cases

#### 3.1 Wallet Connection
- [ ] Connect Solana wallet (Phantom/Solflare)
- [ ] Verify challenge/signature flow works
- [ ] Verify session is established (check /auth/me)

#### 3.2 Unclaimed Agent Discovery
- [ ] With wallet connected, call `/auth/unclaimed-agents`
- [ ] Verify list shows agents without inhabitants
- [ ] Verify agents with `inhabitantWallet` set are NOT listed

#### 3.3 Agent Inhabitation
- [ ] Attempt to inhabit an unclaimed agent
- [ ] Verify Gate NFT is required and burned
- [ ] Verify `inhabitantWallet` is set on agent after inhabitation
- [ ] Verify Lineage NFT is minted to user

#### 3.4 Agent Abandonment
- [ ] With inhabited agent, attempt to abandon
- [ ] Verify Lineage NFT burn is required
- [ ] Verify `inhabitantWallet` is cleared after abandonment
- [ ] Verify `currentEra` increments

#### 3.5 Legacy Endpoint Removal
- [ ] Verify `/auth/claim` returns 404 (removed)
- [ ] Verify `/auth/release` returns 404 (removed)

#### 3.6 Agent Self-Awareness Tools (MCP)
- [ ] Agent can call `get_my_inhabitation_status` - returns own status only
- [ ] Agent can call `get_inhabitation_link` - returns URL for users
- [ ] Agent can call `get_my_lineage` - returns lineage history
- [ ] Verify agents CANNOT see other agents' inhabitation status

---

## 4. Thinking Tags & Memory Storage

**Files Changed:**
- `packages/core/src/utils/thinking-tags.ts` (new)
- `packages/core/src/utils/thinking-tags.test.ts` (new)
- `packages/admin-api/src/handlers/telegram-webhook.ts`

### Test Cases

#### 4.1 Thinking Tag Extraction
- [ ] Run unit tests: `pnpm -F @swarm/core test`
- [ ] Verify `<thinking>` tags are extracted from LLM responses
- [ ] Verify thinking content is NOT sent to users
- [ ] Verify thinking is stored to agent memory

#### 4.2 Telegram Integration
- [ ] In Telegram, ask bot a complex question
- [ ] Verify response doesn't contain `<thinking>` tags
- [ ] Check agent memory for stored thinking blocks

---

## 5. Image Viewing in Telegram

**Files Changed:**
- `packages/admin-api/src/handlers/telegram-webhook.ts`

### Test Cases

#### 5.1 Multimodal Vision
- [ ] Send an image to the Telegram bot
- [ ] Ask the bot to describe the image
- [ ] Verify bot can see and describe the image content
- [ ] Test with multiple images in conversation

---

## 6. Admin UI Enhancements

**Files Changed:**
- `packages/admin-ui/src/components/ChatMessage.tsx`
- `packages/admin-ui/src/components/ImageModal.tsx` (new)
- `packages/admin-ui/src/App.tsx`

### Test Cases

#### 6.1 Image Modal
- [ ] Click on an image in chat
- [ ] Verify modal opens with full-size image
- [ ] Verify modal can be closed (click outside or X button)

#### 6.2 Tool Call Display
- [ ] Generate an image in admin UI
- [ ] Verify tool calls are displayed correctly
- [ ] Verify pending job indicators show

#### 6.3 Tiered Access Control
- [ ] Test as guest (no wallet) - verify limited access
- [ ] Test with wallet but no orb - verify partial access
- [ ] Test with orb ownership - verify full access

---

## 7. Auto-Issues System

**Files Changed:**
- `packages/admin-api/src/services/auto-issues.ts` (new)

### Test Cases

#### 7.1 Issue Reporting
- [ ] Agent encounters an error
- [ ] Verify issue is logged to CloudWatch with structured format
- [ ] Run `./scripts/download-issues.sh` to fetch issues
- [ ] Verify issues appear in `issues/staging/` directory

---

## 8. GSI2 Removal / Scan Fallback

**Files Changed:**
- `packages/admin-api/src/services/property-research.ts`
- `packages/admin-api/src/services/media-jobs.ts`

### Test Cases

#### 8.1 Pending Jobs Query
- [ ] Call `get_pending_jobs` tool
- [ ] Verify it works without GSI2 (uses scan fallback)
- [ ] Verify no "GSI2 not found" errors

#### 8.2 Property Research Jobs
- [ ] List property research jobs
- [ ] Verify scan-based query works correctly

---

## 9. Shared Chat / Multi-Agent Channels

**Files Changed:**
- `packages/admin-api/src/handlers/shared-chat.ts`
- `packages/admin-api/src/services/channel-state.ts`

### Test Cases

#### 9.1 Shared History
- [ ] Two bots in same Telegram supergroup
- [ ] Bot A sends a message
- [ ] Verify Bot B can see Bot A's message in shared history
- [ ] Verify bots don't talk over each other (initiative system)

---

## Quick Smoke Test Checklist

Run these basic checks after deployment:

```bash
# 1. Health check
curl https://api-staging.rati.chat/health

# 2. List agents (requires auth)
curl https://api-staging.rati.chat/agents

# 3. Check a Telegram bot is responsive
# Send "hello" to @YourBotName in Telegram

# 4. Admin UI loads
# Visit https://admin-staging.rati.chat
# - Login works
# - Agent list loads
# - Chat with agent works
```

---

## Known Issues / Limitations

1. **Property Research** - Uses basic web scraping; results vary based on site availability
2. **Replicate Webhook** - Requires public API endpoint; local testing needs ngrok or similar
3. **NFT Operations** - Require actual Solana transactions; use devnet for testing
4. **Image Vision** - Only works on Telegram (not admin UI yet)

---

## Rollback Procedure

If critical issues are found:

```bash
# Revert to previous deployment
git revert HEAD
git push origin main
# GitHub Actions will auto-deploy
```

For infrastructure-only issues:
```bash
# In AWS Console, roll back CloudFormation stack to previous version
```
