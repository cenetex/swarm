# Avatar Memory System - Research, Current State, and Roadmap

**Last reviewed:** 2026-01-25

This document describes the memory system architecture for AWS Swarm avatars, synthesizing learnings from prior experiments (cosyworld, kyro, mirquo) and outlining a roadmap for dynamic personality evolution.

## Problem Statement

Avatars need persistent memory to:
1. **Remember users** - Preferences, past interactions, relationship context
2. **Learn from experience** - Recognize patterns, update behavior
3. **Evolve personality** - Grow and adapt based on interactions
4. **Maintain identity** - Consistent sense of self across conversations

Without memory, every conversation starts from zero. The avatar has no history, no growth, no relationships.

## Research Summary

### Cosyworld Approach
- **Storage**: MongoDB with vector embeddings
- **Key Innovation**: Weight-based memory with decay
  - New memories: weight = 1.0
  - Reinforced on recall: weight += 0.1
  - Weekly decay: weight *= 0.95
  - Pruned when: weight < threshold
- **Retrieval**: Hybrid scoring
  ```
  score = (0.55 × semantic_similarity) +
          (0.25 × recency) +
          (0.15 × weight) +
          (0.05 × entity_bonus)
  ```
- **Evolution**: Knowledge graph extraction from reflections
- **Consolidation**: Nightly summarization of low-weight memories

### Kyro Approach
- **Storage**: DynamoDB (channel-state table)
- **Key Innovation**: Perspective-based summaries
  - Summaries written from avatar's POV ("I observed...", "I talked to...")
  - Compaction: 30+ messages → 2-4 sentence summary
- **Learning**: Exponential cooldown for user management
  - Base: 5 minutes
  - Escalation: 5 → 15 → 45 → 135 minutes
  - Forgiveness: Responding clears cooldown
- **Cross-Platform**: Summaries shared between Discord/Telegram

### Mirquo Approach
- **Storage**: 3-tier cognitive model
  ```
  IMMEDIATE → Last 10 (full detail)
  RECENT    → Last 50 (summaries + themes)
  CORE      → Permanent (identity, learnings, patterns)
  ```
- **Key Innovation**: Identity evolution statements
  - After consolidation: "I am becoming more thoughtful..."
  - Max 10 words, stored as core identity
  - Tracked over time for personality drift
- **Attention**: Semantic interest space via embeddings
  - Builds centroid of all memory embeddings
  - Scores new content: relevance + novelty
  - High scores = avatar is curious

## Current Implementation (Phase 1)

Implementation lives primarily in:
- `packages/admin-api/src/services/memory.ts` (storage, consolidation helpers, recall scoring)
- `packages/admin-api/src/services/embedding.ts` (Bedrock/OpenRouter embeddings)
- `packages/mcp-server/src/tools/memory.ts` (tool interface)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DynamoDB                                │
│  pk: MEMORY#{avatarId}                                       │
│  sk: {tier}#{timestamp}#{id}                                │
├─────────────────────────────────────────────────────────────┤
│  IMMEDIATE     │  RECENT        │  CORE                     │
│  (max 10)      │  (max 50)      │  (max 100)                │
│  Full detail   │  Summarized    │  Permanent                │
│  Auto-promotes │  Tagged themes │  Identity/Learning        │
└─────────────────────────────────────────────────────────────┘
```

### Memory Schema

```typescript
interface AgentMemory {
  pk: string;              // MEMORY#{avatarId}
  sk: string;              // {tier}#{timestamp}#{id}
  id: string;
  avatarId: string;
  tier: 'immediate' | 'recent' | 'core';
  type: 'event' | 'fact' | 'learning' | 'pattern' | 'identity' | 'relationship' | 'preference';
  content: string;
  about?: string;          // Who/what this is about
  userId?: string;
  themes?: string[];       // Tags for retrieval
  strength: number;        // 0-1, reinforcement score
  embedding?: number[];    // For semantic search (future)
  createdAt: number;
  updatedAt: number;
}
```

### Current Tools

| Tool | Purpose |
|------|---------|
| `remember` | Save a fact (creates immediate memory; attempts to generate an embedding when available) |
| `recall` | Search memories (semantic/hybrid scoring when embeddings are available; falls back to keyword search) |

### Prompt Injection

When memory is enabled, avatar system prompts include:
```
## Who I Am
- I am becoming more playful and curious

