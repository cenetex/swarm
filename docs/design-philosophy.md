# Swarm Design Philosophy

This document defines the core design principles that guide all development on Swarm. These principles are non-negotiable and must be followed in all contributions.

---

## Core Principle: Chat is the Interface

**Swarm is chat-first.** The conversational interface is not just a feature—it is the entire product experience. Every user action, configuration change, and administrative operation must flow through the chat.

### What This Means

1. **No Settings Pages**: Configuration happens through conversation, not forms
2. **No Modals for Actions**: Use inline prompts rendered within the chat flow
3. **No Separate Workflows**: Multi-step processes unfold naturally in dialogue
4. **No Navigation Away**: Users never leave the chat to accomplish tasks

### Why This Matters

- **Unified Experience**: One interface to learn, one mental model
- **Contextual Actions**: The AI understands what you're trying to do
- **Natural Language**: Describe what you want instead of finding the right button
- **Accessibility**: Works across platforms with minimal UI requirements

---

## The Five Pillars

### 1. Conversational Configuration

All avatar configuration happens through dialogue with the admin AI.

**Pattern: Inline Tool Prompts**

When the AI needs user input (credentials, selections, toggles), it renders an inline UI component within the chat message:

```
User: "Set up Telegram"
    ↓
AI: "I'll help you configure Telegram."
    [Inline panel appears with bot token input, test button, enable toggle]
    ↓
User: [Enters token, clicks Test]
    ↓
AI: "Telegram is now connected! You'll receive messages at @YourBot"
```

**Implementation Details:**

- `SecretPrompt`: Password input for API keys, rendered inline
- `IntegrationConfigPrompt`: Full integration panel (Telegram, Twitter, Discord)
- `FeatureTogglePrompt`: Simple on/off toggle for features
- `ModelSelectorPrompt`: Dropdown for model selection with pricing info
- `ConfirmationPrompt`: Yes/No buttons for destructive actions

**Anti-Patterns (Never Do This):**

- ❌ Settings gear icon that opens a modal
- ❌ Separate "/settings" page or route
- ❌ Configuration wizard outside the chat
- ❌ Admin dashboard with forms

### 2. Tool-Driven Actions

Every action the AI can take is defined as a tool. Tools are the bridge between natural language and system operations.

**Tool Categories:**

| Category | Purpose | Examples |
|----------|---------|----------|
| `profile` | Avatar identity management | update_name, set_persona, upload_image |
| `secrets` | Credential management | request_secret, configure_integration |
| `wallets` | Blockchain operations | create_wallet, check_balance, send_tokens |
| `media` | Content generation | generate_image, generate_video, create_sticker |
| `memory` | Knowledge persistence | remember, recall, forget |
| `twitter` | X/Twitter operations | post_tweet, search_mentions, reply |
| `telegram` | Telegram operations | send_message, create_sticker_pack |
| `discord` | Discord operations | send_channel_message, manage_roles |

**Tool Execution Types:**

1. **Auto-Executing**: Tool runs immediately, result returned to AI
   - Example: `check_wallet_balance` → Returns balance → AI reports it

2. **Manual/Pause**: Tool pauses for user input via inline UI
   - Example: `configure_integration` → Renders panel → Waits for input

3. **Async/Job**: Tool starts background job, continues later
   - Example: `generate_video` → Returns job ID → AI mentions it's processing → Result arrives via continuation

**Disabled-by-Default Philosophy:**

Tools are only available if their category is enabled for the avatar. The system prompt only describes capabilities the avatar actually has. This prevents confusion about unavailable features.

### 3. Platform Abstraction

All social platforms normalize to a universal message format. The avatar's personality remains consistent across Telegram, Discord, Twitter, and Web.

**The SwarmEnvelope:**

Every incoming message, regardless of platform, becomes a `SwarmEnvelope`:

```typescript
interface SwarmEnvelope {
  platform: 'telegram' | 'discord' | 'twitter' | 'web';
  sender: {
    id: string;
    username?: string;
    displayName?: string;
    isBot: boolean;
  };
  content: {
    text?: string;
    media?: MediaAttachment[];
    command?: string;
    replyTo?: MessageReference;
  };
  context: {
    channelId: string;
    channelType: 'private' | 'group' | 'channel';
    isDirectEngagement: boolean;  // Mentioned or replied to
    mentions: string[];
  };
  raw: unknown;  // Original platform payload
}
```

