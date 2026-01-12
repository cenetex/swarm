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
| Agent creation | Gate NFT required (hold) | 1 NFT held = 1 creation slot |
| Auto-inhabit on create | No | Creator chooses which agent to inhabit |
| Inhabitation | Free (no NFT) | Anyone can claim unclaimed agents |
| Abandonment | Gate NFT burn required | Creates scarcity, funds lineage NFT |
| Stuck inhabitants | Must buy NFT to leave | While supply exists (8,000 total) |
| Abandonment reward | Lineage NFT minted | User gets `{Agent} #{era}` NFT |
| Re-inhabitation | Allowed | Abandoned agents return to pool |
| Ghost users | Ghost icon display | Users without avatar shown as ghost |
| Group chat visibility | All users see shared channel | Community interaction |
| Email tracking | None | Wallet is sole identity |
| Migration | Fresh start | Clean slate, no legacy baggage |

## NFT Token Gating

Leverages existing patterns from `../ratibot` project (Metaplex Core, Irys/Arweave uploads).

### Gate NFT Collection

```
Gate Collection: 8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ
Total Supply: 8,000 NFTs
```

The Gate NFT serves **two purposes**:

| Action | Requirement | NFT State |
|--------|-------------|-----------|
| **Create Agent** | Hold ≥ 1 unused NFT | NFT stays in wallet |
| **Abandon Agent** | Burn 1 NFT | NFT destroyed |

### Token Gating Rules

```
┌─────────────────────────────────────────────────────────────────┐
│  CREATION GATING                                                │
│                                                                 │
│  Can Create = (NFTs Held) > (Agents Created by this wallet)    │
│                                                                 │
│  Example:                                                       │
│  ┌──────────────┬────────────────┬─────────────┐               │
│  │ NFTs Held    │ Agents Created │ Can Create? │               │
│  ├──────────────┼────────────────┼─────────────┤               │
│  │ 3            │ 0              │ Yes (3)     │               │
│  │ 3            │ 2              │ Yes (1)     │               │
│  │ 3            │ 3              │ No          │               │
│  │ 2            │ 3              │ No          │               │
│  │ 0            │ 0              │ No          │               │
│  └──────────────┴────────────────┴─────────────┘               │
│                                                                 │
│  Note: Selling/transferring NFTs reduces your creation slots   │
│  but does NOT affect agents you already created.               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  ABANDONMENT GATING                                             │
│                                                                 │
│  Can Abandon = (NFTs Held) ≥ 1  (will burn 1)                  │
│                                                                 │
│  After burning:                                                 │
│  - NFTs Held decreases by 1                                     │
│  - Creation slots decrease by 1                                 │
│  - User receives Lineage NFT for that agent                    │
│                                                                 │
│  Example:                                                       │
│  User holds 3 NFTs, created 3 agents, inhabiting 1             │
│  → Abandons: burns 1 NFT → now holds 2                         │
│  → Can't create more (created 3 > held 2)                      │
│  → Can still abandon again if inhabits another (holds 2)       │
└─────────────────────────────────────────────────────────────────┘
```

### Creation vs Inhabitation

**Important distinction:**
- **Create** = Spawn a new agent into existence (requires Gate NFT slot)
- **Inhabit** = Claim an existing unclaimed agent (no NFT required)

