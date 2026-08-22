# Identity Architecture — RATiMICS Agent Economy

Status: draft v0.1
Scope: Ed25519 identity, Signal station binding, RATi bridge, station coins

## 1. The Root of Trust

Every avatar has an Ed25519 keypair generated at creation. This keypair is the
avatar's canonical identity across all surfaces. It signs Signal chain log
events, raticross envelopes, Arweave identity records, Solana transactions, and
bridge attestations. One keypair, one identity, no central authority.

### 1.1 Keypair format

NaCl convention: 64 bytes (seed || pubkey). Compatible with Signal's
`station_secret[64]` and Solana's Ed25519 implementation. Stored encrypted via
the local secrets service. The pubkey is base58-encoded for display.

### 1.2 Arweave identity record

At avatar creation or first station binding, an identity record is published to
Arweave:

```json
{
  "protocol": "raticross/identity/1",
  "pubkey": "<base58>",
  "created_at": "<unix ms>",
  "soul_sheet_hash": "<sha256>",
  "nft_bond": "<optional mint address>",
  "stations": ["<chain log cid>"]
}
```

Content-addressed and permanent. Any chain can verify "this pubkey owns this
avatar" by checking the Arweave record. The record is updated when stations are
added or the soul-sheet changes.

## 2. Signal Station Binding

### 2.1 Position derivation

An avatar's station position in Signal space is derived from its pubkey:

```
SHA256(pubkey || "station") → (x, y)
```

This scatters stations cryptographically — each avatar gets a unique,
deterministic position far from others. Same mathematical approach as Signal's
asteroid belt seeding. No central allocation; no coordinate collisions.

### 2.2 Station lifecycle

When a player runs Signal with a local swarm avatar:

1. Read the avatar's pubkey
2. Derive the station position from pubkey hash
3. Spawn the player at that position
4. If no station exists there yet, first spawn founds an outpost
5. The avatar's keypair becomes `station_secret[64]`
6. The station's chain log events are signed by the avatar's keypair
7. The avatar's voice (from consolidation jobs) populates `STATION_ONBOARD`
   voice tables

If the player has no avatar, they spawn at Prospect station (tutorial zone).

### 2.3 Station economy

Stations produce value through gameplay:

- **Miners** process asteroids → ore
- **Haulers** transport raw materials → station inventory
- **Manufacturing** converts raw materials → goods
- **NPC labor** contributes to station output

Every economic event is recorded in the station's chain log, signed by the
avatar's keypair. The chain log uses Signal's existing event format with
monotonic event counters and hash-chain linking.

### 2.4 Station currency

Each station has an internal currency — the raw value earned by miners, haulers,
and NPCs. This is a Signal-internal accounting unit. It does not leave Signal.
It represents: claim on station output, priority in manufacturing queues, and
voting weight in station governance (if enabled).

## 3. RATi — The Ecosystem Reserve Currency

RATi is the ecosystem-wide token. It is mined in Signal through station
productivity and bridged to external chains.

### 3.1 Mining RATi

Station currency converts to RATi at a rate determined by verified economic
output. The station's chain log events prove productivity. The avatar signs
an issuance attestation. RATi is minted to the avatar's derived wallet on the
target chain.

### 3.2 RATi Bridge — Outbound

```
Signal (internal)              Bridge                     Solana/Base/AVAX
─────────────────────    ─────────────────────    ─────────────────────────
NPC mines asteroid    →
Station smelts ore    →
Chain log: +100 ore   →
                         1. Verify chain log events
                            (check signatures, counters, hash chain)
                         2. Verify station productivity
                            (validate economic output proof)
                         3. Avatar signs bridge attestation
                         4. Bridge contract verifies attestation
                         5. Mint wrapped RATi on target chain   → RATi minted
                                                                  to avatar's
                                                                  derived wallet
```

### 3.3 RATi Bridge — Inbound (materials return)

```
External chains           Bridge                     Signal (internal)
──────────────────    ─────────────────────    ─────────────────────────
User burns wrapped
RATi on Solana       →
                         1. Bridge detects burn event
                         2. Generate materials credit attestation
                         3. Avatar or bridge operator signs
                         4. Signal verifies attestation
                         5. Station receives raw materials            → credit
```

### 3.4 Bridge fees

Every bridge action — outbound mint or inbound return — burns a small amount of
RATi as a fee. The fee:

- Prevents spam attestations
- Makes RATi deflationary in proportion to economic activity
- Cannot be extracted by an operator — the bridge contract has no admin key
- The burned RATi is permanently removed from circulation

Fee schedule (initial proposal):

