# Solana Wallet Authentication Design

## Overview

Replace Cloudflare Access authentication with Solana wallet sign-in. Users authenticate by signing a message with their wallet (via Phantom QR scan on mobile or browser extension on desktop). This enables:

1. **User Identity** - Wallet address is the unique user identifier (no email)
2. **Avatar Inhabiting** - One-to-one: each agent has exactly one inhabitant (owner = inhabitant)
3. **Private DM Channels** - Inhabitant gets a private channel with their agent
4. **Shared Group Chat** - All authenticated users can see and participate in group channels
5. **Ghost Users** - Authenticated users without an inhabited avatar appear as ghosts

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Ownership model | 1:1 (one wallet per agent) | Owner = Inhabitant, simplicity |
| Claiming | First-come-first-served | Anyone can inhabit unclaimed agents |
| Abandonment | NFT burn required | Burn from `8GCAyy...TLJ` mint to release |
| Abandonment reward | Character NFT minted | User gets NFT of the character they're releasing |
| Ghost users | Ghost icon display | Users without avatar shown as ghost |
| Group chat visibility | All users see shared channel | Community interaction |
| Email tracking | None | Wallet is sole identity |
| Migration | Fresh start | Clean slate, no legacy baggage |
| Gating | Wallet-based (future) | Can add allowlists, token-gating later |

## NFT Integration

### Abandonment NFT Burn

To release/abandon an inhabited agent, the user must burn an NFT from this collection:

```
Mint Address: 8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ
```

**Flow:**
1. User clicks "Abandon Avatar"
2. Frontend prompts wallet to burn 1 NFT from the collection
3. Backend verifies burn transaction on-chain
4. Agent's `inhabitantWallet` is cleared
5. User receives a newly-minted NFT depicting the character they abandoned

### Character NFT Minting

When a user abandons their avatar, we mint them a commemorative NFT:
- Image: The agent's profile image
- Name: Agent's display name
- Metadata: Inhabitation dates, message count, etc.

This creates a "trading card" style collection of characters users have inhabited.

---

## Current State

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Admin UI      │────▶│ Cloudflare Access│────▶│   Admin API     │
│  (React SPA)    │     │   (JWT Auth)     │     │   (Lambda)      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                              UserSession: {              │
                                email: "user@example.com" │
                                userId: "cf-sub-id"       │
                                isAdmin: boolean          │
                              }                           ▼
                                                  ┌───────────────┐
                                                  │   DynamoDB    │
                                                  │  (No user     │
                                                  │   isolation)  │
                                                  └───────────────┘
```

**Current Limitations:**
- All authenticated users see all agents
- No concept of "ownership" or "inhabiting"
- No private user-agent channels
- No wallet-based identity

---

## Proposed Architecture

```
┌─────────────────┐                              ┌─────────────────┐
│   Admin UI      │◀─────── WebSocket ──────────▶│   Admin API     │
│  (React SPA)    │                              │   (Lambda)      │
│                 │                              │                 │
│  ┌───────────┐  │     ┌──────────────────┐     │  ┌───────────┐  │
│  │ Phantom   │──┼────▶│  SIWS Challenge  │────▶│  │ Verify    │  │
│  │ Wallet    │  │     │  (Sign-In With   │     │  │ Signature │  │
│  └───────────┘  │     │   Solana)        │     │  └───────────┘  │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                              UserSession: {              │
                                walletAddress: "ABC...XYZ"│
                                userId: "wallet-hash"     │
                                displayName?: string      │
                                inhabitedAgentId?: string │
                              }                           ▼
                                                  ┌───────────────┐
                                                  │   DynamoDB    │
                                                  │               │
                                                  │ USER#wallet   │
                                                  │ INHABIT#agent │
                                                  │ DM#user#agent │
                                                  └───────────────┘
```

---

## Data Model

### 1. User Record

```typescript
interface UserRecord {
  pk: `USER#${walletAddress}`;
  sk: 'PROFILE';

  walletAddress: string;        // Solana public key (base58)
  displayName?: string;         // Optional display name
  avatarUrl?: string;           // Profile picture URL

  // Current inhabited agent
  inhabitedAgentId?: string;    // Agent they're "being"
  inhabitedAt?: number;         // When they started inhabiting

