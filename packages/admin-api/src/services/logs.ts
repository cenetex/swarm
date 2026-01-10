/**
 * CloudWatch Logs query helper for consolidated agent logs.
 */
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  type QueryStatus,
} from '@aws-sdk/client-cloudwatch-logs';

const logsClient = new CloudWatchLogsClient({});

const DEFAULT_LOOKBACK_MINUTES = 30;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const LOG_GROUP_PREFIX = process.env.LOG_GROUP_PREFIX || '/aws/lambda/';
const ADMIN_LOG_GROUPS = (process.env.ADMIN_LOG_GROUPS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const ADMIN_LOG_GROUP_PREFIXES = (process.env.ADMIN_LOG_GROUP_PREFIXES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

export interface LogQueryOptions {
  level?: string;
  subsystem?: string;
  since?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  query?: string;
}

export interface AgentLogEvent {
  timestamp?: string;
  message?: string;
  logGroup?: string;
  logStream?: string;
}

export interface AgentLogResult {
  agentId: string;
  startTime: number;
  endTime: number;
  logGroups: string[];
  filters: {
    level?: string;
    subsystem?: string;
    query?: string;
    limit: number;
  };
  events: AgentLogEvent[];
}

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

function parseSince(since?: string): number | null {
  if (!since) return null;
  const match = since.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!value) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildInsightsQuery(agentId: string, options: LogQueryOptions, limit: number): string {
  const filters: string[] = [];
  const escapedAgent = escapeRegex(agentId);
  filters.push(
    `(@message like /"agentId"\\s*:\\s*"${escapedAgent}"/ or @message like /agentId=${escapedAgent}/)`
  );

  if (options.level) {
    const escapedLevel = escapeRegex(options.level);
    filters.push(
      `(@message like /"level"\\s*:\\s*"${escapedLevel}"/ or @message like /level=${escapedLevel}/)`
    );
  }

  if (options.subsystem) {
    const escapedSubsystem = escapeRegex(options.subsystem);
    filters.push(
      `(@log like /${escapedSubsystem}/ or @message like /"subsystem"\\s*:\\s*"${escapedSubsystem}"/ or @message like /"component"\\s*:\\s*"${escapedSubsystem}"/ or @message like /subsystem=${escapedSubsystem}/)`
    );
  }

  if (options.query) {
    const escapedQuery = escapeRegex(options.query);
    filters.push(`@message like /${escapedQuery}/`);
  }

  const filterClause = filters.length ? `| filter ${filters.join(' and ')}` : '';

  return [
    'fields @timestamp, @message, @log, @logStream',
    filterClause,
    '| sort @timestamp desc',
    `| limit ${limit}`,
  ].join('\n');
}

async function describeLogGroups(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await logsClient.send(new DescribeLogGroupsCommand({
      logGroupNamePrefix: prefix,
      nextToken,
    }));

    for (const group of response.logGroups || []) {
      if (group.logGroupName) {
        names.push(group.logGroupName);
      }
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return names;
}

async function resolveLogGroups(agentId: string): Promise<string[]> {
  const logGroups = new Set<string>();

  const agentPrefix = `${LOG_GROUP_PREFIX}${agentId}-`;
  const agentGroups = await describeLogGroups(agentPrefix);
  agentGroups.forEach((name) => logGroups.add(name));

  for (const group of ADMIN_LOG_GROUPS) {
    logGroups.add(group);
  }

  for (const prefix of ADMIN_LOG_GROUP_PREFIXES) {
    const groups = await describeLogGroups(prefix);
    groups.forEach((name) => logGroups.add(name));
  }

  return Array.from(logGroups);
}

async function waitForQuery(queryId: string): Promise<{ status: QueryStatus; results: AgentLogEvent[] }> {
  const maxAttempts = 20;
  const delayMs = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await logsClient.send(new GetQueryResultsCommand({ queryId }));
    const status = response.status || 'Failed';

    if (status === 'Complete') {
      const events = (response.results || []).map((row) => {
        const event: AgentLogEvent = {};
        for (const field of row) {
          if (!field.field || field.value === undefined) continue;
          if (field.field === '@timestamp') event.timestamp = field.value;
          if (field.field === '@message') event.message = field.value;
          if (field.field === '@log') event.logGroup = field.value;
          if (field.field === '@logStream') event.logStream = field.value;
        }
        return event;
      });
      return { status, results: events };
    }

    if (status === 'Failed' || status === 'Cancelled') {
      return { status, results: [] };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { status: 'Timeout', results: [] };
}

export async function queryAgentLogs(
  agentId: string,
  options: LogQueryOptions = {}
): Promise<AgentLogResult> {
  const now = Date.now();
  const limit = clampLimit(options.limit);
  const sinceMs = parseSince(options.since) ?? (DEFAULT_LOOKBACK_MINUTES * 60 * 1000);
  const startTime = options.startTime ?? (now - sinceMs);
  const endTime = options.endTime ?? now;

  const logGroups = await resolveLogGroups(agentId);

  if (logGroups.length === 0) {
    return {
      agentId,
      startTime,
      endTime,
      logGroups: [],
      filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
      events: [],
    };
  }

  const queryString = buildInsightsQuery(agentId, options, limit);

  const startResponse = await logsClient.send(new StartQueryCommand({
    logGroupNames: logGroups,
    startTime: Math.floor(startTime / 1000),
    endTime: Math.floor(endTime / 1000),
    queryString,
  }));

  const queryId = startResponse.queryId;
  if (!queryId) {
    return {
      agentId,
      startTime,
      endTime,
      logGroups,
      filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
      events: [],
    };
  }

  const { results } = await waitForQuery(queryId);

  return {
    agentId,
    startTime,
    endTime,
    logGroups,
    filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
    events: results,
  };
}
