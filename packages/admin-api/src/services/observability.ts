/**
 * Observability Service
 *
 * Aggregates system status and per-avatar activity for admin tools and APIs.
 */
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import * as avatarLogs from './avatar-observability.js';
import * as autoIssues from './auto-issues.js';
import * as avatarEvents from './avatar-observability.js';
import * as mediaJobs from './media-jobs.js';
import * as credits from './credits.js';

const sqsClient = new SQSClient({});

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

type QueueAvailabilityReason = 'not_configured' | 'query_failed';

type QueueStatus = {
  depth?: number;
  inFlight?: number;
  unavailable: boolean;
  reason?: QueueAvailabilityReason;
};

type QueueStatusMap = {
  // Backward-compatible alias of sharedPostQueue.
  postQueue?: QueueStatus;
  sharedMessageQueue?: QueueStatus;
  sharedResponseQueue?: QueueStatus;
  sharedMediaQueue?: QueueStatus;
  sharedPostQueue?: QueueStatus;
  sharedDlq?: QueueStatus;
  sharedSchedulerDlq?: QueueStatus;
  adminResponseQueue?: QueueStatus;
  adminChatQueue?: QueueStatus;
  adminDreamQueue?: QueueStatus;
  adminResponseDlq?: QueueStatus;
  adminChatDlq?: QueueStatus;
  adminDreamDlq?: QueueStatus;
  adminConsolidationDlq?: QueueStatus;
};

type QueueConfig = {
  key: Exclude<keyof QueueStatusMap, 'postQueue'>;
  envKey: string;
  legacyEnvKey?: string;
};

const QUEUE_CONFIGS: QueueConfig[] = [
  { key: 'sharedMessageQueue', envKey: 'SYSTEM_SHARED_MESSAGE_QUEUE_URL', legacyEnvKey: 'MESSAGE_QUEUE_URL' },
  { key: 'sharedResponseQueue', envKey: 'SYSTEM_SHARED_RESPONSE_QUEUE_URL', legacyEnvKey: 'RESPONSE_QUEUE_URL' },
  { key: 'sharedMediaQueue', envKey: 'SYSTEM_SHARED_MEDIA_QUEUE_URL', legacyEnvKey: 'MEDIA_QUEUE_URL' },
  { key: 'sharedPostQueue', envKey: 'SYSTEM_SHARED_POST_QUEUE_URL', legacyEnvKey: 'POST_QUEUE_URL' },
  { key: 'sharedDlq', envKey: 'SYSTEM_SHARED_DLQ_URL', legacyEnvKey: 'DLQ_URL' },
  { key: 'sharedSchedulerDlq', envKey: 'SYSTEM_SHARED_SCHEDULER_DLQ_URL' },
  { key: 'adminResponseQueue', envKey: 'SYSTEM_ADMIN_RESPONSE_QUEUE_URL', legacyEnvKey: 'RESPONSE_QUEUE_URL' },
  { key: 'adminChatQueue', envKey: 'SYSTEM_ADMIN_CHAT_QUEUE_URL', legacyEnvKey: 'CHAT_QUEUE_URL' },
  { key: 'adminDreamQueue', envKey: 'SYSTEM_ADMIN_DREAM_QUEUE_URL', legacyEnvKey: 'DREAM_QUEUE_URL' },
  { key: 'adminResponseDlq', envKey: 'SYSTEM_ADMIN_RESPONSE_DLQ_URL' },
  { key: 'adminChatDlq', envKey: 'SYSTEM_ADMIN_CHAT_DLQ_URL' },
  { key: 'adminDreamDlq', envKey: 'SYSTEM_ADMIN_DREAM_DLQ_URL' },
  { key: 'adminConsolidationDlq', envKey: 'SYSTEM_ADMIN_CONSOLIDATION_DLQ_URL' },
];

export interface SystemStatusOptions {
  since?: number;
  avatarId?: string;
}

export interface SystemStatusDeps {
  countLogsByLevel: typeof avatarLogs.countLogsByLevel;
  listIssues: typeof autoIssues.listIssues;
  getToolStatusStructured: typeof credits.getToolStatusStructured;
  getEnergyStatus: typeof credits.getEnergyStatus;
  getQueueDepth: (queueUrl?: string) => Promise<QueueStatus>;
}

