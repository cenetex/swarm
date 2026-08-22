# RATiMICS Agent Economy — Roadmap

Status: draft v0.1

## Roadmap Rule

Phases advance by proof gates, not by calendar. No phase is complete until its
exit evidence is recorded. If a later phase uncovers drift, return to the last
phase whose evidence still holds.

## Phase 0 — Identity Foundation (current)

**Goal**: Every avatar has a cryptographic identity that works across chains.

Already shipped:
- [x] Ed25519 keypair generation at avatar creation
- [x] Encrypted seed storage via secrets service
- [x] MCP tools: `get_agent_pubkey`, `get_agent_pubkey_hex`, `sign_message`
- [x] raticross `ActorSchema.pubkey` required
- [x] Architecture spec written

Remaining in Phase 0:

- [ ] **Derived wallet addresses** — compute EVM and SVM addresses from the
  Ed25519 keypair. EVM: `keccak256(pubkey) → last 20 bytes`. Solana: raw
  pubkey is already a valid Solana address. Add `get_wallet_addresses` MCP
  tool returning both addresses.

- [ ] **Arweave identity record** — publish a content-addressed identity record
  to Arweave at avatar creation. Schema: `{ protocol, pubkey, created_at,
  soul_sheet_hash }`. Add `publish_identity` MCP tool.

- [ ] **Identity record update** — when the soul-sheet changes or a station is
  bound, publish an updated record referencing the previous one. Forms a
  verifiable identity lineage.

Exit evidence:
- `get_wallet_addresses` returns deterministic addresses for a given keypair
- Identity record published to Arweave testnet
- Identity record update produces a valid lineage chain
- All existing tests pass

---

## Phase 1 — Signal Station Binding

**Goal**: An avatar's keypair becomes a Signal station. The avatar spawns at
its derived position. The station signs chain log events.

### 1.1 swarm side

- [ ] **Station position derivation** — export a function that derives (x, y)
  coordinates from pubkey: `SHA256(pubkey || "station") → (x, y)`. Expose as
  `get_station_position` MCP tool.

- [ ] **Keypair export** — expose the raw keypair bytes in NaCl format for
  Signal to consume. The export pathway must go through the secrets service
  (decrypt → export → wipe from memory after use).

- [ ] **Voice export** — convert the avatar's consolidation output into
  `STATION_ONBOARD` voice table format. The LLM-authored voice is distilled
  into a C-compatible table indexed by station milestones.

### 1.2 Signal side (signal repo)

- [ ] **External keypair acceptance** — station creation (`outpost_founding`)
  accepts an existing keypair instead of generating one.

- [ ] **Pubkey-based position derivation** — station `ring_slot` placement uses
  the SHA256 derivation instead of random assignment.

- [ ] **Avatar voice import** — load voice tables from swarm export format
  into `STATION_ONBOARD` and `NPC_CHATTER` tables.

- [ ] **Chain log signing** — station events are signed with the avatar's
  keypair. Verification uses `station_pubkey`.

### 1.3 Integration test

- [ ] Create an avatar in swarm, derive its station position, spawn a
  Signal station at that position, verify the station uses the avatar's pubkey
  and voice tables, mine an asteroid, verify the chain log event is signed.

Exit evidence:
- Full integration test passes
- Station voice matches avatar soul-sheet
- Chain log events are verifiably signed
- Station position is deterministic from pubkey

---

## Phase 2 — RATi Token & Mining

**Goal**: RATi exists as a token. Stations mine RATi proportional to economic
output. Chain log proofs are verifiable.

### 2.1 Token contracts

- [ ] **RATi SPL token** — Solana SPL token with fixed max supply, no mint
  authority at deploy. Mint authority held by a PDA that only accepts bridge
  attestations.

- [ ] **RATi ERC-20** — matching ERC-20 on Base (and optionally AVAX) with the
  same supply semantics. Bridge contract is sole minter.

### 2.2 Station mining (Signal side)

- [ ] **Productivity measurement** — aggregate station economic output over
  epochs (e.g., 24h windows). Output metric: ore smelted + goods manufactured +
  NPC labor value.

- [ ] **RATi issuance attestation** — the avatar signs an attestation declaring
  "this station produced X value in epoch N." The attestation includes: station
  pubkey, epoch number, productivity metric, chain log event range.

- [ ] **Chain log export** — export chain log events in a bridge-verifiable
  format. Each event carries the station's signature and hash-chain link.

### 2.3 Bridge attestation service (new service)

- [ ] **Attestation submission** — accepts productivity attestations signed by
  station keypairs, verifies chain log proofs, submits to bridge contract.

- [ ] **Fraud detection** — cross-checks attestations against Arweave chain log
  snapshots. Conflicting attestations are flagged and rejected.