```
┌─────────────────────────────────────────────────────────────────┐
│  USER ACTIONS                                                   │
│                                                                 │
│  ┌─────────────┐     Gate NFT      ┌─────────────┐             │
│  │   Create    │ ◀── Required ───  │  New Agent  │             │
│  │   Agent     │     (hold slot)   │  (yours)    │             │
│  └─────────────┘                   └─────────────┘             │
│                                                                 │
│  ┌─────────────┐    No NFT needed  ┌─────────────┐             │
│  │   Inhabit   │ ◀── Free ───────  │  Unclaimed  │             │
│  │   Agent     │                   │  Agent      │             │
│  └─────────────┘                   └─────────────┘             │
│                                                                 │
│  ┌─────────────┐     Gate NFT      ┌─────────────┐             │
│  │   Abandon   │ ◀── Burn 1 ─────  │  Lineage    │             │
│  │   Agent     │                   │  NFT (yours)│             │
│  └─────────────┘                   └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### Scenarios

**Scenario 1: Creator Journey (No Auto-Inhabit)**
```
1. Alice holds 3 Gate NFTs, is a ghost (no avatar)
2. Alice creates "Luna" → created=1, held=3 ✓
   └─ Luna is UNCLAIMED (Alice doesn't auto-inhabit)
3. Alice creates "Nova" → created=2, held=3 ✓
   └─ Nova is UNCLAIMED
4. Alice creates "Star" → created=3, held=3 ✓
   └─ Star is UNCLAIMED
5. Alice is still a ghost with 3 unclaimed agents
6. Alice chooses to inhabit Luna → Alice is now Luna
7. Nova and Star remain unclaimed (anyone can inhabit)
```

**Scenario 2: Seller Loses Slots**
```
1. Bob holds 3 Gate NFTs, created 3 agents
2. Bob sells 1 NFT → held=2, created=3
3. Bob cannot create more agents
4. His 3 agents still exist and function normally
5. Anyone can still inhabit his unclaimed agents
```

**Scenario 3: Abandon Flow**
```
1. Carol holds 2 Gate NFTs, created 2 agents (Luna, Nova)
2. Carol inhabits Luna
3. Carol wants to abandon Luna
4. Carol burns 1 Gate NFT → held=1, created=2
5. Carol receives "Luna #1" Lineage NFT
6. Luna returns to unclaimed pool
7. Carol is now a ghost again
8. Carol can inhabit Nova (her other creation) or any unclaimed agent
9. Carol can't create new agents (created=2 > held=1)
```

**Scenario 4: Ghost Can Inhabit**
```
1. Dave holds 0 Gate NFTs (ghost user)
2. Dave cannot create agents
3. Dave CAN inhabit any unclaimed agent (free)
4. Dave inhabits "Luna" (abandoned by Carol)
5. Dave cannot abandon Luna (no NFT to burn)
6. Dave is "stuck" with Luna unless he buys a Gate NFT
```

**Scenario 5: Stuck Inhabitant Resolution**
```
While Gate NFT supply exists (< 8,000 burned):
→ User MUST buy Gate NFT to abandon
→ Creates demand, maintains scarcity

After supply exhausted (8,000 burned):
→ Consider: free abandon (no lineage NFT minted)
→ Or: launch Gate NFT v2 collection
```

### On-Chain Verification

```typescript
// services/gate-nft.ts
import { Connection, PublicKey } from '@solana/web3.js';

const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

interface GateStatus {
  nftsHeld: number;
  agentsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
}

async function getGateStatus(
  wallet: string,
  connection: Connection
): Promise<GateStatus> {
  // 1. Query on-chain: count Gate NFTs held by wallet
  //    Use DAS API (Helius) or getTokenAccountsByOwner + filter by collection
  const nftsHeld = await countGateNftsHeld(wallet, connection);

  // 2. Query DynamoDB: count agents created by this wallet
  const agentsCreated = await countAgentsCreatedBy(wallet);

  const availableSlots = Math.max(0, nftsHeld - agentsCreated);

  return {
    nftsHeld,
    agentsCreated,
    availableSlots,
    canCreate: availableSlots > 0,
    canAbandon: nftsHeld >= 1,
  };
}

async function countGateNftsHeld(
  wallet: string,
  connection: Connection
): Promise<number> {
  // Option 1: DAS API (recommended for Metaplex Core)
  const response = await fetch(HELIUS_RPC, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAssetsByOwner',
      params: {
        ownerAddress: wallet,
        page: 1,
        limit: 1000,
      },
    }),
  });

  const { result } = await response.json();

  // Filter by collection
  return result.items.filter(
    (asset: any) => asset.grouping?.some(
      (g: any) => g.group_key === 'collection' && g.group_value === GATE_COLLECTION
    )
  ).length;
}
```

### Data Model: Track Agent Creator

```typescript
interface AgentRecord {
  // ... existing fields ...

  // Creation tracking
  creatorWallet: string;        // Who created this agent (permanent)
  createdAt: number;

  // Inhabitation (can change)
  inhabitantWallet?: string;
  inhabitedAt?: number;

  // Lineage
  nftCollectionMint?: string;
  currentEra: number;
}
```

**Key insight:** `creatorWallet` is permanent and used for slot accounting. `inhabitantWallet` changes with inhabitation.

### API Updates

```typescript
// POST /agents/create
// Create a new agent (requires Gate NFT slot)
interface CreateAgentRequest {
  name: string;
  // ... other agent config
}

