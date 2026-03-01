/**
 * Raticross Inbound Relay Handler
 *
 * Receives raticross Envelope messages from peer systems (e.g., Kyro)
 * and enqueues them to the shared FIFO message queue as SwarmEnvelopes.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { sendSqsMessage } from '../services/sqs-send.js';
import {
  logger,
  CORRELATION_ID_ATTR,
  createStateService,
  type SwarmEnvelope,
} from '@swarm/core';

const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const STATE_TABLE = process.env.STATE_TABLE!;
const RATICROSS_INBOUND_KEY = process.env.RATICROSS_INBOUND_KEY;

interface RaticrossActor {
  system: string;
  agentId: string;
  pubkey?: string;
}

interface RaticrossEnvelope {
  id: string;
  traceId?: string;
  timestamp: number;
  from: RaticrossActor;
  to: RaticrossActor;
  type: 'message' | 'task' | 'result' | 'status';
  conversationId: string;
  content: string;
  context?: {
    summary?: string;
    constraints?: string;
    toolHints?: string[];
  };
  meta?: {
    ttl?: number;
    priority?: 'low' | 'normal' | 'high';
    tags?: string[];
  };
}

let stateService: ReturnType<typeof createStateService>;

function initialize(): void {
  if (!stateService) {
    stateService = createStateService(STATE_TABLE);
  }
}

function ok(body: Record<string, unknown> = { ok: true }): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function error(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

function mapToSwarmEnvelope(envelope: RaticrossEnvelope, avatarId: string): SwarmEnvelope {
  const correlationId = envelope.traceId || randomUUID();
  const priority = envelope.meta?.priority || 'normal';

  return {
    avatarId,
    platform: 'raticross',
    traceId: correlationId,
    messageId: envelope.id,
    conversationId: envelope.conversationId,
    timestamp: envelope.timestamp,
    sender: {
      id: `${envelope.from.system}:${envelope.from.agentId}`,
      username: envelope.from.agentId,
      displayName: `${envelope.from.system}/${envelope.from.agentId}`,
      isBot: true,
      platform: 'raticross',
      platformUserId: `${envelope.from.system}:${envelope.from.agentId}`,
    },
    content: {
      text: envelope.content,
    },
    mentions: [],
    raw: envelope,
    metadata: {
      receivedAt: Date.now(),
      priority,
      idempotencyKey: `raticross:${avatarId}:${envelope.id}`,
      isMention: true,
      isReplyToBot: false,
    },
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const correlationId = randomUUID();
  logger.setContext({ correlationId, subsystem: 'raticross-inbound' });

  // Auth check
  if (RATICROSS_INBOUND_KEY) {
    const providedKey = event.headers?.['x-raticross-key'];
    if (providedKey !== RATICROSS_INBOUND_KEY) {
      logger.warn('Unauthorized raticross inbound request', {
        event: 'auth_failed',
        subsystem: 'raticross-inbound',
      });
      return error(401, 'Unauthorized');
    }
  }

  if (!event.body) {
    return error(400, 'Missing request body');
  }

  let envelope: RaticrossEnvelope;
  try {
    envelope = JSON.parse(event.body) as RaticrossEnvelope;
  } catch {
    return error(400, 'Invalid JSON body');
  }

  // Validate required fields
  if (!envelope.id || !envelope.from?.system || !envelope.from?.agentId ||
      !envelope.to?.system || !envelope.to?.agentId ||
      !envelope.conversationId || envelope.content === undefined) {
    return error(400, 'Missing required envelope fields');
  }

  initialize();

  // The target agentId maps to an avatarId in aws-swarm
  const avatarId = envelope.to.agentId;

  // Verify the avatar exists
  const avatarConfig = await stateService.getAvatarConfig(avatarId);
  if (!avatarConfig) {
    logger.warn('Raticross message for unknown avatar', {
      event: 'unknown_avatar',
      subsystem: 'raticross-inbound',
      avatarId,
    });
    return error(404, `Avatar not found: ${avatarId}`);
  }

  // Map raticross envelope to SwarmEnvelope
  const swarmEnvelope = mapToSwarmEnvelope(envelope, avatarId);
  const traceId = swarmEnvelope.traceId || correlationId;

  logger.info('Raticross inbound message received', {
    event: 'message_received',
    subsystem: 'raticross-inbound',
    avatarId,
    fromSystem: envelope.from.system,
    fromAgent: envelope.from.agentId,
    conversationId: envelope.conversationId,
    envelopeId: envelope.id,
  });

  // Enqueue to shared message queue
  await sendSqsMessage({
    QueueUrl: MESSAGE_QUEUE_URL,
    MessageAttributes: {
      traceId: { DataType: 'String', StringValue: traceId },
      [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
    },
    MessageGroupId: `${avatarId}#${envelope.conversationId}`,
    MessageDeduplicationId: swarmEnvelope.metadata.idempotencyKey,
  }, {
    envelope: swarmEnvelope,
    enqueuedAt: Date.now(),
  });

  logger.info('Raticross message enqueued', {
    event: 'message_enqueued',
    subsystem: 'raticross-inbound',
    avatarId,
    conversationId: envelope.conversationId,
  });

  return ok({ ok: true, id: envelope.id });
}
