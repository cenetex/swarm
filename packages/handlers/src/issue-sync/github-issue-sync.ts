/**
 * GitHub Issue Sync Lambda
 *
 * Triggered by DynamoDB Streams on the ADMIN_TABLE. Filters for new
 * ISSUE#<id>/META records (INSERT events) and creates corresponding
 * GitHub issues via the REST API.
 *
 * Deduplication:
 * - Only processes INSERT events (not MODIFY/REMOVE)
 * - After creating a GitHub issue, writes `githubIssueUrl` and
 *   `githubIssueNumber` back to the DynamoDB record
 * - On retry, checks for existing `githubIssueNumber` before creating
 *
 * Environment variables:
 * - ADMIN_TABLE: DynamoDB table name (for dedup writeback)
 * - GITHUB_APP_CREDENTIALS_ARN: Secrets Manager ARN for GitHub App credentials JSON
 * - GITHUB_REPO: Owner/repo (e.g., "cenetex/aws-swarm")
 * - GITHUB_ISSUE_LABEL_PREFIX: Label prefix for auto-created issues (default: "auto-issue")
 * - ENVIRONMENT: Deployment environment name
 */
import type { DynamoDBStreamEvent, DynamoDBRecord, Context } from 'aws-lambda';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { logger, GitHubAppTokenProvider, type GitHubTokenProvider } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export interface AutoIssueRecord {
  pk: string;
  sk: string;
  issueId: string;
  fingerprint: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  category: string;
  subsystem: string;
  avatarId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  sampleError?: string;
  sampleStack?: string;
  metadata?: Record<string, unknown>;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
}

interface GitHubCreateIssueResponse {
  number: number;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Token provider (lazy singleton, injectable for tests)
// ---------------------------------------------------------------------------

let _tokenProvider: GitHubTokenProvider | null = null;

function getTokenProvider(): GitHubTokenProvider {
  if (!_tokenProvider) {
    const secretArn = process.env.GITHUB_APP_CREDENTIALS_ARN;
    if (!secretArn) {
      throw new Error('GITHUB_APP_CREDENTIALS_ARN environment variable is not set');
    }
    _tokenProvider = new GitHubAppTokenProvider(secretArn);
  }
  return _tokenProvider;
}

/** For testing — inject a mock token provider */
export function _setTokenProvider(provider: GitHubTokenProvider | null): void {
  _tokenProvider = provider;
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function getRepo(): string {
  return process.env.GITHUB_REPO || 'cenetex/aws-swarm';
}

function getLabelPrefix(): string {
  return process.env.GITHUB_ISSUE_LABEL_PREFIX || 'auto-issue';
}

/**
 * Map severity to GitHub issue labels
 */
export function buildLabels(issue: AutoIssueRecord): string[] {
  const prefix = getLabelPrefix();
  const labels: string[] = [prefix];

  // Severity label
  if (issue.severity) {
    labels.push(`priority:${issue.severity === 'critical' ? 'high' : issue.severity}`);
  }

  // Category label
  if (issue.category) {
    labels.push(`type:bug`);
  }

  // Avatar label (for agent-scoped issue tracking)
  if (issue.avatarId) {
    labels.push(`auto-issue:avatar:${issue.avatarId}`);
  }

  // Subsystem label
  if (issue.subsystem) {
    const subsystemToPackage: Record<string, string> = {
      'telegram-webhook': 'package:handlers',
      'message-processor': 'package:handlers',
      'response-sender': 'package:handlers',
      'media-processor': 'package:handlers',
      'admin-api': 'package:admin',
      'chat': 'package:admin',
      'admin': 'package:admin',
      'infra': 'package:infra',
      'core': 'package:core',
    };
    const packageLabel = subsystemToPackage[issue.subsystem];
    if (packageLabel) {
      labels.push(packageLabel);
    }
  }

  return labels;
}

/**
 * Build the GitHub issue body with a deduplication marker
 */
export function buildIssueBody(issue: AutoIssueRecord, environment: string): string {
  const marker = `<!-- internal-issue-sync:id=${issue.issueId} -->`;
  const details = [
    `- **Internal Issue ID:** \`${issue.issueId}\``,
    `- **Fingerprint:** \`${issue.fingerprint}\``,
    `- **Severity:** ${issue.severity}`,
    `- **Status:** ${issue.status}`,
    `- **Category:** ${issue.category}`,
    `- **Subsystem:** ${issue.subsystem}`,
    `- **Occurrences:** ${issue.occurrenceCount}`,
    `- **First seen:** ${new Date(issue.firstSeenAt).toISOString()}`,
    `- **Last seen:** ${new Date(issue.lastSeenAt).toISOString()}`,
    `- **Environment:** ${environment}`,
  ];

  if (issue.avatarId) {
    details.push(`- **Avatar:** ${issue.avatarId}`);
  }

  const sections = [
    marker,
    '',
    '## Summary',
    '',
    issue.description || issue.sampleError || 'No description provided.',
    '',
    '## Internal Context',
    '',
    ...details,
  ];

  if (issue.sampleStack) {
    sections.push(
      '',
      '## Stack Trace',
      '',
      '```',
      issue.sampleStack.slice(0, 3000),
      '```',
    );
  }

  sections.push(
    '',
    '---',
    '*This issue was automatically created by the DynamoDB Streams issue sync Lambda.*',
  );

  return sections.join('\n');
}

/**
 * Create a GitHub issue via the REST API
 */
async function createGitHubIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<GitHubCreateIssueResponse> {
  const url = `https://api.github.com/repos/${repo}/issues`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title, body, labels }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `GitHub API error ${response.status}: ${errorBody.slice(0, 500)}`
    );
  }

  return response.json() as Promise<GitHubCreateIssueResponse>;
}

