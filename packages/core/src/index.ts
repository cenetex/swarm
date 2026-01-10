/**
 * @swarm/core - Social Media Agent Swarm Framework
 * 
 * Core types, platform adapters, processors, and services for building
 * AI-powered social media agents on AWS.
 */

// Types
export * from './types/index.js';

// Platforms
export * from './platforms/index.js';

// Processors
export * from './processors/index.js';

// Services
export * from './services/index.js';

// Utilities
export * from './utils/index.js';

// Re-export commonly used types for convenience
export type {
  AgentConfig,
  SwarmEnvelope,
  SwarmResponse,
  Platform,
  ResponseAction,
  ToolDefinition,
} from './types/index.js';