interface CreateAgentResponse {
  success: boolean;
  agent?: AgentRecord;
  error?: 'no_gate_slot' | 'invalid_name' | 'name_taken';
  gateStatus?: GateStatus;  // Updated status after creation
}

// GET /gate/status
// Check user's Gate NFT status
interface GateStatusResponse {
  nftsHeld: number;
  agentsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
}
```

### Abandonment Flow (Updated)

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  User    │     │ Frontend │     │ Backend  │     │ Solana   │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ Click Abandon  │                │                │
     │───────────────▶│                │                │
     │                │                │                │
     │                │ GET /gate/status               │
     │                │───────────────▶│                │
     │                │                │                │
     │                │ Check canAbandon               │
     │                │◀───────────────│                │
     │                │                │                │
     │                │ If canAbandon: │                │
     │                │ Show NFT picker│                │
     │◀───────────────│                │                │
     │                │                │                │
     │  Select NFT    │                │                │
     │  to burn       │                │                │
     │───────────────▶│                │                │
     │                │                │                │
     │                │ Build burn tx  │                │
     │◀───────────────│                │                │
     │                │                │                │
     │  Sign & Send   │                │                │
     │───────────────────────────────────────────────▶│
     │                │                │                │
     │                │ POST /agents/:id/abandon       │
     │                │ { burnTxSig }  │                │
     │                │───────────────▶│                │
     │                │                │                │
     │                │                │ 1. Verify burn│
     │                │                │ 2. Mint lineage
     │                │                │ 3. Clear inhab│
     │                │                │                │
     │                │ { lineageNft, newGateStatus }  │
     │                │◀───────────────│                │
     │                │                │                │
     │  Success!      │                │                │
     │◀───────────────│                │                │
```

### Edge Cases & Security

**Race Conditions:**
```typescript
// Problem: User sells NFT between check and create
// Solution: Re-verify on-chain at creation time

async function createAgent(wallet: string, config: AgentConfig) {
  // 1. Check gate status (optimistic)
  const status = await getGateStatus(wallet);
  if (!status.canCreate) {
    throw new Error('no_gate_slot');
  }

  // 2. Create agent in DynamoDB
  const agent = await createAgentRecord(wallet, config);

  // 3. Re-verify gate status (pessimistic)
  //    If user sold NFT between step 1 and 2, rollback
  const finalStatus = await getGateStatus(wallet);
  if (finalStatus.agentsCreated > finalStatus.nftsHeld) {
    await deleteAgentRecord(agent.id);
    throw new Error('gate_slot_race_condition');
  }

  return agent;
}
```

**Stuck Inhabitants:**
```
User inhabits agent but has 0 Gate NFTs → Cannot abandon

Current policy (while supply exists):
→ User MUST acquire a Gate NFT to abandon
→ This creates demand for Gate NFTs
→ 8,000 total supply means max 8,000 abandonments ever

Future policy (after 8,000 burns):
→ Revisit: free abandon or launch v2 collection
```

**Creator vs Inhabitant Conflicts:**
```
Alice creates "Luna", never inhabits it
Bob (ghost) inhabits Luna
Who controls Luna?
→ Bob (inhabitant) has operational control
→ Alice (creator) just has the creation count against her slots
→ Luna is still an agent Alice "created" for slot purposes
```

**NFT Lending/Borrowing:**
```
If user borrows NFT to create agent, then returns it:
→ They now have created=1, held=0
→ Cannot create more, but agent still exists
→ This is acceptable - agent persists, just no more slots
```

### Caching Strategy

```typescript
// Gate status requires on-chain query - cache briefly
const GATE_STATUS_CACHE_TTL = 30_000; // 30 seconds

// Use cache for UI display, but always verify on mutations
async function getGateStatusCached(wallet: string): Promise<GateStatus> {
  const cached = cache.get(`gate:${wallet}`);
  if (cached && Date.now() - cached.timestamp < GATE_STATUS_CACHE_TTL) {
    return cached.status;
  }

  const status = await getGateStatus(wallet);
  cache.set(`gate:${wallet}`, { status, timestamp: Date.now() });
  return status;
}
```

---

### Avatar Lineage System

