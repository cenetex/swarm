/**
 * Dream Worker
 *
 * Processes async dream generation jobs from SQS FIFO queue.
 * Runs with reserved concurrency=1 to ensure only one dream generates
 * at a time across the entire system.
 *
 * Flow:
 * 1. Receive job from SQS
 * 2. Reserve a dream slot (atomic daily counter increment)
 * 3. Generate dream via LLM
 * 4. Process memory resonance (reinforce matching memories)
 * 5. Save dream state
 * 6. Update job status
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '@swarm/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  getDreamJob,
  updateDreamJobStatus,
  reserveDreamSlotForJob,
} from '../services/dream-jobs.js';
import {
  generateDreamContent,
  processDreamMemoryResonance,
  saveDreamState,
} from '../services/dreams.js';
import { DEFAULT_MODELS } from '../services/models-registry.js';

const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || DEFAULT_MODELS.llm;

// Cache for API key (lives for duration of Lambda container)
let cachedApiKey: string | null = null;

type DreamJobMessage = {
  jobId: string;
  avatarId: string;
};

/**
 * Get LLM API key from Secrets Manager (with caching)
 */
async function getLlmApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  // Parse JSON secret (handles {"api_key": "..."} format)
  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY;
    if (!cachedApiKey) {
      throw new Error('api_key not found in secret');
    }
  } catch {
    // Plain string secret
    if (response.SecretString.startsWith('sk-')) {
      cachedApiKey = response.SecretString;
    } else {
      throw new Error('Invalid secret format');
    }
  }

  return cachedApiKey;
}

function parseRecord(record: SQSRecord): DreamJobMessage {
  const parsed = JSON.parse(record.body) as Partial<DreamJobMessage>;
  if (!parsed.jobId || typeof parsed.jobId !== 'string') {
    throw new Error('Invalid SQS message: missing jobId');
  }
  if (!parsed.avatarId || typeof parsed.avatarId !== 'string') {
    throw new Error('Invalid SQS message: missing avatarId');
  }
  return { jobId: parsed.jobId, avatarId: parsed.avatarId };
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    let jobId: string | undefined;

    try {
      const message = parseRecord(record);
      jobId = message.jobId;

      logger.setContext({ subsystem: 'dreams', requestId: record.messageId });
      logger.info('Processing dream job', { event: 'dream_job_started', jobId, avatarId: message.avatarId });

      // Get job details
      const job = await getDreamJob(jobId);
      if (!job) {
        logger.warn('Dream job not found', { event: 'dream_job_missing', jobId });
        continue;
      }

      // Mark as processing
      await updateDreamJobStatus(jobId, 'processing');

      // Reserve a dream slot (atomic daily counter increment)
      // IDEMPOTENCY: Only increment counter if not already reserved (prevents double-counting on retries)
      if (!job.slotReserved) {
        const reservation = await reserveDreamSlotForJob(jobId);
        if (!reservation.reserved) {
          logger.info('Daily dream limit reached, skipping job', {
            event: 'dream_job_skipped',
            jobId,
            reason: 'daily_limit_reached',
          });
          await updateDreamJobStatus(jobId, 'skipped', {
            skippedReason: 'daily_limit_reached',
          });
          continue;
        }
        logger.info('Reserved dream slot', {
          event: 'dream_slot_reserved',
          jobId,
          alreadyReserved: reservation.alreadyReserved,
        });
      } else {
        logger.info('Slot already reserved (retry), skipping counter increment', { jobId });
      }

      // Get LLM API key from Secrets Manager
      const apiKey = await getLlmApiKey();

      // Generate the dream
      const dreamText = await generateDreamContent(
        job.persona,
        job.previousDream,
        apiKey,
        LLM_MODEL
      );

      // Process memory resonance - dream acts as filter for memories
      const reinforcedMemoryIds = await processDreamMemoryResonance(
        job.avatarId,
        dreamText
      );

      // Calculate new iteration
      const newIteration = job.previousIteration + 1;

      // Save dream state to DynamoDB
      await saveDreamState(
        job.avatarId,
        dreamText,
        job.previousDream,
        newIteration,
        reinforcedMemoryIds
      );

      // Mark job as completed
      await updateDreamJobStatus(jobId, 'completed', {
        result: {
          dream: dreamText,
          iteration: newIteration,
          reinforcedMemoryIds,
        },
      });

      logger.info('Dream job completed', {
        event: 'dream_job_completed',
        jobId,
        avatarId: job.avatarId,
        iteration: newIteration,
        memoriesReinforced: reinforcedMemoryIds.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Dream worker error', error, { event: 'dream_job_failed', jobId });

      // Best-effort: mark job as failed
      if (jobId) {
        try {
          await updateDreamJobStatus(jobId, 'failed', { error: message });
        } catch {
          // ignore
        }
      }

      // Re-throw so SQS retry/DLQ behavior applies
      throw error;
    }
  }
}
