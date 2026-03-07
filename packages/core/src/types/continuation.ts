/**
 * Avatar Continuation Types
 *
 * Defines the message format for async job results that should trigger
 * the avatar to continue processing. This enables:
 * - Partial results (streaming updates during long tasks)
 * - Completion callbacks (avatar acts on generated media)
 * - Error handling (avatar responds to failures)
 */

/**
 * Base continuation message structure
 */
export interface ContinuationMessageBase {
  /** Type of continuation event */
  type: ContinuationType;
  /** Avatar that should receive this continuation */
  avatarId: string;
  /** Platform where the conversation is happening */
  platform: 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api';
  /** Conversation/channel ID */
  conversationId: string;
  /** Original message ID (for reply threading) */
  replyToMessageId?: string;
  /** Job ID that generated this result */
  jobId?: string;
  /** Timestamp when event occurred */
  timestamp: number;
}

/**
 * All continuation event types
 */
export type ContinuationType =
  // Media generation
  | 'media_generated'
  | 'media_failed'
  | 'media_progress'
  // Property research
  | 'research_completed'
  | 'research_failed'
  | 'research_progress'
  // Claude code
  | 'code_completed'
  | 'code_failed'
  | 'code_progress'
  // Generic
  | 'job_completed'
  | 'job_failed'
  | 'job_progress'
  // External events
  | 'mention_received'
  | 'scheduled_trigger';

/**
 * Media generation completed
 */
export interface MediaGeneratedContinuation extends ContinuationMessageBase {
  type: 'media_generated';
  data: {
    mediaType: 'image' | 'video' | 'sticker';
    mediaUrl: string;
    prompt: string;
    /** Purpose hint for the avatar */
    purpose?: 'profile' | 'post_to_twitter' | 'send_to_chat' | 'gallery';
  };
}

/**
 * Media generation failed
 */
export interface MediaFailedContinuation extends ContinuationMessageBase {
  type: 'media_failed';
  data: {
    mediaType: 'image' | 'video' | 'sticker';
    error: string;
    prompt: string;
  };
}

/**
 * Media generation progress (for long-running video generation)
 */
export interface MediaProgressContinuation extends ContinuationMessageBase {
  type: 'media_progress';
  data: {
    mediaType: 'image' | 'video' | 'sticker';
    status: string;
    progress?: number;
    estimatedTimeMs?: number;
  };
}

/**
 * Property research completed
 */
export interface ResearchCompletedContinuation extends ContinuationMessageBase {
  type: 'research_completed';
  data: {
    address: string;
    summary: string;
    fullReport?: unknown;
    keyFindings: string[];
  };
}

/**
 * Property research failed
 */
export interface ResearchFailedContinuation extends ContinuationMessageBase {
  type: 'research_failed';
  data: {
    address: string;
    error: string;
  };
}

/**
 * Property research progress
 */
export interface ResearchProgressContinuation extends ContinuationMessageBase {
  type: 'research_progress';
  data: {
    address: string;
    stage: string;
    message: string;
    progress?: number;
  };
}

/**
 * Claude code task completed
 */
export interface CodeCompletedContinuation extends ContinuationMessageBase {
  type: 'code_completed';
  data: {
    task: string;
    result: string;
    sessionId?: string;
    filesModified?: string[];
  };
}

/**
 * Claude code task failed
 */
export interface CodeFailedContinuation extends ContinuationMessageBase {
  type: 'code_failed';
  data: {
    task: string;
    error: string;
  };
}

/**
 * Claude code progress
 */
export interface CodeProgressContinuation extends ContinuationMessageBase {
  type: 'code_progress';
  data: {
    task: string;
    stage: 'thinking' | 'coding' | 'testing' | 'reviewing';
    message: string;
    currentFile?: string;
  };
}

/**
 * Generic job completed
 */
export interface JobCompletedContinuation extends ContinuationMessageBase {
  type: 'job_completed';
  data: {
    jobType: string;
    result: unknown;
  };
}

/**
 * Generic job failed
 */
export interface JobFailedContinuation extends ContinuationMessageBase {
  type: 'job_failed';
  data: {
    jobType: string;
    error: string;
  };
}

/**
 * Generic job progress
 */
export interface JobProgressContinuation extends ContinuationMessageBase {
  type: 'job_progress';
  data: {
    jobType: string;
    message: string;
    progress?: number;
  };
}

/**
 * Union type for all continuation messages
 */
export type ContinuationMessage =
  | MediaGeneratedContinuation
  | MediaFailedContinuation
  | MediaProgressContinuation
  | ResearchCompletedContinuation
  | ResearchFailedContinuation
  | ResearchProgressContinuation
  | CodeCompletedContinuation
  | CodeFailedContinuation
  | CodeProgressContinuation
  | JobCompletedContinuation
  | JobFailedContinuation
  | JobProgressContinuation;

/**
 * Format a continuation message as a system prompt injection
 * This creates a message the avatar will see and can act upon
 */