export interface SystemStatusResult {
  timestamp: number;
  window: { since: number; until: number };
  errors: {
    errorCount: number;
    warnCount: number;
    truncated: boolean;
    exactness: 'exact' | 'truncated';
  };
  autoIssues: {
    openTotal: number;
    bySeverity: Record<autoIssues.IssueSeverity, number>;
    sampled: boolean;
    sampleLimit: number;
  };
  queues: QueueStatusMap;
  toolCredits?: Record<string, credits.ToolCreditStatus>;
  energy?: { current: number; max: number; nextRefillIn: number };
  rateLimit?: {
    supported: boolean;
    available: boolean | null;
    source: string | null;
    reason?: string;
    details?: Record<string, unknown>;
  };
}

export interface ActivityItemBase {
  timestamp: number;
  type: 'log' | 'event' | 'job';
}

export interface ActivityLogItem extends ActivityItemBase {
  type: 'log';
  level: avatarLogs.LogLevel;
  subsystem: string;
  event: string;
  message: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

export interface ActivityEventItem extends ActivityItemBase {
  type: 'event';
  eventType: avatarEvents.EventType;
  severity?: avatarEvents.IssueSeverity;
  status?: avatarEvents.IssueStatus;
  sentiment?: avatarEvents.FeedbackSentiment;
  title?: string;
  description?: string;
  feature?: string;
}

export interface ActivityJobItem extends ActivityItemBase {
  type: 'job';
  jobId: string;
  status: string;
  jobType: string;
  prompt?: string;
}

export type ActivityItem = ActivityLogItem | ActivityEventItem | ActivityJobItem;

export interface AvatarActivityOptions {
  since?: number;
  limit?: number;
}

export interface AvatarActivityResult {
  avatarId: string;
  window: { since: number; until: number };
  items: ActivityItem[];
  summary: {
    errorCount: number;
    warnCount: number;
    issueCount: number;
    feedbackCount: number;
    pendingJobs: number;
  };
}

function resolveQueueUrl(envKey: string, legacyEnvKey?: string): string | undefined {
  return process.env[envKey] || (legacyEnvKey ? process.env[legacyEnvKey] : undefined);
}

async function getQueueDepth(queueUrl?: string): Promise<QueueStatus> {
  if (!queueUrl) {
    return { unavailable: true, reason: 'not_configured' };
  }

  let response: { Attributes?: Record<string, string> } | undefined;
  try {
    response = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
  } catch {
    return { unavailable: true, reason: 'query_failed' };
  }

  const depth = response.Attributes?.ApproximateNumberOfMessages
    ? Number.parseInt(response.Attributes.ApproximateNumberOfMessages, 10)
    : undefined;
  const inFlight = response.Attributes?.ApproximateNumberOfMessagesNotVisible
    ? Number.parseInt(response.Attributes.ApproximateNumberOfMessagesNotVisible, 10)
    : undefined;

  return { depth, inFlight, unavailable: false };
}

const defaultSystemStatusDeps: SystemStatusDeps = {
  countLogsByLevel: avatarLogs.countLogsByLevel,
  listIssues: autoIssues.listIssues,
  getToolStatusStructured: credits.getToolStatusStructured,
  getEnergyStatus: credits.getEnergyStatus,
  getQueueDepth,
};

async function getQueueHealthSnapshotWithDeps(
  deps: Pick<SystemStatusDeps, 'getQueueDepth'>
): Promise<QueueStatusMap> {
  const queueEntries = await Promise.all(
    QUEUE_CONFIGS.map(async config => {
      const queueUrl = resolveQueueUrl(config.envKey, config.legacyEnvKey);
      const status = await deps.getQueueDepth(queueUrl);
      return [config.key, status] as const;
    })
  );

  const queues = Object.fromEntries(queueEntries) as QueueStatusMap;
  queues.postQueue = queues.sharedPostQueue;
  return queues;
}

export async function getSystemStatus(
  options: SystemStatusOptions = {},
  deps: Partial<SystemStatusDeps> = {},
): Promise<SystemStatusResult> {
  const resolvedDeps: SystemStatusDeps = {
    ...defaultSystemStatusDeps,
    ...deps,
  };

  const now = Date.now();
  const since = options.since ?? (now - DEFAULT_WINDOW_MS);

  const [errorCounts, warnCounts] = await Promise.all([
    resolvedDeps.countLogsByLevel('ERROR', { since }),
    resolvedDeps.countLogsByLevel('WARN', { since }),
  ]);

  const sampleLimit = 200;
  const openIssues = await resolvedDeps.listIssues({ status: 'open', limit: sampleLimit });
  const bySeverity: Record<autoIssues.IssueSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const issue of openIssues) {
    if (issue.severity) {
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    }
  }