## What I've Learned
- Users prefer concise responses
- Questions about hunting are common

## Recent Experiences
- Had a conversation about speed with @cheetahfan
- Generated an image of savanna at sunset
```

## Roadmap

> **Integration Note**: Phases 2-4 are prerequisites for [DYNAMIC-CONTEXT-RFC.md](./DYNAMIC-CONTEXT-RFC.md).
> Complete these before implementing channel summaries, pinned memories, or contextual retrieval.

### Phase 2: Wire up scheduled consolidation (1 week)

**Goal**: Automatic memory management via scheduled jobs (EventBridge → Lambda) using the consolidation helpers already present in the memory service.

**Implementation**:
1. **EventBridge Rule**: Trigger nightly at 3 AM UTC
2. **Lambda Handler**: `consolidate-memories`
3. **Per-Avatar Process**:
   ```
   1. Promote old immediate → recent (summarize if needed)
   2. Apply decay: strength *= 0.95
   3. Prune weak memories: strength < 0.1
   4. Extract patterns from recent memories
   5. Generate identity evolution statement
   ```

**Notes**:
- The memory service already contains consolidation primitives (decay, promotion, identity snapshots). The remaining work is orchestration + scheduling + operational controls.

**New Infrastructure**:
- `packages/infra/src/constructs/memory-consolidation.ts`
- EventBridge schedule + Lambda + DynamoDB access

### Phase 3: Identity Evolution (1-2 weeks)

**Goal**: Avatars generate "I am becoming..." statements

**Implementation**:
1. After consolidation, if 5+ recent memories exist:
2. Call LLM with recent memories as context
3. Prompt: "Based on recent experiences, complete: 'I am becoming...'"
4. Constraint: Max 30 tokens (~10 words)
5. Store as core identity memory

**Tracking Evolution**:
```typescript
interface AgentIdentitySnapshot {
  pk: string;              // IDENTITY#{avatarId}
  sk: string;              // SNAPSHOT#{timestamp}
  statement: string;       // "I am becoming more curious about users"
  previousStatement?: string;
  triggeringMemories: string[];
  createdAt: number;
}
```

**UI Component**: Identity timeline showing personality drift over time

### Phase 4: Semantic search hardening (1–2 weeks)

**Goal**: Make meaning-based retrieval reliable and operationally safe.

**Current behavior (implemented)**:
- Embeddings are generated on write when available (Bedrock primary; OpenRouter fallback).
- Recall uses cosine similarity + hybrid scoring when it has embeddings, otherwise falls back to keyword search.

**Hardening work**:
- Add an operational backfill path for older memories without embeddings.
- Add metrics/logging around embedding coverage and latency.

**Optimization**:
- Cache embeddings in separate table for faster queries
- Build centroid of all embeddings for "interest space"
- Score novelty: how different is this from what avatar knows?

### Phase 4.5: Pinned Memories (from DYNAMIC-CONTEXT-RFC)

**Goal**: Avatar self-curates important facts that bypass decay.

This phase is defined in [DYNAMIC-CONTEXT-RFC.md](./DYNAMIC-CONTEXT-RFC.md) but fits here in the memory roadmap:
- Add `pinned` boolean to memory schema
- Pinned memories always included in prompt (max 10)
- Avatar controls via `pin_memory` / `unpin_memory` tools
- Respects retention policies from M1 P1.3

### Phase 5: Relationship Tracking (2-3 weeks)

**Goal**: Avatars remember specific users across interactions

**Schema**:
```typescript
interface AgentRelationship {
  pk: string;              // RELATIONSHIP#{avatarId}
  sk: string;              // USER#{platform}#{userId}
  avatarId: string;
  userId: string;
  platform: string;
  username?: string;

  // Sentiment tracking
  sentimentScore: number;  // -1 to 1
  sentimentHistory: Array<{ score: number; timestamp: number }>;

