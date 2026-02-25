/**
 * Memory Service — Re-export Barrel
 *
 * This file preserves backward compatibility for all existing imports
 * of `./memory.js` (NodeNext resolves this to memory.ts, NOT memory/index.ts).
 *
 * The implementation has been split into focused modules under ./memory/:
 *   shared.ts, crud.ts, search.ts, tiers.ts, facts.ts, graph.ts, graph-search.ts
 *
 * @module memory
 */
export * from './memory/shared.js';
export * from './memory/crud.js';
export * from './memory/search.js';
export * from './memory/tiers.js';
export * from './memory/facts.js';
export * from './memory/graph.js';
export * from './memory/graph-search.js';
