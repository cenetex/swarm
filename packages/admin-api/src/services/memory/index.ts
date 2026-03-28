/**
 * Memory Domain
 *
 * Avatar memory system: storage, search, consolidation,
 * migration, embeddings, and dreams.
 *
 * The core memory service (formerly a single 2,470-LOC file) is split
 * into focused modules under this directory:
 *   shared.ts       — config, validation, DI, batch helpers
 *   crud.ts         — createMemory, getMemory, getMemories, etc.
 *   search.ts       — searchMemories, recallAbout, getCoreMemories, getIdentity
 *   tiers.ts        — applyDecay, promoteImmediateToRecent, identity snapshots
 *   facts.ts        — remember, recall, getMemoryContext, getMemoryStats
 *   graph.ts        — edge CRUD, autoLinkMemory
 *   graph-search.ts — graphSearch, pruneGraph, getGraphMemoryContext, getGraphStats
 */

// Core memory modules (split from memory.ts)
export * from './shared.js';
export * from './crud.js';
export * from './search.js';
export * from './tiers.js';
export * from './facts.js';
export * from './graph.js';
export * from './graph-search.js';

// Sibling services that belong to the memory domain
export * from '../memory-consolidation.js';
export * from '../memory-migration.js';
export * from '../embedding.js';
export * from '../dreams.js';
export * from '../dream-jobs.js';