  // Metadata
  createdAt: number;
  lastSeenAt: number;
  sessionCount: number;
}
```

### 2. Agent Inhabitation (1:1)

Inhabitation is stored directly on the agent record (owner = inhabitant):

```typescript
interface AgentRecord {
  pk: `AGENT#${agentId}`;
  sk: 'CONFIG';

  // ... existing fields ...

  // Inhabitation (1:1 - exactly one inhabitant who is also the owner)
  inhabitantWallet?: string;    // Wallet address of inhabitant (null = unclaimed)
  inhabitedAt?: number;         // When inhabitation was established

  // Inhabitant gets full permissions:
  // - Post as this agent on all platforms
  // - Edit persona, profile, settings
  // - Manage secrets and API keys
  // - Access private DM channel
  // - Appear as this avatar in shared chat
}
```

No separate inhabitation table needed - it's a field on the agent.

**Unclaimed agents** have `inhabitantWallet: undefined` and are visible to all users for claiming.

### 3. DM Channel Record

```typescript
interface DMChannelRecord {
  pk: `DM#${walletAddress}#${agentId}`;
  sk: 'CHANNEL';

  walletAddress: string;
  agentId: string;

  // Channel state
  lastMessageAt?: number;
  messageCount: number;
  unreadCount: number;

  // Privacy
  visibility: 'private';        // Only this user can see

  createdAt: number;
}

interface DMMessageRecord {
  pk: `DM#${walletAddress}#${agentId}`;
  sk: `MSG#${timestamp}#${messageId}`;

  messageId: string;
  role: 'user' | 'assistant';
  content: string;

  // Media attachments
  images?: string[];

  timestamp: number;

  // TTL for message cleanup (optional)
  ttl?: number;
}
```

### 4. Session Record

```typescript
interface SessionRecord {
  pk: `SESSION#${sessionToken}`;
  sk: 'DATA';

  sessionToken: string;         // Random token (stored in cookie)
  walletAddress: string;

  // Session metadata
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;

  // Device info
  userAgent?: string;
  ipAddress?: string;

  // TTL for auto-cleanup
  ttl: number;                  // Unix timestamp for DynamoDB TTL
}
```

---

## Authentication Flow

### Sign-In Flow (SIWS - Sign In With Solana)

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  User    │     │ Frontend │     │ Backend  │     │ Phantom  │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │  Click Login   │                │                │
     │───────────────▶│                │                │
     │                │                │                │
     │                │ GET /auth/challenge             │
     │                │───────────────▶│                │
     │                │                │                │
     │                │ { nonce, message, expiresAt }   │
     │                │◀───────────────│                │
     │                │                │                │
     │                │ Display QR / Connect Wallet     │
     │                │───────────────────────────────▶│
     │                │                │                │
     │  Scan QR       │                │                │
     │───────────────────────────────────────────────▶│
     │                │                │                │
     │                │ signMessage(challenge)         │
     │                │◀───────────────────────────────│
     │                │                │                │
     │                │ POST /auth/verify              │
     │                │ { signature, publicKey, nonce }│
     │                │───────────────▶│                │
     │                │                │                │
     │                │                │ Verify sig    │
     │                │                │ Create session│
     │                │                │                │
     │                │ Set-Cookie: session=xxx        │
     │                │ { user, session }              │
     │                │◀───────────────│                │
     │                │                │                │
     │  Authenticated │                │                │
     │◀───────────────│                │                │
```

### Challenge Message Format

```typescript
const challengeMessage = `
Sign this message to authenticate with Swarm Admin.

Domain: admin.rati.chat
Wallet: ${walletAddress}
Nonce: ${randomNonce}
Issued At: ${isoTimestamp}
Expiration: ${expirationTimestamp}

This signature will not trigger any blockchain transaction or cost any fees.
`.trim();
```

---

## API Endpoints

### Auth Endpoints

```typescript
// GET /auth/challenge
// Returns a challenge for the user to sign
interface ChallengeResponse {
  nonce: string;           // Random nonce (stored server-side with TTL)
  message: string;         // Message to sign
  expiresAt: number;       // Challenge expiration
}

// POST /auth/verify
// Verifies signature and creates session
interface VerifyRequest {
  signature: string;       // Base58 encoded signature
  publicKey: string;       // Wallet public key (base58)
  nonce: string;           // Nonce from challenge
}

interface VerifyResponse {
  success: boolean;
  session?: {
    token: string;         // Session token (also in cookie)
    expiresAt: number;
  };
  user?: {
    walletAddress: string;
    displayName?: string;
    inhabitedAgentId?: string;
  };
}

// POST /auth/logout
// Invalidates session
interface LogoutResponse {
  success: boolean;
}

// GET /auth/me
// Returns current user info
interface MeResponse {
  authenticated: boolean;
  user?: UserRecord;
}
```