/**
 * Write the GitHub issue reference back to DynamoDB for deduplication
 */
async function markIssueAsSynced(
  tableName: string,
  pk: string,
  sk: string,
  githubIssueNumber: number,
  githubIssueUrl: string,
): Promise<void> {
  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        'SET githubIssueNumber = :num, githubIssueUrl = :url, githubSyncedAt = :ts',
      ExpressionAttributeValues: {
        ':num': githubIssueNumber,
        ':url': githubIssueUrl,
        ':ts': Date.now(),
      },
    })
  );
}

/**
 * Check if this issue has already been synced to GitHub
 */
async function isAlreadySynced(
  tableName: string,
  pk: string,
  sk: string,
): Promise<boolean> {
  const result = await getDynamoClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk },
      ProjectionExpression: 'githubIssueNumber',
    })
  );
  return !!(result.Item?.githubIssueNumber);
}

/**
 * Determine if a DynamoDB stream record is a new ISSUE#/META insert
 */
export function isNewIssueRecord(record: DynamoDBRecord): boolean {
  if (record.eventName !== 'INSERT') {
    return false;
  }

  const image = record.dynamodb?.NewImage;
  if (!image) {
    return false;
  }

  const pk = image.pk?.S;
  const sk = image.sk?.S;

  return !!(pk && pk.startsWith('ISSUE#') && sk === 'META');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(
  event: DynamoDBStreamEvent,
  context: Context,
): Promise<void> {
  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) {
    logger.error('ADMIN_TABLE environment variable is not set', {
      subsystem: 'github-issue-sync',
      event: 'config_error',
    });
    throw new Error('ADMIN_TABLE is required');
  }

  const environment = process.env.ENVIRONMENT || 'unknown';
  const repo = getRepo();

  // Filter to only new ISSUE#/META records
  const issueRecords = event.Records.filter(isNewIssueRecord);

  if (issueRecords.length === 0) {
    logger.debug('No new issue records in batch', {
      subsystem: 'github-issue-sync',
      event: 'batch_empty',
      totalRecords: event.Records.length,
    });
    return;
  }

  logger.info('Processing new issue records', {
    subsystem: 'github-issue-sync',
    event: 'batch_start',
    issueCount: issueRecords.length,
    totalRecords: event.Records.length,
    requestId: context.awsRequestId,
  });

  // Fetch GitHub token once per invocation
  let token: string;
  try {
    token = await getTokenProvider().getToken();
  } catch (err) {
    logger.error('Failed to retrieve GitHub token', {
      subsystem: 'github-issue-sync',
      event: 'token_error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of issueRecords) {
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    // Unmarshall the DynamoDB record
    const issue = unmarshall(
      newImage as Record<string, AttributeValue>
    ) as AutoIssueRecord;

    try {
      // Deduplication: check if already synced (handles retries)
      const synced = await isAlreadySynced(tableName, issue.pk, issue.sk);
      if (synced) {
        logger.info('Issue already synced, skipping', {
          subsystem: 'github-issue-sync',
          event: 'dedup_skip',
          issueId: issue.issueId,
        });
        skipped++;
        continue;
      }

      // Build GitHub issue content
      const titlePrefix = `[${issue.severity}]`;
      const title = `${titlePrefix} ${issue.title}`;
      const body = buildIssueBody(issue, environment);
      const labels = buildLabels(issue);

      // Create the GitHub issue
      const result = await createGitHubIssue(token, repo, title, body, labels);

      // Write back to DynamoDB for deduplication
      await markIssueAsSynced(
        tableName,
        issue.pk,
        issue.sk,
        result.number,
        result.html_url,
      );

      logger.info('GitHub issue created', {
        subsystem: 'github-issue-sync',
        event: 'issue_created',
        issueId: issue.issueId,
        githubIssueNumber: result.number,
        githubIssueUrl: result.html_url,
        severity: issue.severity,
        subsystem_source: issue.subsystem,
      });

      created++;
    } catch (err) {
      logger.error('Failed to sync issue to GitHub', {
        subsystem: 'github-issue-sync',
        event: 'sync_error',
        issueId: issue.issueId,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
      // Don't throw - process remaining records in the batch.
      // DynamoDB Streams will retry the entire batch on Lambda failure,
      // and our dedup check prevents duplicates.
    }
  }

  logger.info('Batch processing complete', {
    subsystem: 'github-issue-sync',
    event: 'batch_complete',
    created,
    skipped,
    errors,
    requestId: context.awsRequestId,
  });

  // If all records failed, throw to trigger a retry
  if (errors > 0 && created === 0 && skipped === 0) {
    throw new Error(
      `All ${errors} issue sync attempts failed. Throwing to trigger DynamoDB Streams retry.`
    );
  }
}