Abandoned avatars return to the unclaimed pool. Each avatar builds its own **lineage** - a collection of NFTs representing past inhabitants.

```
Avatar "Luna" Lineage:
┌─────────────────────────────────────────────────────────────┐
│  Luna #1          Luna #2          Luna #3                  │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐             │
│  │  👤 A   │      │  👤 B   │      │  👤 C   │   ...       │
│  │ Era 1   │      │ Era 2   │      │ Era 3   │             │
│  │ 42 days │      │ 18 days │      │ ongoing │             │
│  └─────────┘      └─────────┘      └─────────┘             │
│    Minted           Minted          (current)              │
└─────────────────────────────────────────────────────────────┘
```

**Flow:**
1. Agent "Luna" is created → Metaplex Core collection created for Luna
2. User A inhabits Luna (Luna #1 holder-to-be)
3. User A abandons → Burns gate NFT → Gets **Luna #1** (Era 1)
4. Luna returns to unclaimed pool
5. User B inhabits Luna (Luna #2 holder-to-be)
6. User B abandons → Burns gate NFT → Gets **Luna #2** (Era 2)
7. And so on...

### Per-Agent NFT Collection

Each agent has its own Metaplex Core collection created on first inhabitation:

```typescript
interface AgentRecord {
  // ... existing fields ...

  // NFT Collection for this agent's lineage
  nftCollectionMint?: string;     // Created on first inhabitation
  nftCollectionUri?: string;      // Arweave metadata URI
  currentEra: number;             // Increments on each abandonment (starts at 0)

  // Inhabitation state
  inhabitantWallet?: string;
  inhabitedAt?: number;
}
```

**Collection Creation (on first inhabit):**
```typescript
// services/nft.ts
async function createAgentCollection(agent: AgentRecord): Promise<string> {
  const metadata = {
    name: agent.name,
    symbol: "SWRM",
    description: `Lineage collection for ${agent.name}. Each NFT represents a past inhabitant.`,
    image: agent.profileImageUrl,  // Agent's current profile pic
    external_url: `https://admin.rati.chat/agents/${agent.id}`,
  };

  // Upload metadata to Arweave
  const metadataUri = await uploadToArweave(metadata);

  // Create Metaplex Core collection
  const collectionMint = await createCollection({
    name: agent.name,
    uri: metadataUri,
    royaltyBasisPoints: 500,  // 5% royalties
  });

  return collectionMint;
}
```

### Character NFT (Lineage Token)

When abandoning, mint the next NFT in the agent's collection:

**Metadata Structure:**
```json
{
  "name": "{agentName} #{era}",
  "symbol": "SWRM",
  "description": "Era {era} of {agentName}. Inhabited by {walletShort} for {duration}.",
  "image": "{agentProfileImageAtAbandonmentArweaveUri}",
  "attributes": [
    {"trait_type": "Era", "value": 1},
    {"trait_type": "Genesis", "value": true},
    {"trait_type": "Agent", "value": "Luna"},
    {"trait_type": "Agent ID", "value": "luna-abc123"},
    {"trait_type": "Inhabitant", "value": "ABC...XYZ"},
    {"trait_type": "Duration (days)", "value": 42},
    {"trait_type": "Messages Sent", "value": 1337},
    {"trait_type": "Platforms", "value": "Telegram, Discord"},
    {"trait_type": "Inhabited At", "value": "2024-01-15"},
    {"trait_type": "Abandoned At", "value": "2024-02-26"}
  ],
  "properties": {
    "files": [{"uri": "{imageUri}", "type": "image/png"}],
    "category": "image",
    "creators": [
      {"address": "{platformWallet}", "share": 100}
    ]
  }
}
```

Note: `"Genesis": true` only appears on Era 1 NFTs.

**Era Significance:**
- **Era 1** = First ever inhabitant (OG) - exactly ONE per agent, naturally rare
- **Lower eras** = Earlier adopters
- **Higher eras** = Avatar has been "passed around" more

**Era 1 Treatment (minimal):**
- Add `"Genesis": true` attribute to metadata
- Natural scarcity does the work - no need for special visuals
- Marketplaces will surface rarity via trait filtering

**Image Snapshot:**
- Use agent's profile image at time of abandonment (current state)
- Captures any customizations the inhabitant made during their era

### Abandonment Flow (Updated)

```typescript
// POST /agents/:agentId/abandon
async function abandonAgent(
  agentId: string,
  userWallet: string,
  burnTxSignature: string
): Promise<AbandonResponse> {
  const agent = await getAgent(agentId);

  // 1. Verify user is current inhabitant
  if (agent.inhabitantWallet !== userWallet) {
    throw new Error('not_inhabitant');
  }

  // 2. Verify burn transaction
  const burnValid = await verifyBurn(burnTxSignature, GATE_NFT_MINT, userWallet);
  if (!burnValid) {
    throw new Error('invalid_burn');
  }

  // 3. Calculate inhabitation stats
  const stats = await calculateInhabitationStats(agent, userWallet);

  // 4. Mint lineage NFT to user
  const nextEra = agent.currentEra + 1;
  const nftMint = await mintLineageNft({
    collection: agent.nftCollectionMint,
    era: nextEra,
    agent,
    inhabitant: userWallet,
    stats,
  });

  // 5. Clear inhabitant, increment era
  await updateAgent(agentId, {
    inhabitantWallet: undefined,
    inhabitedAt: undefined,
    currentEra: nextEra,
  });

  // 6. Record abandonment history
  await recordAbandonment({
    agentId,
    wallet: userWallet,
    era: nextEra,
    nftMint,
    stats,
  });

  return {
    success: true,
    characterNftMint: nftMint,
    era: nextEra,
  };
}
```

### Inhabitation Flow (Updated)

```typescript
// POST /agents/:agentId/inhabit
async function inhabitAgent(
  agentId: string,
  userWallet: string
): Promise<InhabitResponse> {
  const agent = await getAgent(agentId);
  const user = await getUser(userWallet);

  // 1. Check agent is unclaimed
  if (agent.inhabitantWallet) {
    throw new Error('already_inhabited');
  }

  // 2. Check user isn't already inhabiting another agent
  if (user.inhabitedAgentId) {
    throw new Error('already_inhabiting');
  }

  // 3. Create NFT collection if this is the agent's first inhabitant
  let collectionMint = agent.nftCollectionMint;
  if (!collectionMint) {
    collectionMint = await createAgentCollection(agent);
    await updateAgent(agentId, {
      nftCollectionMint: collectionMint,
      currentEra: 0,
    });
  }

  // 4. Set inhabitant
  await updateAgent(agentId, {
    inhabitantWallet: userWallet,
    inhabitedAt: Date.now(),
  });

  await updateUser(userWallet, {
    inhabitedAgentId: agentId,
    inhabitedAt: Date.now(),
  });

  return {
    success: true,
    agent,
    era: agent.currentEra + 1,  // They will be this era when they abandon
  };
}
```

### Data Model Updates

```typescript
// Abandonment history record
interface AbandonmentRecord {
  pk: `AGENT#${agentId}`;
  sk: `LINEAGE#${era}`;

