/**
 * Queue message types for SQS processing
 */
import type { SwarmEnvelope } from './envelope.js';
import type { GenerateImageAction, GenerateVideoAction, TakeSelfieAction } from './response.js';
import type { MediaDeliveryIntent } from './continuation.js';

// =============================================================================
// QUEUE MESSAGE TYPES
// =============================================================================

export interface MessageQueueItem {
  envelope: SwarmEnvelope;
  enqueuedAt: number;
  attempts: number;
  maxAttempts: number;
}

export interface ResponseQueueItem {
  avatarId: string;
  envelope: SwarmEnvelope;
  enqueuedAt: number;
  priority: 'high' | 'normal' | 'low';
}

export interface MediaQueueItem {
  avatarId: string;
  conversationId: string;
  deliveryIntent?: MediaDeliveryIntent;
  action: TakeSelfieAction | GenerateImageAction | GenerateVideoAction;
  callbackUrl?: string;
  enqueuedAt: number;
}