### Inhabitation Endpoints

```typescript
// POST /agents/:agentId/inhabit
// Inhabit an unclaimed agent (first-come-first-served)
// Only works if agent has no inhabitantWallet set
interface InhabitResponse {
  success: boolean;
  agent?: AgentRecord;
  error?: 'already_inhabited' | 'not_found' | 'already_inhabiting';
}

// POST /agents/:agentId/abandon
// Abandon inhabited agent - REQUIRES NFT BURN
// Must burn 1 NFT from: 8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ
interface AbandonRequest {
  burnTxSignature: string;    // Signature of the burn transaction
}

interface AbandonResponse {
  success: boolean;
  characterNftMint?: string;  // Mint address of the character NFT given to user
  error?: 'not_inhabitant' | 'invalid_burn' | 'burn_not_confirmed';
}

// GET /agents/unclaimed
// List all unclaimed agents (visible to everyone)
interface UnclaimedAgentsResponse {
  agents: AgentRecord[];
}

// GET /agents/mine
// Get the agent inhabited by current wallet (max 1)
interface MyAgentResponse {
  agent?: AgentRecord;        // null if user is a ghost
}

// GET /users/:walletAddress/avatar
// Get the avatar for a specific user (for display in chat)
interface UserAvatarResponse {
  walletAddress: string;
  isGhost: boolean;
  agent?: {
    id: string;
    name: string;
    avatar?: string;
  };
}
```

### DM Endpoints

```typescript
// GET /dm/:agentId
// Get DM channel with an agent (creates if not exists)
interface DMChannelResponse {
  channel: DMChannelRecord;
  messages: DMMessageRecord[];  // Last N messages
}

// POST /dm/:agentId/messages
// Send a message in DM
interface SendDMRequest {
  content: string;
  images?: string[];
}

// GET /dm
// List all DM channels for current user
interface DMListResponse {
  channels: (DMChannelRecord & {
    agent: { id: string; name: string; avatar?: string };
    lastMessage?: DMMessageRecord;
  })[];
}
```

---

## Frontend Components

### 1. Auth Provider

```typescript
// src/contexts/AuthContext.tsx
interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserRecord | null;

  // Actions
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

// Uses @solana/wallet-adapter-react for wallet connection
```

### 2. Login Component

```typescript
// src/components/WalletLogin.tsx
// - Shows "Connect Wallet" button
// - On mobile: Shows QR code for Phantom scan
// - On desktop: Opens Phantom extension popup
// - Handles challenge/sign/verify flow
```

### 3. Avatar Selector

```typescript
// src/components/AvatarSelector.tsx
// - Shows agents user can inhabit
// - Click to inhabit (sets as active avatar)
// - Shows current inhabited agent prominently
// - Badge shows inhabitation status
```

### 4. DM Sidebar

```typescript
// src/components/DMSidebar.tsx
// - Lists private DM channels
// - Shows unread counts
// - Only visible to authenticated user
// - Click to open DM chat
```

---

## Migration Strategy

### Phase 1: Add Wallet Auth (Parallel)
1. Add `/auth/*` endpoints alongside Cloudflare Access
2. Add wallet connection UI (optional sign-in)
3. Support both auth methods simultaneously
4. Create user records on first wallet sign-in

### Phase 2: Add User Features
1. Implement inhabitation system
2. Add DM channels
3. Add user-scoped agent visibility
4. Migrate agent ownership to wallet addresses

### Phase 3: Remove Cloudflare Access
1. Make wallet auth primary
2. Remove Cloudflare Access from non-admin routes
3. Keep Cloudflare Access for admin-only operations (optional)
4. Update all API calls to use session cookies

---

## Security Considerations

