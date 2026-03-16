/**
 * GitHub Issue Sync Lambda Tests
 *
 * Tests for the DynamoDB Streams -> GitHub issue sync handler.
 * Covers record filtering, deduplication, issue creation, and error handling.
 *
 * Uses bun:test (with vitest-compatible API).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DynamoDBStreamEvent, DynamoDBRecord, Context } from 'aws-lambda';
import {
  handler,
  isNewIssueRecord,
  buildLabels,
  buildIssueBody,
  _setTokenProvider,
  type AutoIssueRecord,
} from './github-issue-sync.js';
import { _setDynamoClient } from '../services/dynamo-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(overrides?: Partial<Context>): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'github-issue-sync',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:github-issue-sync',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/github-issue-sync',
    logStreamName: '2024/01/01/[$LATEST]abc123',
    getRemainingTimeInMillis: () => 60000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
    ...overrides,
  };
}

function makeIssueRecord(overrides: Partial<AutoIssueRecord> = {}): AutoIssueRecord {
  return {
    pk: 'ISSUE#issue-abc123',
    sk: 'META',
    issueId: 'issue-abc123',
    fingerprint: 'abc123',
    title: '[test] Sample error',
    description: 'Something went wrong',
    severity: 'high',
    status: 'open',
    category: 'error',
    subsystem: 'message-processor',
    firstSeenAt: 1700000000000,
    lastSeenAt: 1700000000000,
    occurrenceCount: 1,
    ...overrides,
  };
}

function createInsertRecord(pk: string, sk: string, extraFields: Record<string, unknown> = {}): DynamoDBRecord {
  return {
    eventID: `event-${Date.now()}`,
    eventName: 'INSERT',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    dynamodb: {
      Keys: {
        pk: { S: pk },
        sk: { S: sk },
      },
      NewImage: {
        pk: { S: pk },
        sk: { S: sk },
        issueId: { S: (extraFields.issueId as string) || 'issue-abc123' },
        fingerprint: { S: (extraFields.fingerprint as string) || 'abc123' },
        title: { S: (extraFields.title as string) || '[test] Sample error' },
        description: { S: (extraFields.description as string) || 'Something went wrong' },
        severity: { S: (extraFields.severity as string) || 'high' },
        status: { S: (extraFields.status as string) || 'open' },
        category: { S: (extraFields.category as string) || 'error' },
        subsystem: { S: (extraFields.subsystem as string) || 'message-processor' },
        firstSeenAt: { N: String(extraFields.firstSeenAt || 1700000000000) },
        lastSeenAt: { N: String(extraFields.lastSeenAt || 1700000000000) },
        occurrenceCount: { N: String(extraFields.occurrenceCount || 1) },
      },
      StreamViewType: 'NEW_IMAGE',
      SequenceNumber: '12345',
      SizeBytes: 500,
    },
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/SwarmAdmin-staging/stream/2024-01-01T00:00:00.000',
  };
}

function createModifyRecord(pk: string, sk: string): DynamoDBRecord {
  return {
    ...createInsertRecord(pk, sk),
    eventName: 'MODIFY',
  };
}

function createRemoveRecord(pk: string, sk: string): DynamoDBRecord {
  return {
    eventID: `event-${Date.now()}`,
    eventName: 'REMOVE',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    dynamodb: {
      Keys: {
        pk: { S: pk },
        sk: { S: sk },
      },
      OldImage: {
        pk: { S: pk },
        sk: { S: sk },
      },
      StreamViewType: 'NEW_IMAGE',
      SequenceNumber: '12346',
      SizeBytes: 200,
    },
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/SwarmAdmin-staging/stream/2024-01-01T00:00:00.000',
  };
}

// ---------------------------------------------------------------------------
// Unit tests: isNewIssueRecord
// ---------------------------------------------------------------------------

describe('isNewIssueRecord', () => {
  it('returns true for INSERT of ISSUE#/META', () => {
    const record = createInsertRecord('ISSUE#issue-abc', 'META');
    expect(isNewIssueRecord(record)).toBe(true);
  });

  it('returns false for MODIFY events', () => {
    const record = createModifyRecord('ISSUE#issue-abc', 'META');
    expect(isNewIssueRecord(record)).toBe(false);
  });

  it('returns false for REMOVE events', () => {
    const record = createRemoveRecord('ISSUE#issue-abc', 'META');
    expect(isNewIssueRecord(record)).toBe(false);
  });

  it('returns false for non-ISSUE pk', () => {
    const record = createInsertRecord('AVATAR#my-avatar', 'CONFIG');
    expect(isNewIssueRecord(record)).toBe(false);
  });

  it('returns false for OCCURRENCE sk', () => {
    const record = createInsertRecord('ISSUE#issue-abc', 'OCCURRENCE#12345');
    expect(isNewIssueRecord(record)).toBe(false);
  });

  it('returns false when NewImage is missing', () => {
    const record: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: {},
    };
    expect(isNewIssueRecord(record)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: buildLabels
// ---------------------------------------------------------------------------

describe('buildLabels', () => {
  it('includes auto-issue prefix', () => {
    const labels = buildLabels(makeIssueRecord());
    expect(labels).toContain('auto-issue');
  });

  it('maps critical severity to priority:high', () => {
    const labels = buildLabels(makeIssueRecord({ severity: 'critical' }));
    expect(labels).toContain('priority:high');
  });

  it('maps high severity to priority:high', () => {
    const labels = buildLabels(makeIssueRecord({ severity: 'high' }));
    expect(labels).toContain('priority:high');
  });

  it('maps medium severity to priority:medium', () => {
    const labels = buildLabels(makeIssueRecord({ severity: 'medium' }));
    expect(labels).toContain('priority:medium');
  });

  it('maps low severity to priority:low', () => {
    const labels = buildLabels(makeIssueRecord({ severity: 'low' }));
    expect(labels).toContain('priority:low');
  });

  it('includes type:bug for any category', () => {
    const labels = buildLabels(makeIssueRecord({ category: 'webhook_error' }));
    expect(labels).toContain('type:bug');
  });

  it('maps message-processor subsystem to package:handlers', () => {
    const labels = buildLabels(makeIssueRecord({ subsystem: 'message-processor' }));
    expect(labels).toContain('package:handlers');
  });

  it('maps admin-api subsystem to package:admin', () => {
    const labels = buildLabels(makeIssueRecord({ subsystem: 'admin-api' }));
    expect(labels).toContain('package:admin');
  });

  it('does not add package label for unknown subsystem', () => {
    const labels = buildLabels(makeIssueRecord({ subsystem: 'some-unknown' }));
    const packageLabels = labels.filter(l => l.startsWith('package:'));
    expect(packageLabels.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: buildIssueBody
// ---------------------------------------------------------------------------

describe('buildIssueBody', () => {
  it('includes deduplication marker', () => {
    const body = buildIssueBody(makeIssueRecord({ issueId: 'issue-xyz' }), 'staging');
    expect(body).toContain('<!-- internal-issue-sync:id=issue-xyz -->');
  });

  it('includes issue metadata', () => {
    const body = buildIssueBody(makeIssueRecord({
      issueId: 'issue-test',
      severity: 'critical',
      subsystem: 'admin-api',
    }), 'prod');
    expect(body).toContain('issue-test');
    expect(body).toContain('critical');
    expect(body).toContain('admin-api');
    expect(body).toContain('prod');
  });

  it('includes stack trace when present', () => {
    const body = buildIssueBody(makeIssueRecord({
      sampleStack: 'Error: boom\n    at handler (index.ts:42:13)',
    }), 'staging');
    expect(body).toContain('## Stack Trace');
    expect(body).toContain('Error: boom');
  });

  it('does not include stack trace section when absent', () => {
    const body = buildIssueBody(makeIssueRecord({ sampleStack: undefined }), 'staging');
    expect(body).not.toContain('## Stack Trace');
  });

  it('includes avatar ID when present', () => {
    const body = buildIssueBody(makeIssueRecord({ avatarId: 'avatar-kyro' }), 'staging');
    expect(body).toContain('avatar-kyro');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: handler
// ---------------------------------------------------------------------------

describe('handler (integration)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let mockDynamoSend: ReturnType<typeof mock>;

  beforeEach(() => {
    process.env.ADMIN_TABLE = 'SwarmAdmin-staging';
    process.env.GITHUB_APP_CREDENTIALS_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-app-creds';
    process.env.GITHUB_REPO = 'cenetex/aws-swarm';
    process.env.ENVIRONMENT = 'staging';

    // Mock fetch
    mockFetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/cenetex/aws-swarm/issues/42' }),
      text: () => Promise.resolve(''),
    }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Mock DynamoDB client
    mockDynamoSend = mock(() => Promise.resolve({ Item: undefined }));
    _setDynamoClient({ send: mockDynamoSend } as any);

    // Mock token provider (replaces SecretsManager mock)
    _setTokenProvider({ getToken: async () => 'ghs_test_token_123' });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    _setDynamoClient(null);
    _setTokenProvider(null);
  });

  it('skips batch with no ISSUE#/META INSERT records', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createModifyRecord('ISSUE#issue-abc', 'META'),
        createRemoveRecord('ISSUE#issue-abc', 'META'),
        createInsertRecord('AVATAR#my-avatar', 'CONFIG'),
        createInsertRecord('ISSUE#issue-abc', 'OCCURRENCE#12345'),
      ],
    };

    await handler(event, createContext());

    // No GitHub API calls or DynamoDB dedup checks
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('creates a GitHub issue for a new ISSUE#/META INSERT', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createInsertRecord('ISSUE#issue-abc123', 'META', {
          issueId: 'issue-abc123',
          title: '[message-processor] Timeout calling LLM',
          severity: 'high',
          subsystem: 'message-processor',
        }),
      ],
    };

    await handler(event, createContext());

    // Should have called GitHub API
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.github.com/repos/cenetex/aws-swarm/issues');

    const body = JSON.parse(fetchCall[1].body);
    expect(body.title).toContain('[high]');
    expect(body.title).toContain('[message-processor] Timeout calling LLM');
    expect(body.body).toContain('issue-abc123');
    expect(body.body).toContain('internal-issue-sync:id=issue-abc123');
    expect(body.labels).toContain('auto-issue');
    expect(body.labels).toContain('package:handlers');

    // DynamoDB: 1 dedup check (GetCommand) + 1 writeback (UpdateCommand)
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it('skips issue that is already synced (deduplication)', async () => {
    // Return item with githubIssueNumber for dedup check
    mockDynamoSend = mock(() => Promise.resolve({ Item: { githubIssueNumber: 42 } }));
    _setDynamoClient({ send: mockDynamoSend } as any);

    const event: DynamoDBStreamEvent = {
      Records: [
        createInsertRecord('ISSUE#issue-abc123', 'META'),
      ],
    };

    await handler(event, createContext());

    // Should NOT have called GitHub API
    expect(mockFetch).not.toHaveBeenCalled();
    // Should have called DynamoDB only once (the dedup check)
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  it('handles GitHub API errors gracefully for individual records', async () => {
    let fetchCallCount = 0;
    mockFetch = mock(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 422,
          text: () => Promise.resolve('Validation Failed'),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ number: 43, html_url: 'https://github.com/cenetex/aws-swarm/issues/43' }),
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const event: DynamoDBStreamEvent = {
      Records: [
        createInsertRecord('ISSUE#issue-fail', 'META', { issueId: 'issue-fail' }),
        createInsertRecord('ISSUE#issue-ok', 'META', { issueId: 'issue-ok' }),
      ],
    };

    // Should not throw (partial success: 1 created, 1 error)
    await handler(event, createContext());

    // Both should have been attempted
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws when all records fail to trigger DynamoDB Streams retry', async () => {
    mockFetch = mock(() => Promise.resolve({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const event: DynamoDBStreamEvent = {
      Records: [
        createInsertRecord('ISSUE#issue-fail1', 'META', { issueId: 'issue-fail1' }),
        createInsertRecord('ISSUE#issue-fail2', 'META', { issueId: 'issue-fail2' }),
      ],
    };

    try {
      await handler(event, createContext());
      // Should have thrown
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('All 2 issue sync attempts failed');
    }
  });

  it('throws when ADMIN_TABLE is not set', async () => {
    delete process.env.ADMIN_TABLE;

    const event: DynamoDBStreamEvent = {
      Records: [createInsertRecord('ISSUE#issue-abc', 'META')],
    };

    try {
      await handler(event, createContext());
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('ADMIN_TABLE is required');
    }
  });

  it('processes mixed records, only handling ISSUE#/META INSERTs', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createInsertRecord('AVATAR#my-avatar', 'CONFIG'),      // Not an issue
        createModifyRecord('ISSUE#issue-old', 'META'),          // MODIFY, not INSERT
        createInsertRecord('ISSUE#issue-new', 'META', { issueId: 'issue-new' }), // Valid
        createInsertRecord('ISSUE#issue-new', 'OCCURRENCE#12345'), // sk != META
      ],
    };

    await handler(event, createContext());

    // Only one GitHub API call for the single valid record
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