  agentId: string;
  era: number;

  // Inhabitant info
  wallet: string;
  inhabitedAt: number;
  abandonedAt: number;
  durationMs: number;

  // Stats during inhabitation
  messagesSent: number;
  platformsUsed: string[];

  // NFT info
  nftMint: string;
  nftMetadataUri: string;

  // Burn info
  burnTxSignature: string;
  burnedNftMint: string;
}
```

### Collection Queries

```typescript
// Get full lineage for an agent
// Query: pk = AGENT#agentId, sk begins_with LINEAGE#
async function getAgentLineage(agentId: string): Promise<AbandonmentRecord[]>;

// Get all NFTs a user has collected
// Requires: GSI on wallet field, or scan user's abandonment history
async function getUserLineageNfts(wallet: string): Promise<AbandonmentRecord[]>;
```

### Gate NFT Versioning

When the current gate collection is depleted, launch a new one:

```yaml
# Config supports multiple gate collections
nft:
  gate_collections:
    - mint: "8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ"
      version: 1
      name: "Swarm Gate v1"
      active: true
    # Future: when v1 depletes
    - mint: "NEW_COLLECTION_MINT_HERE"
      version: 2
      name: "Swarm Gate v2"
      active: false

  royalty_basis_points: 500  # 5%
  platform_wallet: "..."     # Receives royalties
  storage:
    provider: "arweave"
    fallback: "s3"
