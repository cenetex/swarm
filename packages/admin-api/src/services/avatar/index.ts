/**
 * Avatar Domain
 *
 * Core avatar lifecycle management: CRUD, ownership, ascension,
 * observability, activation readiness, and configuration sync.
 */
export * from '../avatars.js';
export * from '../avatar-ownership.js';
export * from '../avatar-stats.js';
export * from '../avatar-observability.js';
export * from '../activation-readiness.js';
export * from '../config-sync.js';

// Namespaced re-exports to avoid conflicts
export * as avatarAscend from '../avatar-ascend.js';
