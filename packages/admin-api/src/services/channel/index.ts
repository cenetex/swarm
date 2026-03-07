/**
 * Channel Domain
 *
 * Channel state management: channel state tracking,
 * home channels, and shared channels.
 *
 * CONTROL-PLANE ONLY — channel-state.ts and shared-channel.ts are NOT used
 * for live turn-selection. The runtime coordination implementation is in
 * packages/core/src/services/state/channel-state.ts.
 * @see docs/COORDINATION-OWNERSHIP.md
 */
export * from '../channel-state.js';
export * from '../home-channel.js';
export * from '../shared-channel.js';
