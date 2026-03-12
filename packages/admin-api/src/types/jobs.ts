/**
 * Job types — async chat, dream, and rate limiting records
 */
import type { z } from 'zod';
import type {
  ActiveTask,
  AdminChatMessage,
  AvatarContextSchema,
  MessageSender,
} from './chat.js';

// Chat job for async admin chat operations
export interface ChatJob {
  pk: string;              // CHATJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  avatarId: string;
  type: 'chat';
  status: 'pending' | 'processing' | 'completed' | 'failed';

  // For display/debugging (compat with other job UIs)
  prompt: string;

  // Who initiated the job (used only for auditing; access checks are avatar-based)
  session: {
    userId?: string;
    email?: string;
    isAdmin?: boolean;
  };

  // Full request payload to execute
  request: {
    message: string;
    history: AdminChatMessage[];
    avatar?: z.infer<typeof AvatarContextSchema>;
    sender?: MessageSender;
    systemPrompt?: string;
    attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>;
    model?: string;
    activeTask?: ActiveTask;
  };

  // Results (filled on completion)
  result?: {
    response: string;
    history: AdminChatMessage[];
    media?: Array<{ type: 'image' | 'video' | 'sticker' | 'audio'; url: string; prompt?: string; id?: string }>;
    pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
    avatarUpdates?: { profileImageUrl?: string; name?: string };
    pendingToolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  };

  error?: string;

  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;
}

// Dream generation job (async, processed by dream worker)
export interface DreamJob {
  pk: string;              // DREAMJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  avatarId: string;
  type: 'dream';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

  // Inputs
  persona: string;
  previousDream?: string;
  previousIteration: number;

  // Idempotency / queue processing
  slotReserved?: boolean;
  skippedReason?: string;

  // Results
  result?: {
    dream: string;
    iteration: number;
    reinforcedMemoryIds?: string[];
  };
  error?: string;

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// System counter for limiting dreams/day
export interface DailyCounter {
  pk: string;              // SYSTEM#dreams
  sk: string;              // DAILY#YYYY-MM-DD
  feature: string;         // 'dreams'
  date: string;            // YYYY-MM-DD
  count: number;
  limit: number;
  updatedAt: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// Credit bucket for rate limiting
export interface CreditBucket {
  pk: string;              // AVATAR#{avatarId}
  sk: string;              // CREDIT#{toolName}
  avatarId: string;
  toolName: string;
  credits: number;
  maxCredits: number;
  lastRefillAt: number;
  dailyUsed: number;
  dailyLimit: number;
  dailyResetAt: number;
}
