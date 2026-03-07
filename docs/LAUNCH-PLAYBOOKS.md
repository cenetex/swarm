# ICP Launch Playbooks

Reproducible launch playbooks for each priority ICP segment. Use these to go from zero to a live, responding avatar in the shortest reliable path.

**Related docs:**

- [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md) -- ICP definitions, messaging matrix, funnel KPIs
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- entitlement tiers and web3 augmentation
- [PLAYBOOK-TELEGRAM-QUICKSTART.md](PLAYBOOK-TELEGRAM-QUICKSTART.md) -- operational repair playbook
- [design-philosophy.md](design-philosophy.md) -- chat-first design principles

**Platform note:** AWS Swarm is chat-first. All setup, configuration, and operations happen through the admin chat interface at [swarm.rati.chat](https://swarm.rati.chat). There are no settings pages, forms, or external configuration flows.

---

## Playbook 1: Creator-Operator (P1)

**ICP:** Solo operator managing 1--3 avatars. Telegram-first, comfortable with light technical setup.

**Goal:** Create one avatar, connect it to Telegram, and get a live response from a real user within 10 minutes.

**Plan tier:** Free (upgradeable to Pro for memory, multi-platform, autonomous posts).

### Prerequisites

| Item | Where to get it | Notes |
|------|----------------|-------|
| Telegram bot token | [@BotFather](https://t.me/BotFather) on Telegram: `/newbot` | Save the token securely. You will paste it into the admin chat. |
| Browser with internet access | -- | Chrome, Firefox, or Safari. |
| (Optional) Solana wallet | Phantom, Backpack, or any Solana wallet | Required only if you want web3 augmentation (Orb-holder boost). Not needed for Free tier. |

### Step-by-step Setup

**Step 1: Sign in to the admin interface**

1. Open [swarm.rati.chat](https://swarm.rati.chat) in your browser.
2. Sign in using your email or connect a Solana wallet.
3. You land in the admin chat. This is the only interface you need.

**Checkpoint:** You see the chat interface with a welcome message. The sidebar shows your account with zero avatars.

**Step 2: Create your avatar**

1. Type in the chat: `Create a new avatar called <your-avatar-name>`
2. The admin AI confirms creation and provides the avatar ID.
3. (Optional) Set a persona by typing: `Set the persona for <avatar-name> to: <your persona description>`

Example persona: "A friendly community assistant for a crypto project. Knowledgeable about DeFi, always encouraging, uses casual language."

**Checkpoint:** The sidebar now shows your avatar. The admin AI confirms the avatar was created and stored.

**Step 3: Connect Telegram**

1. Type: `Set up Telegram for <avatar-name>`
2. The admin AI renders an inline configuration panel in the chat.
3. Paste your Telegram bot token into the token input field.
4. Click the "Test" button to verify the token is valid.
5. Enable the Telegram integration using the toggle.

The system automatically:
- Stores the bot token in AWS Secrets Manager (write-only, encrypted with KMS).
- Generates a unique webhook secret.
- Registers the webhook URL with Telegram.

**Checkpoint:** The admin AI confirms "Telegram is now connected!" and shows the bot username. The integration status card shows "Connected."

**Step 4: Send a test message**

1. Open Telegram and find your bot by its username.
2. Send a message: "Hello!"
3. Wait up to 30 seconds for the avatar to respond.

**Checkpoint:** Your avatar replies in Telegram. This is the activation event (`F3`: first live response delivered).

**Step 5: Verify the full pipeline**

1. Return to the admin chat at swarm.rati.chat.
2. Type: `Show status for <avatar-name>`
3. Confirm the avatar shows:
   - Status: active
   - Telegram: connected
   - Recent activity: at least one message processed

**Checkpoint:** The status shows a healthy, active avatar with recent Telegram activity.

### Expected Outcomes

| Metric | Target |
|--------|--------|
| Time from sign-in to first live response | Under 10 minutes |
| Avatar responding in Telegram | Yes |
| Secrets stored securely | Yes (write-only, KMS-encrypted) |
| Webhook registered with Telegram | Yes |

### Demo Script (5 minutes)

Use this script when demonstrating the platform to a prospective creator-operator:

1. **[0:00]** Open swarm.rati.chat and sign in. Narrate: "This is the admin interface. Everything happens through chat."
2. **[0:30]** Type: `Create a new avatar called demo-bot` -- show the creation confirmation.
3. **[1:00]** Type: `Set the persona for demo-bot to: A friendly assistant who speaks in short, clear sentences.`
4. **[1:30]** Type: `Set up Telegram for demo-bot` -- paste a pre-prepared bot token. Click Test and Enable.
5. **[3:00]** Switch to Telegram. Send "What can you do?" to the bot. Wait for the response.
6. **[4:00]** Return to admin chat. Type: `Show status for demo-bot` -- show the healthy pipeline.
7. **[4:30]** Narrate: "The avatar is now live. All management stays in this chat. No infrastructure to manage."

### Troubleshooting

#### Avatar does not respond in Telegram

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No response at all | Webhook not registered or token invalid | In admin chat: `Set up Telegram for <avatar-name>` and re-enter the token. Verify the token works by clicking Test. |
| Response arrives after 60+ seconds | Cold start or queue backpressure | Send a second message. First-message latency is higher due to Lambda cold starts. Subsequent messages are faster. |
| "Avatar not found" in admin chat | Typo in avatar name | Type `List my avatars` to see the exact name, then retry. |

#### Telegram bot token is rejected

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Test button fails | Token is expired or was revoked | Go to @BotFather, run `/token` for your bot to get a fresh token. Paste the new one. |
| Token accepted but webhook fails | Bot was deleted or blocked by Telegram | Create a new bot with @BotFather and use the new token. |

#### Avatar replies with errors or nonsense

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Reply says "I'm not sure how to help" or similar | Persona is empty or too vague | Set a more detailed persona: `Set the persona for <avatar-name> to: <detailed description>` |
| Reply is cut off or incomplete | Message limit hit (Free: 50/day) | Check usage: `Show usage for <avatar-name>`. If at limit, wait for daily reset or upgrade to Pro. |

#### Escalation

If the above fixes do not resolve the issue, use the operational repair playbook: [PLAYBOOK-TELEGRAM-QUICKSTART.md](PLAYBOOK-TELEGRAM-QUICKSTART.md).

---

## Playbook 2: Small Team / Agency Operator (P2)

**ICP:** 2--10 person team managing multiple client or community avatars. Needs reliability, role separation, and account clarity.

**Goal:** Set up 3 avatars across Telegram and Discord, verify multi-avatar management, and confirm plan visibility.

**Plan tier:** Pro (required for multi-platform and memory).

### Prerequisites

| Item | Where to get it | Notes |
|------|----------------|-------|
| Telegram bot tokens (one per avatar) | [@BotFather](https://t.me/BotFather): `/newbot` for each | Each avatar gets its own bot. |
| Discord bot tokens (one per avatar) | [Discord Developer Portal](https://discord.com/developers/applications) | Create an application, add a bot, copy the token. |
| Discord server with admin permissions | -- | You need permission to add bots to the server. |
| Pro plan entitlement | Assigned in admin chat or via Stripe (when available) | Free tier is limited to 1 platform per avatar. |

### Step-by-step Setup

**Step 1: Sign in and verify Pro entitlement**

1. Open [swarm.rati.chat](https://swarm.rati.chat) and sign in.
2. Type: `Show my plan`
3. Confirm the response shows Pro tier with multi-platform access.

If you are on Free tier, type: `Upgrade to Pro` and follow the inline prompts.

**Checkpoint:** Plan shows Pro. Entitlement limits confirm: 500 messages/day, 3 platforms, memory enabled.

**Step 2: Create the avatar fleet**

Create each avatar with a distinct name and persona:

```
Create a new avatar called client-alpha
Set the persona for client-alpha to: A professional community manager for a fintech startup. Formal tone, concise answers, knowledgeable about payments and compliance.

Create a new avatar called client-beta
Set the persona for client-beta to: A casual gaming community bot. Uses slang, references popular games, keeps conversations fun.

Create a new avatar called client-gamma
Set the persona for client-gamma to: A multilingual support agent. Responds in the user's language. Professional and empathetic.
```

**Checkpoint:** The sidebar shows all three avatars. Each has a unique avatar ID.

**Step 3: Connect platforms per avatar**

For each avatar, connect the appropriate platforms:

```
Set up Telegram for client-alpha
Set up Discord for client-alpha
```

Repeat for client-beta and client-gamma with their respective tokens.

For Discord, the admin AI will provide an OAuth invite link to add the bot to your server. Click it, select the target server, and authorize.

**Checkpoint:** Each avatar shows its connected platforms in the status view. Run `Show status for client-alpha` (and beta, gamma) to confirm.

**Step 4: Test each avatar on each platform**

For every avatar-platform combination:

1. Send a test message on the connected platform.
2. Verify the avatar responds with the correct persona.
3. Confirm the response matches the avatar's configured personality (not another avatar's).

| Avatar | Platform | Test message | Expected behavior |
|--------|----------|-------------|-------------------|
| client-alpha | Telegram | "What do you help with?" | Professional, fintech-oriented reply |
| client-alpha | Discord | "Hello!" | Same persona, adapted to Discord context |
| client-beta | Telegram | "What games are popular?" | Casual, gaming-focused reply |
| client-gamma | Telegram | "Bonjour!" | Reply in French |

**Checkpoint:** All avatar-platform combinations respond correctly. No cross-contamination between personas.

**Step 5: Verify multi-avatar management**

1. Type: `List my avatars` -- confirm all three appear with correct status.
2. Type: `Show usage for client-alpha` -- confirm usage counters are tracking.
3. Type: `Show usage for client-beta` -- confirm independent usage tracking per avatar.

**Checkpoint:** Each avatar has independent usage counters. The admin chat provides a unified view of all avatars.

### Expected Outcomes

| Metric | Target |
|--------|--------|
| Time to set up 3 avatars with 2 platforms each | Under 30 minutes |
| All avatars responding on all connected platforms | Yes |
| Persona isolation verified (no cross-talk) | Yes |
| Usage tracking per avatar | Yes |
| Memory enabled for Pro-tier avatars | Yes |

### Demo Script (10 minutes)

1. **[0:00]** Sign in. Narrate: "We manage multiple client avatars from one admin chat."
2. **[0:30]** Type `List my avatars` -- show the fleet overview.
3. **[1:00]** Create a new avatar: `Create a new avatar called demo-agency`. Set a brief persona.
4. **[2:00]** Connect Telegram and Discord with pre-prepared tokens.
5. **[4:00]** Switch to Telegram, send a message, show the response.
6. **[5:00]** Switch to Discord, send a message, show the same persona responding on a different platform.
7. **[6:00]** Return to admin chat. `Show status for demo-agency` -- show platform health.
8. **[7:00]** `Show usage for demo-agency` -- show usage tracking.
9. **[8:00]** Demonstrate persona switching: select a different avatar in the sidebar, show its independent config.
10. **[9:00]** Narrate: "Each avatar is isolated -- separate secrets, separate state, separate usage. One interface to manage them all."

### Troubleshooting

#### Only one platform works per avatar

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Second platform setup says "limit reached" | Account is on Free tier (1 platform limit) | Type `Show my plan` and upgrade to Pro if needed. |
| Discord bot is online but does not respond | Bot lacks message content intent | In the Discord Developer Portal, enable the "Message Content Intent" under Privileged Gateway Intents. Then re-test. |

#### Avatars respond with wrong persona

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Avatar A responds as Avatar B | Bot tokens swapped during setup | Check which token is assigned: `Show status for <avatar-name>`. Re-enter the correct token for each avatar. |
| Persona is generic/default | Persona was not saved | Re-set the persona: `Set the persona for <avatar-name> to: <description>`. Verify with `Show config for <avatar-name>`. |

#### Usage counters not updating

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Usage shows 0 after several messages | Usage metering delay | Wait 1--2 minutes and re-check. Usage counters update asynchronously. |
| Usage shows for one avatar but not another | Second avatar's webhook is not firing | Check platform integration status: `Show status for <avatar-name>`. Re-run platform setup if disconnected. |

#### Escalation

For platform-specific wiring issues, use [PLAYBOOK-TELEGRAM-QUICKSTART.md](PLAYBOOK-TELEGRAM-QUICKSTART.md). For multi-avatar operational issues, check [RUNBOOK.md](RUNBOOK.md).

---

## Playbook 3: Enterprise Design Partner (P3)

**ICP:** Governance-sensitive organization requiring auditability, controls, and policy enforcement. Participating as a design partner during M2.

**Goal:** Onboard as a design partner, deploy one avatar with audit logging enabled, verify governance controls, and establish a feedback loop with the platform team.

**Plan tier:** Enterprise (manual assignment during design partner phase).

### Prerequisites

| Item | Where to get it | Notes |
|------|----------------|-------|
| Design partner agreement | Contact the platform team | Establishes scope, feedback cadence, and governance requirements. |
| Enterprise entitlement | Assigned by platform admin after agreement | Enables unlimited messages, platforms, memory with 365-day retention, and extended tool calls. |
| Telegram bot token | [@BotFather](https://t.me/BotFather) | At least one platform to test the full pipeline. |
| Compliance requirements document | Internal to your organization | Identify what audit, logging, and control requirements the platform must meet. |

### Step-by-step Setup

**Step 1: Confirm design partner enrollment**

1. Open [swarm.rati.chat](https://swarm.rati.chat) and sign in with the account designated for the design partnership.
2. Type: `Show my plan`
3. Confirm Enterprise tier is active with the expected entitlements:
   - Messages/day: unlimited
   - Platforms: unlimited
   - Memory: 365-day retention
   - Tool calls/message: 10

**Checkpoint:** Enterprise entitlements are confirmed. If not showing, contact the platform team to complete manual assignment.

**Step 2: Create a governed avatar**

1. Type: `Create a new avatar called <org-prefix>-pilot`
2. Set a persona aligned with your organization's use case:

```
Set the persona for acme-pilot to: A customer support agent for Acme Corp. Professional, empathetic, follows company guidelines. Never speculates about financial outcomes. Always refers legal questions to the legal team.
```

**Checkpoint:** Avatar created. Persona explicitly includes guardrails relevant to your compliance requirements.

**Step 3: Connect platforms and verify secrets handling**

1. Type: `Set up Telegram for <avatar-name>`
2. Enter the bot token via the inline secret prompt.
3. After connection, verify secret storage by typing: `Show status for <avatar-name>`

Confirm:
- The bot token is listed as "set" but the value is never displayed (write-only secrets).
- The webhook secret was auto-generated.

**Checkpoint:** Secrets are stored but not readable. This verifies the write-only security model.

**Step 4: Verify audit logging**

1. Send a test message to the avatar on Telegram.
2. Return to the admin chat and type: `Show recent activity for <avatar-name>`
3. Verify the activity log shows:
   - Timestamp of the interaction.
   - Event type (message received, response sent).
   - Avatar ID and platform.
   - No message content in the logs (content is never logged for privacy).

**Checkpoint:** Audit trail shows structured metadata without PII exposure. Logs include avatarId, platform, event type, and requestId.

**Step 5: Test operational controls**

Verify that the platform provides the governance primitives your organization requires:

| Control | How to verify | Expected result |
|---------|--------------|-----------------|
| Avatar pause/resume | `Pause <avatar-name>` then send a Telegram message | Avatar does not respond while paused. Resume restores responses. |
| Persona enforcement | Send a message that conflicts with persona guardrails | Avatar stays in character and applies persona constraints. |
| Usage visibility | `Show usage for <avatar-name>` | Detailed breakdown of messages, tool calls, media by day. |
| Memory management | `Show memories for <avatar-name>` | Memories are visible, deletable, and exportable. |
| Secret rotation | `Rotate Telegram webhook secret for <avatar-name>` | Secret is rotated and webhook is re-registered. Brief 5-minute cache window. |

**Checkpoint:** All governance controls function as expected. Document any gaps for the design partner feedback loop.

**Step 6: Establish feedback cadence**

1. Document findings from Steps 3--5 in a shared format (issue, document, or meeting notes).
2. Agree on a regular feedback cadence with the platform team (recommended: bi-weekly).
3. Submit governance gaps or feature requests as labeled GitHub issues (`type:feature`, `priority:high`, tag: enterprise).

**Checkpoint:** Feedback loop is active. Both parties have a clear channel for governance requirements and platform responses.

### Expected Outcomes

| Metric | Target |
|--------|--------|
| Time from enrollment to first governed avatar | Under 1 hour (including onboarding call) |
| Audit log captures all interactions | Yes (metadata only, no content) |
| Write-only secret model verified | Yes |
| Avatar pause/resume works | Yes |
| Feedback loop established | Yes, with agreed cadence |

### Demo Script (15 minutes)

1. **[0:00]** Narrate: "This demo shows the governance and audit capabilities for enterprise use."
2. **[1:00]** Sign in. `Show my plan` -- show Enterprise entitlements.
3. **[2:00]** Create avatar: `Create a new avatar called acme-pilot`. Set a compliance-aware persona.
4. **[4:00]** Connect Telegram. Show the inline secret prompt. Note: "The token is stored encrypted and cannot be read back."
5. **[6:00]** Send a test message on Telegram. Show the response.
6. **[7:00]** Return to admin chat. `Show recent activity for acme-pilot` -- show the audit log with metadata-only entries.
7. **[9:00]** `Pause acme-pilot`. Send a Telegram message. Show that it is silently dropped. `Resume acme-pilot`.
8. **[11:00]** `Show usage for acme-pilot` -- show usage tracking.
9. **[12:00]** `Show memories for acme-pilot` -- show memory visibility and deletion.
10. **[13:00]** Narrate: "Every action is logged. Secrets are write-only. Avatars can be paused instantly. Memory is inspectable and deletable."
11. **[14:00]** Show the governance gap log template. Narrate: "We run bi-weekly feedback sessions to close governance gaps before general availability."

### Troubleshooting

#### Enterprise entitlements not showing

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Plan shows Free or Pro instead of Enterprise | Manual assignment not completed | Contact the platform team. Enterprise entitlements are assigned manually during the design partner phase. |
| Entitlements show Enterprise but limits seem wrong | Cached runtime contract | Wait 5 minutes for the runtime contract to sync. If still wrong, type `Show my plan` again and note the exact limits shown. Report to platform team. |

#### Audit logs are missing entries

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Activity log is empty after sending messages | Avatar is paused or webhook is disconnected | `Show status for <avatar-name>` -- verify avatar is active and platform is connected. |
| Logs show events but missing fields | Log schema mismatch | Report the exact log output to the platform team as a design partner feedback item. |

#### Persona guardrails not enforced

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Avatar ignores persona constraints | Persona description is too vague | Rewrite the persona with explicit constraints: "NEVER discuss X. ALWAYS refer Y to Z." |
| Avatar occasionally breaks character | LLM probabilistic behavior | Report the specific prompt and response to the platform team. Persona enforcement improvements are tracked as M3 governance items. |

#### Memory or data concerns

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Cannot delete specific memories | Memory not found across tiers | Verify the memory ID is correct. Selective delete and bulk delete cover all memory tiers (legacy and durable). If the issue persists, report as a bug. |
| Unclear what data is retained | Data retention policy not reviewed | See [DATA-RETENTION-MATRIX.md](DATA-RETENTION-MATRIX.md) for the full retention schedule by data type. |

#### Escalation

Enterprise design partners have a direct line to the platform team. For operational issues, also reference [RUNBOOK.md](RUNBOOK.md) and [MONITORING-OPERATOR-GUIDE.md](MONITORING-OPERATOR-GUIDE.md).

---

## Quick Reference: Verification Checklist

Use this checklist after completing any playbook to confirm the setup is healthy.

| Check | Command (in admin chat) | Expected |
|-------|------------------------|----------|
| Avatar exists | `List my avatars` | Avatar appears in list |
| Avatar is active | `Show status for <avatar-name>` | Status: active |
| Platform connected | `Show status for <avatar-name>` | Platform shows "connected" |
| Live response works | Send message on platform | Response received within 30 seconds |
| Usage tracked | `Show usage for <avatar-name>` | Non-zero message count |
| Plan correct | `Show my plan` | Expected tier and limits |

---

*Last updated: 2026-02-23*
