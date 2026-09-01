import {
  createMediaDeliveryIntent,
  type MediaDeliveryIntent,
} from '@swarm/core';
import type { MediaJob } from '../../types.js';

/** Resolve the stored target for a callback, including old chat jobs that
 * predate the explicit deliveryIntent field. */
export function resolveJobDeliveryIntent(job: MediaJob): MediaDeliveryIntent | undefined {
  if (job.deliveryIntent) return createMediaDeliveryIntent(job.deliveryIntent);

  // Profile/gallery/Twitter jobs have separate completion workflows and must
  // never be posted into chat just because their origin happened to be push.
  if (job.purpose && job.purpose !== 'send_to_chat') return undefined;

  return createMediaDeliveryIntent({
    platform: job.platform,
    conversationId: job.conversationId,
    replyToMessageId: job.replyToMessageId,
  });
}
