/**
 * Job Status Tools
 * 
 * Tools for tracking async media generation jobs.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface JobInfo {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt?: string;
  resultUrl?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface JobServices {
  getPendingJobs: (agentId: string) => Promise<JobInfo[]>;
  getJob: (agentId: string, jobId: string) => Promise<JobInfo | null>;
}

export interface CreditStatus {
  generate_image: { used: number; limit: number; remaining: number };
  generate_video: { used: number; limit: number; remaining: number };
  generate_sticker: { used: number; limit: number; remaining: number };
}

export interface CreditServices {
  getToolStatus: (agentId: string) => Promise<CreditStatus>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createJobTools = (
  jobServices: JobServices,
  creditServices: CreditServices
) => [
  defineTool({
    name: 'get_pending_jobs',
    description: 'Get all pending media generation jobs.',
    category: 'readonly',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const jobs = await jobServices.getPendingJobs(context.agentId);

      return {
        success: true,
        data: jobs.map(job => ({
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          createdAt: new Date(job.createdAt).toISOString(),
          resultUrl: job.resultUrl,
        })),
      };
    },
  }),

  defineTool({
    name: 'get_job_status',
    description: 'Get the status of a specific media generation job.',
    category: 'readonly',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const job = await jobServices.getJob(context.agentId, input.jobId);

      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      const result: ToolResult = {
        success: true,
        data: {
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          error: job.error,
          createdAt: new Date(job.createdAt).toISOString(),
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : undefined,
        },
      };

      // If job completed with media, include it
      if (job.status === 'completed' && job.resultUrl) {
        result.media = {
          type: job.type === 'video' ? 'video' : 'image',
          url: job.resultUrl,
          caption: job.prompt,
        };
      }

      return result;
    },
  }),

  defineTool({
    name: 'get_tool_credits',
    description: 'Check my remaining credits for media generation tools.',
    category: 'readonly',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const status = await creditServices.getToolStatus(context.agentId);

      return {
        success: true,
        data: {
          generate_image: status.generate_image,
          generate_video: status.generate_video,
          generate_sticker: status.generate_sticker,
        },
      };
    },
  }),
];

export default createJobTools;
