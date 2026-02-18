/**
 * @swarm/core - Social Media Avatar Swarm Framework
 * 
 * Core types, platform adapters, processors, and services for building
 * AI-powered social media avatars on AWS.
 */

// Constants
export * from './constants.js';

// Types
export * from './types/index.js';

// Errors
export * from './errors/index.js';

// Platforms
export * from './platforms/index.js';

// Processors
export * from './processors/index.js';

// Services
export * from './services/index.js';

// Tools
export * from './tools/index.js';

// Utilities
export * from './utils/index.js';

// Re-export commonly used types for convenience
export type {
  AvatarConfig,
  SwarmEnvelope,
  SwarmResponse,
  Platform,
  ResponseAction,
  ToolDefinition,
} from './types/index.js';