### 1. Challenge Security
```typescript
// Challenge nonce stored in DynamoDB with 5-min TTL
// One-time use: deleted after successful verification
// Prevents replay attacks

interface ChallengeRecord {
  pk: `CHALLENGE#${nonce}`;
  sk: 'DATA';
  nonce: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;  // DynamoDB TTL
}
```

### 2. Session Security
- Sessions stored server-side (not JWT)
- HttpOnly, Secure, SameSite=Strict cookies
- 24-hour expiration with sliding window
- Can be revoked instantly

### 3. Signature Verification
```typescript
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

function verifySignature(
  message: string,
  signature: string,
  publicKey: string
): boolean {
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = bs58.decode(signature);
  const publicKeyBytes = new PublicKey(publicKey).toBytes();

  return nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    publicKeyBytes
  );
}
```

### 4. Rate Limiting
- Challenge generation: 10/min per IP
- Verification attempts: 5/min per wallet
- Failed attempts trigger exponential backoff

---

## Database Indexes

### Existing GSI1 (sk → pk)
Already exists, can be used for:
- Listing all sessions for a wallet
- Listing all DM channels

### New Access Patterns

| Access Pattern | Key Condition |
|----------------|---------------|
| Get user by wallet | `pk = USER#wallet, sk = PROFILE` |
| Get user's inhabited agent | `pk = USER#wallet, sk = PROFILE` (field) |
| List agent inhabitants | `pk = AGENT#agentId, sk begins_with INHABITANT#` |
| Get DM channel | `pk = DM#wallet#agentId, sk = CHANNEL` |
| List DM messages | `pk = DM#wallet#agentId, sk begins_with MSG#` |
| Get session | `pk = SESSION#token, sk = DATA` |
| List user's DMs | GSI1: `sk = CHANNEL, pk begins_with DM#wallet#` |

---

## Implementation Order

### Sprint 1: Core Auth (Week 1)
- [ ] Add `@solana/web3.js` and `tweetnacl` dependencies
- [ ] Create `/auth/challenge` endpoint
- [ ] Create `/auth/verify` endpoint with signature verification
- [ ] Create session management service
- [ ] Add session middleware to replace Cloudflare Access
- [ ] Create `WalletLogin` component with Phantom adapter

### Sprint 2: User System (Week 2)
- [ ] Create user record on first sign-in
- [ ] Add `/auth/me` endpoint
- [ ] Create `AuthContext` provider
- [ ] Add user profile UI (display name, avatar)
- [ ] Add session management (logout, view sessions)

### Sprint 3: Inhabitation (Week 3)
- [ ] Create inhabitation service
- [ ] Add inhabit/uninhabit endpoints
- [ ] Create `AvatarSelector` component
- [ ] Update agent list to show inhabitation status
- [ ] Add agent ownership model

### Sprint 4: DM Channels (Week 4)
- [ ] Create DM channel service
- [ ] Add DM endpoints
- [ ] Create `DMSidebar` component
- [ ] Create `DMChat` component
- [ ] Add real-time updates for DMs

---

## Dependencies

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.87.0",
    "@solana/wallet-adapter-react": "^0.15.35",
    "@solana/wallet-adapter-phantom": "^0.9.24",
    "@solana/wallet-adapter-react-ui": "^0.9.35",
    "tweetnacl": "^1.0.3",
    "bs58": "^5.0.0"
  }
}
```

---

## Open Questions

1. **Agent Ownership Model**
   - Can multiple users "own" an agent?
   - How is the first owner determined? (Creator? First inhabitant?)
   - Can ownership be transferred?

2. **Group Chat vs DM**
   - Should group chats be separate from DM channels?
   - Can multiple users chat in the same agent channel?
   - How to handle visibility of group messages?

3. **Backwards Compatibility**
   - How to migrate existing agents created via Cloudflare Access?
   - Map email → wallet address? Or fresh start?

4. **Admin Access**
   - Keep Cloudflare Access for admin operations?
   - Or designate admin wallets in config?

---

## Appendix: QR Code Flow for Mobile

```typescript
// Mobile users scan QR that deep-links to Phantom
// QR contains: phantom://sign?message=<base64>&redirect=<callback>

const qrData = {
  type: 'sign',
  message: base64Encode(challengeMessage),
  redirect: `https://admin.rati.chat/auth/callback`,
  cluster: 'mainnet-beta',
};

// After signing, Phantom redirects to:
// https://admin.rati.chat/auth/callback?signature=xxx&publicKey=xxx
```

This enables seamless mobile authentication without requiring the user to have the browser extension.
