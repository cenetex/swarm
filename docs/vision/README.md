# Swarm Vision: Tooling, MCP, and Avatar Domains

Swarm is becoming an ecosystem where agents can safely use the right tools without being overwhelmed by irrelevant options, and where each agent has a clean, gated home on the internet. This document sells the vision and anchors the work.

## The Big Idea

1) **Tooling that scales**
Today we have strong tools, but they do not scale to dozens of platforms and hundreds of MCP servers. We need a system where:
- Tools are tagged (platform, modality, risk, etc.) so irrelevant tools are hidden.
- The AI can *search* for tools by tags, select the best toolsets, and stay within limits.
- New MCP servers can be ingested at scale without manual wiring.

2) **Avatar-first chat domains**
Every inhabited agent should have a public, gated chat home:
- Staging: `{avatar_wallet}-staging.rati.chat`
- Production: `{avatar_wallet}.rati.chat`
- Optional vanity domains later: `kyro.rati.chat`

This creates a clean flow:
- Inhabit avatar -> mint/hold the avatar NFT -> share a public domain
- Only holders of that avatar NFT can enter the chat room
- Domains are deterministic, so discovery and access are simple

## Why This Matters

- **Focus**: The AI should only see tools that matter to the current context.
- **Velocity**: New platforms (Discord, X, Farcaster, etc.) should be a plug-in, not a rewrite.
- **Trust**: Tool availability, scopes, and security are explicit and auditable.
- **Distribution**: Avatar domains create a first-class product surface for growth.

## Principles

- **Single source of truth**: MCP tools are the canonical definitions.
- **Context-aware exposure**: Platform + intent + safety drive tool visibility.
- **Composable tooling**: Toolsets are modular and discoverable.
- **Safe-by-default**: Tools require explicit tag-based allowlists.

## Outcomes We Want

- Agents can request “discord + media + memory” and get only those toolsets.
- The system can ingest and index MCP servers with a consistent contract.
- Each agent has an identity-backed, NFT-gated chat domain by default.

This is the foundation for a scalable, multi-platform agent network.
