import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock AWS SDK
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = vi.fn();
  return {
    DynamoDBDocumentClient: {
      from: vi.fn(() => ({
        send: mockSend
      }))
    },
    GetCommand: vi.fn(x => x),
    PutCommand: vi.fn(x => x),
    UpdateCommand: vi.fn(x => x),
    ScanCommand: vi.fn(x => x),
    DeleteCommand: vi.fn(x => x),
  };
});

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

describe('PropertyResearchService', () => {
  let propertyResearch: typeof import('./property-research.js');
  let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  let mockDocClient: ReturnType<typeof mocked>;
  const agentId = 'test-agent';
  const walletAddress = '0x123';

  beforeAll(async () => {
    ({ DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb'));
    propertyResearch = await import('./property-research.js');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocClient = mocked(DynamoDBDocumentClient.from(null as any));
  });

  describe('Authorization', () => {
    it('returns true if valid auth exists', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: {
          expiresAt: Date.now() + 10000
        }
      });

      const result = await propertyResearch.checkAuth(agentId, walletAddress);
      expect(result).toBe(true);
    });

    it('returns false if auth is expired', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: {
          expiresAt: Date.now() - 10000
        }
      });

      const result = await propertyResearch.checkAuth(agentId, walletAddress);
      expect(result).toBe(false);
    });

    it('returns false if no auth exists', async () => {
      mockDocClient.send.mockResolvedValueOnce({ Item: undefined });

      const result = await propertyResearch.checkAuth(agentId, walletAddress);
      expect(result).toBe(false);
    });

    it('grants authorization with correct TTL', async () => {
      mockDocClient.send.mockResolvedValueOnce({}); // PutCommand

      const auth = await propertyResearch.grantAuth(agentId, walletAddress);
      
      expect(auth.agentId).toBe(agentId);
      expect(auth.walletAddress).toBe(walletAddress);
      expect(auth.expiresAt).toBeGreaterThan(Date.now());
      expect(mockDocClient.send).toHaveBeenCalledWith(expect.any(Object));
    });
  });

  describe('Job Management', () => {
    it('creates a job in queued status', async () => {
      mockDocClient.send.mockResolvedValueOnce({}); // PutCommand

      const property = {
        address: '123 Main St',
        city: 'Victoria',
        state: 'BC',
        zip: 'V8Z 1Y8'
      };

      const job = await propertyResearch.createJob(agentId, property);

      expect(job.status).toBe('queued');
      expect(job.property.address).toBe(property.address);
      expect(job.progress.listings).toBe('pending');
      expect(mockDocClient.send).toHaveBeenCalledWith(expect.any(Object));
    });

    it('lists job summaries for an agent', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Items: [
          { jobId: 'job-1', status: 'completed', createdAt: 1000, agentId, property: { address: 'A' } },
          { jobId: 'job-2', status: 'queued', createdAt: 2000, agentId, property: { address: 'B' } }
        ]
      });

      const jobs = await propertyResearch.getJobsForAgent(agentId);

      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe('job-2'); // Sorted by createdAt desc
      expect(jobs[1].jobId).toBe('job-1');
    });

    it('updates job status and progress', async () => {
      // Mock getJob
      mockDocClient.send.mockResolvedValueOnce({
        Item: { jobId: 'job-1', createdAt: 1000, status: 'queued' }
      });
      // Mock UpdateCommand
      mockDocClient.send.mockResolvedValueOnce({});

      await propertyResearch.updateJobStatus('job-1', 'researching', {
        progress: {
          listings: 'in_progress',
          assessor: 'pending',
          comparables: 'pending',
          demographics: 'pending',
          schools: 'pending',
          walkability: 'pending'
        }
      });

      expect(mockDocClient.send).toHaveBeenCalledTimes(2);
      const updateCall = mocked(mockDocClient.send).mock.calls[1][0] as any;
      expect(updateCall.UpdateExpression).toContain('#status = :status');
      expect(updateCall.ExpressionAttributeValues[':status']).toBe('researching');
    });
  });
});