Exit evidence:
- RATi token deployed on Solana devnet with PDA mint authority
- Station mines RATi proportional to measured productivity
- Bridge attestation passes verification

---

## Phase 3 — RATi Cross-Chain Bridge

**Goal**: RATi moves between Signal, Solana, and Base. Bridge fees burn RATi.

### 3.1 Bridge contracts

- [ ] **Solana bridge program** — PDA that verifies bridge attestations and
  mints wrapped RATi. Fee burning on every mint/burn.

- [ ] **Base bridge contract** — EVM contract with the same semantics. Uses
  ECDSA recovery from the avatar's derived EVM address for signature
  verification.

### 3.2 Bridge operation

- [ ] **Outbound flow** — station productivity → RATi attestation → bridge
  verification → mint wrapped RATi on target chain → fee burned

- [ ] **Inbound flow** — burn wrapped RATi on target chain → bridge detects
  burn → signal receives materials credit → fee burned

### 3.3 Arweave audit layer

- [ ] **Chain log snapshot** — periodic Arweave upload of station chain logs
  for permanent auditability.

- [ ] **Bridge proof archive** — every bridge attestation and corresponding
  chain log proof range is archived to Arweave.

Exit evidence:
- RATi bridged from Signal to Solana devnet and back
- Bridge fees burned, supply decreases
- Arweave archive contains verifiable chain log snapshots

---

## Phase 4 — Station Coins & Liquidity

**Goal**: Avatars can deploy their own tokens. Trebuchet-style liquidity pools.

### 4.1 Station coin factory

- [ ] **Deployment contract** — factory that deploys SPL tokens or ERC-20s with
  the avatar's derived wallet as mint authority.

- [ ] **Registry entry** — each station coin is registered in the RATi token
  registry with: token address, avatar pubkey, station position, deployment
  proof.

- [ ] **Deployment fee** — 100 RATi burned to deploy a station coin.

### 4.2 Liquidity pools

- [ ] **Trebuchet integration** — station coins can be added to automated
  liquidity pools. The Trebuchet LP math (constant product, fee tiers) is
  reused.

- [ ] **RATi pairing** — the canonical pair is STATION/RATi. This creates a
  universal pricing mechanism: every station coin is priced in the ecosystem
  reserve currency.

Exit evidence:
- Avatar deploys station coin on devnet
- Station coin added to LP with RATi pairing
- Token registered in on-chain registry

---

## Phase 5 — Governance

**Goal**: RATi holders govern the ecosystem. Bridge parameters, fee schedules,
and treasury allocation are subject to DAO vote.

This phase is intentionally unspecified. Governance should activate after the
economic primitives are stable. Premature governance is a rug vector.

---

## Dependency Graph

```
Phase 0 (Identity) ─────────────────────────────────────────────┐
    │                                                            │
    ├── Phase 1 (Signal binding) ──┐                             │
    │       │                       │                             │
    │       └── Phase 2 (RATi) ────┤                             │
    │               │               │                             │
    │               └── Phase 3 ────┤                             │
    │                       │       │                             │
    │                       └── Phase 4 ──┐                       │
    │                               │     │                       │
    └───────────────────────────────┴─────┴── Phase 5 (Governance)
```

Phase 0 and Phase 1 are parallelizable (different repos, different teams).
Phase 2 depends on Phase 1 (need chain log exports). Phase 3 depends on
Phase 2 (need RATi token). Phase 4 depends on Phase 3 (need bridge for
liquidity). Phase 5 is gated on everything.

## Repo Boundaries

| Repo | Owns |
|------|------|
| swarm | Keypair, identity tools, wallet derivation, Arweave publishing, voice export |
| signal | Station binding, position derivation, chain log, station economy, voice import |
| rati | Token registry, NFT families, burn-to-mint specs, asset design |
| rati-bridge (new) | Bridge contracts, attestation service, fraud detection |
| trebuchet | Key generation (vanity), LP math, token services (reused by station coins) |

## Risk Register

| Risk | Mitigation |
|------|-----------|
| Bridge attestation fraud | Arweave chain log snapshots enable independent verification. Cross-check attestations against public data. |
| Keypair export vulnerability | Export pathway uses secrets service. Key is decrypted, exported, wiped from memory. Never persisted to disk outside encrypted store. |
| Station position collision | SHA256 over pubkey makes collisions cryptographically impossible. Minimum spacing enforced by Signal world geometry. |
| RATi supply centralization | No admin key on bridge contract. Only station productivity proofs can mint. Arweave audit trail is public. |
| Governance capture | Phase 5 deferred until economic primitives are stable. Bridge parameters are fixed at deploy. |