  // Interaction stats
  interactionCount: number;
  firstInteraction: number;
  lastInteraction: number;

  // Key memories about this user
  keyMemories: Array<{
    memoryId: string;
    summary: string;
    importance: number;
  }>;

  // LLM-generated relationship summary
  summary?: string;
  lastSummaryUpdate?: number;
}
```

**Features**:
- Auto-create relationship on first interaction
- Update sentiment based on conversation tone
- Regenerate summary weekly or after significant interactions
- Surface relationship context in prompts

### Phase 6: Learning Extraction (3 weeks)

**Goal**: Avatars automatically extract learnings from experiences

**Pattern Detection**:
1. Cluster recent memories by theme
2. Identify recurring patterns (e.g., "users often ask about X")
3. Generate learning statement via LLM
4. Store as core memory with type='learning'

**Knowledge Graph** (from cosyworld):
```typescript
interface KnowledgeTriple {
  pk: string;              // KNOWLEDGE#{avatarId}
  sk: string;              // TRIPLE#{timestamp}#{id}
  avatarId: string;
  subject: string;         // The avatar or entity
  relation: string;        // 'knows', 'prefers', 'avoids'
  object: string;          // The fact
  confidence: number;      // How sure (0-1)
  sources: string[];       // Memory IDs that support this
}
```

**Example Extractions**:
- `(avatar, knows, "cheetahs can run 70mph")`
- `(avatar, prefers, "short responses")`
- `(@user123, likes, "hunting metaphors")`

### Phase 7: Behavioral Adaptation (4 weeks)

**Goal**: Avatar behavior changes based on learned patterns

**Adaptation Types**:
1. **Response Style**: Adjust length, formality, emoji usage
2. **Topic Weighting**: Prioritize topics users engage with
3. **Timing**: Learn optimal response delays
4. **Tool Usage**: Prefer tools that succeed

**Feedback Loop**:
```
User Interaction → Memory Created → Pattern Detected →
Learning Extracted → Behavior Adjusted → Better Interactions
```

**Guardrails**:
- Core personality immutable (from persona.md)
- Adaptations are additive, not replacements
- Admin can reset adaptations
- Log all behavioral changes for audit

## Configuration

### Enable Memory for an Avatar

```typescript
// Via admin chat:
"Enable memory for this avatar"

// Via API:
await updateAgent(avatarId, {
  mcpConfig: {
    enabledToolsets: ['memory', ...existing],
    externalServers: []
  }
}, session);
```

### Memory Limits

```typescript
const DEFAULT_CONFIG = {
  immediateMaxCount: 10,      // Full-detail memories
  recentMaxCount: 50,         // Summarized memories
  coreMaxCount: 100,          // Permanent memories
  decayRate: 0.95,            // Per consolidation cycle
  decayIntervalHours: 24,     // How often to decay
  pruneThreshold: 0.1,        // Remove below this strength
  reinforcementBoost: 0.1,    // Strength boost on recall
};
```

## Open Questions

1. **Embedding Model**: OpenAI ada-002 vs open-source alternatives?
2. **Consolidation Frequency**: Daily vs weekly vs on-demand?
3. **Memory Export**: Should users be able to export avatar memories?
4. **Privacy**: How to handle memories about users who request deletion?
5. **Cross-Avatar Memory**: Should avatars share memories? (probably not)
6. **Memory Tokens**: NFT-based memory ownership? (from kyro philosophy)

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Memory recall accuracy | >80% | Test queries against stored facts |
| Identity consistency | Low drift | Compare weekly snapshots |
| User recognition | >90% | Avatar remembers returning users |
| Learning extraction | 1+ per week | Count new learnings |
| Response personalization | Measurable | A/B test with/without memory |

## References

- Cosyworld: `/Users/ratimics/develop/cosyworld/` - Weight-based memory, knowledge graphs
- Kyro: `/Users/ratimics/develop/kyro/` - Perspective summaries, cooldown learning
- Mirquo: `/Users/ratimics/develop/mirquo/` - 3-tier model, identity evolution
- Current impl: `packages/admin-api/src/services/memory.ts`