  const [queues, toolCredits, energy] = await Promise.all([
    getQueueHealthSnapshotWithDeps(resolvedDeps),
    options.avatarId ? resolvedDeps.getToolStatusStructured(options.avatarId) : Promise.resolve(undefined),
    options.avatarId ? resolvedDeps.getEnergyStatus(options.avatarId) : Promise.resolve(undefined),
  ]);

  const truncated = errorCounts.truncated || warnCounts.truncated;

  return {
    timestamp: now,
    window: { since, until: now },
    errors: {
      errorCount: errorCounts.count,
      warnCount: warnCounts.count,
      truncated,
      exactness: truncated ? 'truncated' : 'exact',
    },
    autoIssues: {
      openTotal: openIssues.length,
      bySeverity,
      sampled: openIssues.length >= sampleLimit,
      sampleLimit,
    },
    queues,
    ...(toolCredits ? { toolCredits } : {}),
    ...(energy ? { energy } : {}),
    rateLimit: {
      supported: false,
      available: null,
      source: null,
      reason: 'global_rate_limit_telemetry_not_instrumented',
    },
  };
}

export async function getAvatarActivity(
  avatarId: string,
  options: AvatarActivityOptions = {}
): Promise<AvatarActivityResult> {
  const now = Date.now();
  const since = options.since ?? (now - DEFAULT_WINDOW_MS);
  const limit = Math.min(options.limit ?? 100, 500);

  const [logsResult, events, pendingJobs] = await Promise.all([
    avatarLogs.listAvatarLogs(avatarId, { since, limit: Math.min(limit * 2, 500) }),
    avatarEvents.listAvatarEvents(avatarId, { since, limit: Math.min(limit, 200) }),
    mediaJobs.getPendingJobs(avatarId),
  ]);

  const logItems: ActivityLogItem[] = logsResult.logs.map(log => ({
    type: 'log',
    timestamp: log.timestamp,
    level: log.level,
    subsystem: log.subsystem,
    event: log.event,
    message: log.message,
    requestId: log.requestId,
    data: log.data,
  }));

  const eventItems: ActivityEventItem[] = events.map(event => ({
    type: 'event',
    timestamp: event.timestamp,
    eventType: event.type,
    severity: event.type === 'issue' ? event.severity : undefined,
    status: event.type === 'issue' ? event.status : undefined,
    sentiment: event.type === 'feedback' ? event.sentiment : undefined,
    title: event.type === 'issue' ? event.title : undefined,
    description: event.type === 'issue' ? event.description : undefined,
    feature: event.type === 'feedback' ? event.feature : undefined,
  }));

  const jobItems: ActivityJobItem[] = pendingJobs.map(job => ({
    type: 'job',
    timestamp: job.updatedAt || job.createdAt,
    jobId: job.jobId,
    status: job.status,
    jobType: job.type,
    prompt: job.prompt,
  }));

  const combined = [...logItems, ...eventItems, ...jobItems]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  const summary = {
    errorCount: logItems.filter(item => item.level === 'ERROR').length,
    warnCount: logItems.filter(item => item.level === 'WARN').length,
    issueCount: eventItems.filter(item => item.eventType === 'issue').length,
    feedbackCount: eventItems.filter(item => item.eventType === 'feedback').length,
    pendingJobs: pendingJobs.length,
  };

  return {
    avatarId,
    window: { since, until: now },
    items: combined,
    summary,
  };
}