```

**Burn verification** accepts NFTs from ANY active gate collection:

```typescript
async function verifyBurn(
  txSignature: string,
  userWallet: string
): Promise<{ valid: boolean; gateVersion: number }> {
  const tx = await connection.getTransaction(txSignature);

  // Check if burned NFT belongs to any active gate collection
  for (const gate of config.nft.gate_collections.filter(g => g.active)) {
    if (isFromCollection(tx, gate.mint)) {
      return { valid: true, gateVersion: gate.version };
    }
  }

  return { valid: false, gateVersion: 0 };
}
```

This allows smooth transitions when launching new gate collections without breaking existing holders.

### Burn Verification

Backend verifies the burn transaction on-chain before releasing the agent:

```typescript
// services/nft.ts
async function verifyBurn(
  txSignature: string,
  burnCollectionMint: string,
  userWallet: string
): Promise<{ valid: boolean; burnedAsset?: string }> {
  // 1. Fetch transaction from RPC
  const tx = await connection.getTransaction(txSignature, {
    commitment: 'confirmed',
  });

  // 2. Verify it's a Metaplex Core burn instruction
  // 3. Verify the burned asset is from the correct collection
  // 4. Verify the signer matches userWallet
  // 5. Return the burned asset address for record-keeping
}
```

### Ghost Users

Users who are authenticated but don't inhabit an avatar appear as "ghosts":

```typescript
interface GhostUser {
  walletAddress: string;
  displayName?: string;
  isGhost: true;
  avatar: {
    type: 'ghost';
    icon: '/assets/ghost-icon.svg';  // Or emoji: 👻
  };
}
```

**Ghost behavior in shared chat:**
- Can read all messages
- Can send messages (appear with ghost icon)
- Can see unclaimed agents
- Can inhabit an unclaimed agent
- Cannot access DM channels (no agent to DM)

---

## Current State (Already Implemented)

The codebase already has significant wallet auth infrastructure:

### What EXISTS

**Backend Services:**
- `wallet-auth.ts` - SIWS challenge/verify, session management
- `nft-gate.ts` - Helius DAS API, checks Orb collection (8GCAyy...)
- `agent-ownership.ts` - claimAgent/releaseAgent (1:1 ownership)

**Data Models Already Present:**
```typescript
// UserRecord - EXISTS in wallet-auth.ts
interface UserRecord {
  pk: `USER#${walletAddress}`;
  sk: 'PROFILE';
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAgentId?: string;    // ✓ Already tracking!
  inhabitedAt?: number;
  createdAt: number;
  lastSeenAt: number;
  sessionCount: number;
}

// AgentRecord - EXISTS in types.ts
interface AgentRecord {
  // ... existing fields ...
  ownerWallet?: string;          // ✓ Already tracking!
  ownerClaimedAt?: number;
}

// SessionRecord - EXISTS
// ChallengeRecord - EXISTS
```

**API Endpoints Already Working:**
- `GET /auth/challenge` - Get signing challenge
- `POST /auth/verify` - Verify signature, create session
- `GET /auth/me` - Get current user
- `POST /auth/logout` - End session
- `POST /auth/claim` - Claim agent ownership
- `POST /auth/release` - Release agent ownership

**Frontend Already Has:**
- `WalletProvider.tsx` - Solana wallet adapter (Phantom, Solflare, Coinbase)
- `walletAuth.ts` - Zustand store with login/logout/claim/release
- `WalletLogin` component - Connect button with NFT gate errors
- `UserAvatar` / `GhostAvatar` components

**Dependencies Already Installed:**
- `@solana/web3.js`, `tweetnacl`, `bs58` (backend)
- `@solana/wallet-adapter-*` (frontend)

### What's MISSING (Gaps to Fill)

| Feature | Status | Notes |
|---------|--------|-------|
| `creatorWallet` on agents | ❌ Missing | Need for creation slot tracking |
| Creation gating | ❌ Missing | Check NFT count vs agents created |
| Burn verification | ❌ Missing | Verify burn tx for abandonment |
| Lineage NFT minting | ❌ Missing | Mint character NFT on abandon |
| Per-agent NFT collection | ❌ Missing | Create collection per agent |
| `currentEra` on agents | ❌ Missing | Track abandonment count |
| Ghost user display | ⚠️ Partial | Avatar exists, need chat integration |
| Shared chat channel | ❌ Missing | All users see shared messages |
| DM channels | ❌ Missing | Private inhabitant-agent chat |

### Architecture Diagram (Current + Proposed)

```
┌─────────────────┐                              ┌─────────────────┐
│   Admin UI      │◀─────── HTTP/WS ───────────▶│   Admin API     │
│  (React SPA)    │                              │   (Lambda)      │
│                 │                              │                 │
│  ┌───────────┐  │  ┌────────────────────────┐  │  ┌───────────┐  │
│  │ Phantom   │──┼─▶│  SIWS (✓ EXISTS)       │─▶│  │ Verify    │  │
│  │ Wallet    │  │  │  Challenge/Sign/Verify │  │  │ Signature │  │
│  └───────────┘  │  └────────────────────────┘  │  └───────────┘  │
│                 │                              │        │        │
│  ┌───────────┐  │  ┌────────────────────────┐  │        ▼        │
│  │ NFT Gate  │──┼─▶│  Helius DAS (✓ EXISTS) │─▶│  ┌───────────┐  │
│  │ Check     │  │  │  Count Gate NFTs held  │  │  │ Gate      │  │
│  └───────────┘  │  └────────────────────────┘  │  │ Service   │  │
└─────────────────┘                              │  └───────────┘  │
                                                 │        │        │
         ┌───────────────────────────────────────┼────────┘        │
         │                                       │                 │
         ▼                                       ▼                 │
