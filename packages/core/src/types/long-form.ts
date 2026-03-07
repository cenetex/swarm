/**
 * Long-Form Content Types
 *
 * Types for the long-form document pipeline that supports drafting and delivery
 * of content beyond platform character limits, including chunked messaging and
 * import/export workflows.
 */

import type { Platform } from './platform.js';

// =============================================================================
// PLATFORM CHUNK LIMITS
// =============================================================================

/**
 * Maximum character limits per platform
 */
export const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  twitter: 280,
  web: 4096,
  'shared-chat': 4096,
};

// =============================================================================
// LONG-FORM DOCUMENT TYPES
// =============================================================================

/**
 * Status of a long-form document in the pipeline
 */
export type LongFormStatus = 'draft' | 'sending' | 'sent' | 'failed';

/**
 * Metadata for a single chunk of a long-form document
 */
export interface ChunkMeta {
  /** Zero-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
  /** Chunk text content (includes sequence marker) */
  content: string;
  /** Timestamp when this chunk was sent */
  sentAt?: number;
  /** Platform message ID after successful delivery */
  messageId?: string;
}

/**
 * A long-form document stored in DynamoDB
 *
 * DynamoDB Schema:
 * PK: LONGFORM#<platform>
 * SK: DOC#<createdAt>#<id>
 */
export interface LongFormDocument {
  /** Unique document identifier */
  id: string;
  /** Full original content */
  content: string;
  /** Target platform */
  platform: Platform;
  /** Current delivery status */
  status: LongFormStatus;
  /** Chunk metadata (populated after chunking) */
  chunks?: ChunkMeta[];
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last update timestamp (ms) */
  updatedAt: number;
  /** TTL for DynamoDB (seconds since epoch) */
  ttl?: number;
}