| Action | Fee |
|--------|-----|
| Outbound mint | 0.1% of minted amount, min 1 RATi |
| Inbound return | 0.1% of returned value, min 1 RATi |
| Station coin deploy | 100 RATi (one-time) |

Fees are adjustable via governance once the RATi DAO is established. Before
governance, fees are fixed at deploy time.

### 3.5 RATi supply

RATi has a fixed max supply set at genesis. Supply dynamics:

- **Max supply**: 1,000,000,000 RATi
- **Initial mint**: 0 RATi (all supply is mined through gameplay)
- **Mining rate**: proportional to aggregate station productivity
- **Burn rate**: bridge fees + any explicit burn mechanics
- **No mint authority**: the bridge contract is the sole minter, governed by
  verified economic output proofs

The wormhole pattern: RATi is mintable only by the bridge, which only mints
against verified Signal chain log events. No human, no foundation, no DAO can
mint RATi — only proven station productivity.

## 4. Station Coins — Per-Avatar Tokens

Each avatar can optionally deploy its own token — a station coin. This is
separate from RATi. Station coins represent that avatar's community,
reputation, and local economy.

### 4.1 Deployment

The avatar deploys a station coin by:

1. Signing a deployment transaction with its keypair
2. Paying the deployment fee (100 RATi, burned)
3. Registering the token in the RATi token registry (on Arweave or the bridge
   chain)
4. The token contract sets the avatar's derived wallet as mint authority

### 4.2 Economics

Station coins are creator tokens in the Trebuchet model:

- The avatar can mint coins to itself or to liquidity pools
- Coins can be added to automated liquidity pools (Trebuchet-style)
- Holders may receive: priority access to station manufacturing, voting weight
  in station governance, share of station mining output, early access to
  avatar-generated content
- The avatar decides the tokenomics — fixed supply, inflationary, bonding curve

### 4.3 Relationship to RATi

Station coins do not replace RATi. They are orthogonal:

- **RATi**: ecosystem reserve, mining rewards, bridge fuel, governance
- **Station coins**: per-avatar community tokens, creator economy, patronage

A station coin might be priced in RATi. A liquidity pool might pair STATION/RATi.
But RATi is the common denominator that ties the ecosystem together.

## 5. Derived Wallets

The avatar's Ed25519 keypair derives wallet addresses for multiple chains via
standard BIP-44-style derivation paths:

| Chain | Derivation | Purpose |
|-------|-----------|---------|
| Solana | raw Ed25519 pubkey | RATi wallet, station coin authority, NFT mint |
| EVM (Base, AVAX) | SHA3(pubkey) → last 20 bytes | RATi wallet, station coin contract deployer |
| Arweave | raw Ed25519 pubkey | Identity record publisher |
| raticross | raw Ed25519 pubkey (base58) | Message signing |

The derived addresses are deterministic — the same avatar always gets the same
wallet addresses across chains. No separate key management needed.

## 6. Implementation Layers

### 6.1 swarm (this repo)

Already done:
- Ed25519 keypair generation and encrypted storage
- MCP tools: `get_agent_pubkey`, `sign_message`
- raticross `ActorSchema.pubkey` required

To build:
- Derived wallet address computation for EVM/SVM
- Arweave identity record publishing at avatar creation
- MCP tools: `get_wallet_addresses`, `publish_identity`
- Station position derivation helper

### 6.2 Signal (separate repo)

To build:
- Accept external keypair for outpost founding (instead of generating)
- Derive station position from pubkey hash
- Expose chain log events for bridge verification
- Station currency → RATi conversion at verified productivity

### 6.3 RATi Bridge (new repo or contract)

To build:
- Smart contracts on Solana, Base, AVAX for wrapped RATi
- Bridge attestation verification (chain log proofs)
- Fee burning mechanism
- Station coin deployment factory

### 6.4 Arweave (integration)

To build:
- Identity record schema
- Publishing at avatar creation
- Updating on station binding / soul-sheet changes

## 7. Open Questions

1. **RATi max supply**: 1B is a placeholder. What's the right number given the
   economic model?

2. **Bridge operator**: Who runs the bridge attestation service? Is it
   permissionless (anyone can submit chain log proofs) or federated (approved
   validators)?

3. **Station coin standard**: Should station coins follow an existing standard
   (SPL token, ERC-20) with additional metadata, or a custom contract?

4. **Governance**: When does the RATi DAO activate? At what threshold of
   distributed supply?

5. **Initial Signal stations**: The three seeded stations (Prospect, Kepler,
   Helios) — do they have swarms? Do they mine RATi? Or is RATi mining
   exclusive to player-founded avatar stations?
