/**
 * Chat Worker
 * Processes async admin chat jobs from SQS and writes results back to DynamoDB.
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '@swarm/core';
import * as chatHistory from '../services/chat-history.js';
import { getChatJob, updateChatJobStatus } from '../services/chat-jobs.js';
import { processChat } from './chat.js';
import { LlmCreditsExhaustedError } from './chat-llm.js';
import { parseOpenRouterStatusFromError } from './chat-error-mapping.js';
import { recordError } from '../services/auto-issues.js';
import { ensureRuntimeConfig } from '../services/runtime-config.js';
import { incrementUsage } from '../services/billing/entitlements.js';

type ChatJobMessage = {
  jobId: string;
};

function parseRecord(record: SQSRecord): ChatJobMessage {
  const parsed = JSON.parse(record.body) as Partial<ChatJobMessage>;
  if (!parsed.jobId || typeof parsed.jobId !== 'string') {
    throw new Error('Invalid SQS message: missing jobId');
  }
  return { jobId: parsed.jobId };
}

export async function handler(event: SQSEvent): Promise<void> {
  // Validate critical runtime config on cold start (no-op on warm invocations)
  ensureRuntimeConfig();

  for (const record of event.Records) {
    try {
      const { jobId } = parseRecord(record);
      logger.setContext({ subsystem: 'chat', requestId: record.messageId });

      const job = await getChatJob(jobId);
      if (!job) {
        logger.warn('Chat job not found', { event: 'chat_job_missing', jobId });
        continue;
      }

      await updateChatJobStatus(jobId, 'processing');

      const session = {
        email: job.session.email ?? '',
        userId: job.session.userId ?? '',
        isAdmin: Boolean(job.session.isAdmin),
        accessToken: '',
      };

      const result = await processChat(
        job.request.message,
        job.request.history,
        session,
        // Use the request avatar as-is; dynamic categories are recomputed in the handler when needed.
        job.request.avatar,
        {
          customSystemPrompt: job.request.systemPrompt,
          attachments: job.request.attachments,
          model: job.request.model,
          activeTask: job.request.activeTask,
        }
      );

      await chatHistory.saveChatHistory(session, result.history, job.avatarId);

      // Track message usage against entitlement quota
      if (job.avatarId) {
        incrementUsage(job.avatarId, 'messagesProcessed').catch(err => {
          logger.warn('Failed to increment message usage', { event: 'usage_increment_failed', avatarId: job.avatarId, error: err instanceof Error ? err.message : String(err) });
        });
      }

      await updateChatJobStatus(jobId, 'completed', {
        result: {
          response: result.response,
          history: result.history,
          media: result.media,
          pendingJobs: result.pendingJobs,
          pendingToolCall: result.pendingToolCall,
          avatarUpdates: result.avatarUpdates,
        },
      });

      logger.info('Chat job completed', { event: 'chat_job_completed', jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // Detect 402 (insufficient credits) — either from our custom error class
      // or from the error message pattern when thrown by the SDK path.
      const is402 =
        error instanceof LlmCreditsExhaustedError ||
        parseOpenRouterStatusFromError(message) === 402;

      if (is402) {
        // Non-retryable: mark the job as failed with a user-friendly message
        // and do NOT re-throw (retrying via SQS won't help).
        const creditError = error instanceof LlmCreditsExhaustedError ? error : null;
        logger.error('Chat worker: LLM credits exhausted (402)', error, {
          event: 'provider_credit_exhausted',
          subsystem: 'chat',
          statusCode: 402,
          model: creditError?.model,
          requestedMaxTokens: creditError?.requestedMaxTokens,
          reducedMaxTokens: creditError?.reducedMaxTokens,
        });

        recordError({
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
          subsystem: 'llm',
          category: 'provider_credit_exhausted',
          context: {
            statusCode: 402,
            model: creditError?.model,
            requestedMaxTokens: creditError?.requestedMaxTokens,
            reducedMaxTokens: creditError?.reducedMaxTokens,
          },
        }).catch(() => {
          // Ignore recording failures
        });

        try {
          const maybeParsed = JSON.parse(record.body) as Partial<ChatJobMessage>;
          if (maybeParsed.jobId && typeof maybeParsed.jobId === 'string') {
            await updateChatJobStatus(maybeParsed.jobId, 'failed', {
              error: "I'm unable to respond right now — the AI provider's credit balance has been exhausted. " +
                'Please contact your administrator to add credits, or try again later with a shorter message.',
            });
          }
        } catch {
          // ignore
        }

        // Do NOT re-throw — SQS retries are pointless for a billing/credits issue.
        continue;
      }

      logger.error('Chat worker error', error, { event: 'chat_job_failed' });

      // Best-effort: if we can extract jobId, mark failed
      try {
        const maybeParsed = JSON.parse(record.body) as Partial<ChatJobMessage>;
        if (maybeParsed.jobId && typeof maybeParsed.jobId === 'string') {
          await updateChatJobStatus(maybeParsed.jobId, 'failed', { error: message });
        }
      } catch {
        // ignore
      }

      // Re-throw so SQS retry/DLQ behavior applies
      throw error;
    }
  }
}