**Platform Adapters:**

Each platform implements:
- `verifyRequest()`: Authenticate webhook (secret token, HMAC, etc.)
- `parseMessage()`: Convert to SwarmEnvelope
- `executeAction()`: Send responses back to platform
- `sendTypingIndicator()`: Optional typing affordance

**Same Processing Pipeline:**

```
Telegram Webhook ──┐
Discord Webhook ───┼──→ SwarmEnvelope ──→ MessageProcessor ──→ Response
Twitter Polling ───┤
Web API ───────────┘
```

### 4. Multi-Tenant Isolation

Each avatar operates independently with complete data isolation on shared infrastructure.

**Isolation Boundaries:**

| Resource | Isolation Method |
|----------|------------------|
| DynamoDB | Partition key prefix: `AVATAR#{id}` |
| Secrets | Path: `swarm/{avatarId}/{secret_name}` |
| Configuration | Stored per-avatar in DynamoDB |
| State | Channel state keyed by avatar + channel |
| Logs | Tagged with `avatarId` for filtering |

**Shared Infrastructure:**

- Same Lambda functions (avatar ID passed in event)
- Same SQS queues (message routing by avatar ID)
- Same DynamoDB table (PK isolation)
- Same CloudWatch log groups (filtered by avatar)

**Security Guarantees:**

1. **Write-Only Secrets**: Avatar can SET secrets but never READ values
2. **Isolated State**: One avatar cannot access another's data
3. **Scoped Tools**: Tools only operate on the requesting avatar
4. **Audit Logging**: All operations logged with avatar context

### 5. Async-First Media

Media generation (images, videos, audio) is inherently slow. The system handles this gracefully without blocking conversation.

**The Continuation Pattern:**

```
User: "Generate an image of a sunset"
    ↓
AI: "I'm generating that image now. I'll share it when it's ready."
    [Returns job ID, conversation continues]
    ↓
[30 seconds later, job completes]
    ↓
AI: "Here's your sunset image!"
    [Image displayed inline with download option]
```

**Implementation:**

1. Tool returns `{ jobId, status: 'pending' }`
2. UI displays progress indicator
3. Background poller checks job status
4. On completion, continuation message injected
5. AI receives result and presents to user

**Rate Limiting:**

Media generation has credit limits to prevent abuse:
- 20 credits max per avatar
- Refills 10 credits per hour
- Different costs per operation (image: 1, video: 5)

---

## UI Component Patterns

### Message Rendering

Messages are rich, not plain text. Tool results render as structured cards:

**Result Card Types:**

- **Wallet Card**: Address (copyable), balance, explorer link
- **Tweet Card**: Author, content, engagement stats, link to tweet
- **Media Card**: Thumbnail, download button, generation metadata
- **Integration Status**: Connected/disconnected indicator, test button
- **Error Card**: Red border, error message, suggested action

**Inline Actions:**

Buttons appear within messages for immediate actions:
- "Inhabit this avatar" → Triggers inhabitation flow
- "Copy address" → Copies to clipboard
- "View on Explorer" → Opens blockchain explorer
- "Connect X/Twitter" → Starts OAuth flow

### Sidebar Design

The sidebar is minimal—a list of avatars, not a navigation menu.

**Elements:**
- Avatar list with status indicators (active, idle, error)
- Slot visualization (free slots, Orb slots)
- Create button (opens new chat, not a form)
- Wallet connection at bottom

**What's NOT in the Sidebar:**
- Settings button
- Navigation menu
- Configuration links
- Admin tools

### State Management

**Zustand Store Pattern:**

```typescript
// Persisted (survives refresh)
avatars: Avatar[]
activeAvatarId: string | null

// Ephemeral (loaded from backend)
chatHistory: Message[]  // Synced on avatar selection
```

**Cross-Device Sync:**

Chat history always loads from backend, not local storage. This ensures consistency across devices and sessions.

---

## Handler Architecture

### Message Processing Pipeline