┌─────────────────┐                    ┌─────────────────┐         │
│   DynamoDB      │                    │  Solana RPC     │         │
│                 │                    │  (Helius)       │         │
│ USER#wallet     │ ✓ EXISTS           │                 │         │
│ SESSION#token   │ ✓ EXISTS           │ - NFT counts    │         │
│ AGENT#id        │ ✓ EXISTS           │ - Burn verify   │ ❌ NEW  │
│ OWNER#wallet    │ ✓ EXISTS           │ - Mint lineage  │ ❌ NEW  │
│ LINEAGE#era     │ ❌ NEW             │                 │         │
│ DM#wallet#agent │ ❌ NEW             └─────────────────┘         │
└─────────────────┘                                                │
                                                                   │
                              ┌─────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Arweave/Irys   │ ❌ NEW
                    │  (NFT metadata) │
                    └─────────────────┘
```

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

  // Ghost state: user has no inhabited agent
  // When inhabitedAgentId is undefined, user appears as ghost
  inhabitedAgentId?: string;    // Agent they're "being" (null = ghost)
  inhabitedAt?: number;         // When they started inhabiting

  // Derived display properties
  // avatarUrl: if ghost → ghost icon, else → agent's profile image
  // displayAs: if ghost → wallet address or displayName, else → agent name

  // Abandonment history
  abandonedAgents?: {
    agentId: string;
    abandonedAt: number;
    characterNftMint: string;   // NFT minted on abandonment
  }[];

  // Metadata
  createdAt: number;
  lastSeenAt: number;
  sessionCount: number;
}

// Helper type for display
type UserDisplay = {
  walletAddress: string;
  isGhost: boolean;
  displayName: string;          // Agent name or wallet/displayName
  avatarUrl: string;            // Agent avatar or ghost icon
};
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

### Phase 1: Core Auth ✅ COMPLETE
- [x] Add `@solana/web3.js`, `tweetnacl`, `bs58` dependencies
- [x] Create `/auth/challenge` endpoint
- [x] Create `/auth/verify` endpoint with signature verification
- [x] Create session management service (DynamoDB-backed)
- [x] Create `WalletLogin` component with Phantom adapter
- [x] NFT gate checking (Helius DAS API)

### Phase 2: User & Ownership ✅ MOSTLY COMPLETE
- [x] Create user record on first sign-in
- [x] Add `/auth/me` endpoint
- [x] Add `/auth/claim` and `/auth/release` endpoints
- [x] `ownerWallet` field on agents
- [x] `inhabitedAgentId` on user records
- [ ] Ghost user display in chat (partial - avatar exists)

### Phase 3: Creation Gating ❌ NEW
- [ ] Add `creatorWallet` field to agent records
- [ ] Modify agent creation to check Gate NFT slots
- [ ] `countAgentsCreatedBy(wallet)` query
- [ ] Update `/agents/create` to enforce gating
- [ ] Show available slots in UI

### Phase 4: Inhabitation Flow ⚠️ NEEDS UPDATE
- [ ] Rename `ownerWallet` → `inhabitantWallet` for clarity
- [ ] Create `/agents/unclaimed` endpoint
- [ ] Update claim to work without NFT (inhabit is free)
- [ ] `AvatarSelector` component showing unclaimed agents
- [ ] Enforce: user can only inhabit ONE agent

### Phase 5: NFT Burn & Lineage ❌ NEW
- [ ] Port NFT scripts from ratibot
- [ ] Create per-agent NFT collection on first inhabit
- [ ] Add `nftCollectionMint`, `currentEra` to agent records
- [ ] Implement burn verification (`verifyBurn` service)
- [ ] Implement lineage NFT minting on abandonment
- [ ] Store `LINEAGE#era` records in DynamoDB
- [ ] Update `/auth/release` to require burn + mint lineage