export function formatContinuationAsSystemMessage(msg: ContinuationMessage): string {
  const timestamp = new Date(msg.timestamp).toISOString();

  switch (msg.type) {
    case 'media_generated':
      return `[ASYNC RESULT @ ${timestamp}]
Your image generation completed successfully!
- Type: ${msg.data.mediaType}
- URL: ${msg.data.mediaUrl}
- Prompt: "${msg.data.prompt}"
${msg.data.purpose === 'post_to_twitter' ? '\n⚠️ This was intended for Twitter. You should now call twitter_post with this mediaUrl.' : ''}
${msg.data.purpose === 'profile' ? '\n⚠️ This was for your profile picture update.' : ''}

You can now use this media URL in your response or next action.`;

    case 'media_failed': {
      const isPromptRejection =
        msg.data.error.includes('E006') || msg.data.error.includes('Prompt was rejected');
      if (isPromptRejection) {
        return `[ASYNC RESULT @ ${timestamp}]
Your ${msg.data.mediaType} generation failed because the prompt was flagged by the image model's content filter.
- Original prompt: "${msg.data.prompt}"

Tell the user their prompt was rejected by the content filter and ask them to rephrase it. Do not echo the raw error code or any prediction IDs.`;
      }
      return `[ASYNC RESULT @ ${timestamp}]
Your ${msg.data.mediaType} generation failed.
- Error: ${msg.data.error}
- Original prompt: "${msg.data.prompt}"

You should inform the user about this failure and optionally offer to retry.`;
    }

    case 'media_progress':
      return `[ASYNC STATUS @ ${timestamp}]
Your ${msg.data.mediaType} is still generating.
- Status: ${msg.data.status}
${msg.data.progress !== undefined ? `- Progress: ${msg.data.progress}%` : ''}
${msg.data.estimatedTimeMs ? `- ETA: ~${Math.ceil(msg.data.estimatedTimeMs / 1000)}s` : ''}`;

    case 'research_completed':
      return `[ASYNC RESULT @ ${timestamp}]
Property research completed for: ${msg.data.address}

Summary: ${msg.data.summary}

Key Findings:
${msg.data.keyFindings.map(f => `• ${f}`).join('\n')}

Share these results with the user.`;

    case 'research_failed':
      return `[ASYNC RESULT @ ${timestamp}]
Property research failed for: ${msg.data.address}
Error: ${msg.data.error}

Inform the user about this failure.`;

    case 'research_progress':
      return `[ASYNC STATUS @ ${timestamp}]
Property research in progress for: ${msg.data.address}
Stage: ${msg.data.stage}
${msg.data.message}`;

    case 'code_completed':
      return `[ASYNC RESULT @ ${timestamp}]
Coding task completed!
Task: ${msg.data.task}

Result:
${msg.data.result}
${msg.data.filesModified?.length ? `\nFiles modified: ${msg.data.filesModified.join(', ')}` : ''}

Share the results with the user.`;

    case 'code_failed':
      return `[ASYNC RESULT @ ${timestamp}]
Coding task failed.
Task: ${msg.data.task}
Error: ${msg.data.error}

Inform the user about this failure.`;

    case 'code_progress':
      return `[ASYNC STATUS @ ${timestamp}]
Coding in progress...
Stage: ${msg.data.stage}
${msg.data.message}
${msg.data.currentFile ? `Working on: ${msg.data.currentFile}` : ''}`;

    case 'job_completed':
      return `[ASYNC RESULT @ ${timestamp}]
Job completed (${msg.data.jobType})
Result: ${JSON.stringify(msg.data.result)}`;

    case 'job_failed':
      return `[ASYNC RESULT @ ${timestamp}]
Job failed (${msg.data.jobType})
Error: ${msg.data.error}`;

    case 'job_progress':
      return `[ASYNC STATUS @ ${timestamp}]
Job progress (${msg.data.jobType})
${msg.data.message}
${msg.data.progress !== undefined ? `Progress: ${msg.data.progress}%` : ''}`;

    default:
      return `[ASYNC EVENT @ ${timestamp}]
Unknown event type: ${(msg as ContinuationMessageBase).type}`;
  }
}

/**
 * Determine if an avatar should continue processing based on the continuation
 * Some events are informational (progress), others require action (completed)
 */
export function shouldTriggerAvatarLoop(msg: ContinuationMessage): boolean {
  // Completion and failure events should trigger the avatar to respond
  const actionableTypes: ContinuationType[] = [
    'media_generated',
    'media_failed',
    'research_completed',
    'research_failed',
    'code_completed',
    'code_failed',
    'job_completed',
    'job_failed',
  ];

  return actionableTypes.includes(msg.type);
}

/**
 * Determine if this is a progress update that should be sent to user
 * but NOT re-trigger the full agentic loop
 */
export function isProgressUpdate(msg: ContinuationMessage): boolean {
  const progressTypes: ContinuationType[] = [
    'media_progress',
    'research_progress',
    'code_progress',
    'job_progress',
  ];

  return progressTypes.includes(msg.type);
}