```
1. Webhook receives platform event
2. Verify request authenticity
3. Parse to SwarmEnvelope
4. Queue to MESSAGE_QUEUE (SQS)
5. MessageProcessor consumes:
   a. Load avatar config
   b. Check response triggers
   c. Build tool registry (enabled categories only)
   d. Build system prompt (tool-aware)
   e. Call LLM with conversation + tools
   f. Execute tool calls (max 5 iterations)
   g. Queue response to RESPONSE_QUEUE
6. ResponseSender consumes:
   a. Send to platform
   b. Log activity
```

### Response Trigger Evaluation

Not every message gets a response. The system evaluates:

| Trigger | Condition |
|---------|-----------|
| Direct Engagement | Avatar mentioned or replied to |
| Private Chat | Always respond in DMs |
| Message Threshold | N messages accumulated since last response |
| Conversation Gap | Silence window exceeded |
| Scheduled | Autonomous posting schedule |

### Channel State Machine

```
IDLE ──[message received]──→ ACTIVE
ACTIVE ──[response sent]──→ COOLDOWN
COOLDOWN ──[cooldown expires]──→ IDLE
```

State persists per channel per avatar with 90-day TTL.

---

## Security Principles

### Webhook Security

1. **Secret Token**: Timing-safe comparison of `X-Telegram-Bot-Api-Secret-Token`
2. **IP Verification**: Check against platform's official IP ranges
3. **No Information Disclosure**: All errors return 200 OK
4. **Sanitized Logging**: Never log message content, only metadata

### Secret Management

1. **KMS Encryption**: All secrets encrypted at rest
2. **Write-Only Access**: UI can set secrets, never read values
3. **Per-Avatar Isolation**: Secrets stored at `swarm/{avatarId}/...`
4. **Shared Fallbacks**: System-level keys at `swarm/shared/...`

### Idempotency

Every message has a unique key: `{platform}:{avatarId}:{messageId}`

- Prevents duplicate processing on webhook retries
- 24-hour TTL for idempotency records
- Responses tracked with `{conversationId}#{messageId}`

---

## Logging & Observability

### Structured JSON Logging

Every log entry includes:

```json
{
  "timestamp": "ISO8601",
  "level": "INFO|WARN|ERROR|DEBUG",
  "message": "Human readable",
  "avatarId": "avatar_123",
  "platform": "telegram",
  "conversationId": "chat_456",
  "requestId": "lambda_request_id",
  "event": "message_received|response_sent|tool_executed",
  "subsystem": "handlers|core|admin-api"
}
```

### What to Log

- ✅ Event types and outcomes
- ✅ Message metadata (ID, length, type)
- ✅ Tool calls and results (sanitized)
- ✅ Errors with context
- ✅ Performance metrics (duration, token counts)

### What NOT to Log

- ❌ Message content (PII risk)
- ❌ Secret values (even masked)
- ❌ Full conversation history
- ❌ User personal information

---

## Development Guidelines

### Adding a New Feature

1. **Define Tools First**: What tools does the AI need?
2. **Design the Conversation**: How will users interact via chat?
3. **Implement Inline UI**: What prompts need to render in chat?
4. **Update System Prompt**: What should the AI know about this feature?
5. **Test the Flow**: Can everything be done without leaving chat?

### Code Review Checklist

- [ ] No new settings pages or modals created
- [ ] All configuration flows through chat
- [ ] Tools defined with clear descriptions
- [ ] Inline prompts used for user input
- [ ] Secrets handled write-only
- [ ] Logging follows structured format
- [ ] No message content in logs

### Anti-Pattern Detection

If you find yourself:
- Creating a new route for configuration → Stop, use inline prompt
- Adding a modal for user input → Stop, use chat tool
- Building a settings form → Stop, define tools instead
- Adding navigation to leave chat → Stop, rethink the flow

---

## Summary

Swarm is built on a simple but powerful idea: **the chat is the product**.

Every feature, every configuration, every action flows through natural conversation with an AI that understands context and can take action. This creates a unified, accessible, and intuitive experience that works the same way across all platforms.

When in doubt, ask: "Can the user do this entirely within the chat?" If not, redesign until they can.

---

*This document is the canonical reference for Swarm design decisions. All contributors must read and follow these principles.*