### Phase 6: Shared Chat & Ghost ❌ NEW
- [ ] Create shared chat channel (all users see)
- [ ] Display user avatars (agent image or ghost icon)
- [ ] Show wallet address or display name
- [ ] Differentiate messages by inhabited avatar vs ghost
- [ ] Ghost permissions (can chat, can't DM)

### Phase 7: DM Channels ❌ NEW (DEFERRED)
- [ ] Create DM channel service
- [ ] Add DM endpoints (inhabitant-only)
- [ ] `DMSidebar` component
- [ ] `DMChat` component
- [ ] Real-time updates for DMs

---

## Dependencies

### Frontend (admin-ui)

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

### Backend (admin-api)

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.87.0",
    "tweetnacl": "^1.0.3",
    "bs58": "^5.0.0"
  }
}
```

### NFT Scripts (from ratibot)

```json
{
  "dependencies": {
    "@metaplex-foundation/mpl-core": "^1.0.0",
    "@metaplex-foundation/umi": "^0.9.0",
    "@metaplex-foundation/umi-bundle-defaults": "^0.9.0",
    "@irys/upload": "^0.0.7",
    "@irys/upload-solana": "^0.1.0"
  }
}
```

---

## Resolved Decisions

1. **Agent Ownership Model** - RESOLVED
   - 1:1 model: One wallet per agent (owner = inhabitant)
   - First-come-first-served claiming of unclaimed agents
   - No transfers - must abandon (burn NFT) and new user can claim

2. **Group Chat vs DM** - RESOLVED
   - Shared channel visible to ALL authenticated users
   - DM channels are private between inhabitant and their agent
   - Ghost users can participate in shared chat but not DMs

3. **Backwards Compatibility** - RESOLVED
   - Fresh start - no migration from Cloudflare Access
   - All agents start as unclaimed

4. **Admin Access** - TBD
   - Options: Keep Cloudflare Access for admin, or designate admin wallets
   - Can decide during implementation

## Resolved Questions

1. **Gate NFT Supply Depletion** - RESOLVED
   - Launch new gate collection (v2, v3, etc.)
   - Backend accepts burns from any active gate collection
   - Config supports multiple gate collections

2. **Era 1 Rarity** - RESOLVED
   - Natural scarcity (exactly 1 per agent)
   - Add `"Genesis": true` attribute for marketplace filtering
   - No special visuals needed

3. **Profile Image on NFT** - RESOLVED
   - Use abandon snapshot (current image at time of abandonment)
   - Captures customizations made during that era

## Resolved Questions (Latest)

4. **Gate NFT Supply** - RESOLVED
   - 8,000 NFTs in collection
   - Max 8,000 abandonments possible (until v2)

5. **Stuck Inhabitants** - RESOLVED
   - Must buy Gate NFT to abandon (while supply exists)
   - Creates demand, maintains scarcity
   - Revisit after 8,000 burns

6. **Auto-Inhabit on Create** - RESOLVED
   - NO auto-inhabit
   - Creator can choose which of their creations to inhabit
   - Created agents start unclaimed

## Resolved Questions (Final)

7. **Creator Reclaim Rights** - RESOLVED
   - No - creator cannot reclaim from inhabitant
   - Inhabitant has full control until they abandon

8. **Agent Deletion** - RESOLVED
   - Agents are permanent, no deletion
   - Once created, agent exists forever

9. **Lineage Display** - DEFERRED
   - For later implementation
   - Hall of fame, explorer links, etc.

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
