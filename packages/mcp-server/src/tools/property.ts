/**
 * Property Research Tools
 *
 * MCP tools for property research functionality.
 * Uses web search to gather publicly available property information.
 */
import { z } from 'zod';
import { defineTool, defineReadonlyTool, defineManualTool, type ToolResult } from '../registry.js';

// =============================================================================
// Service Interface
// =============================================================================

export interface PropertyAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

export interface ResearchProgress {
  listings: 'pending' | 'in_progress' | 'done' | 'failed';
  assessor: 'pending' | 'in_progress' | 'done' | 'failed';
  comparables: 'pending' | 'in_progress' | 'done' | 'failed';
  demographics: 'pending' | 'in_progress' | 'done' | 'failed';
  schools: 'pending' | 'in_progress' | 'done' | 'failed';
  walkability: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface PropertyResearchJob {
  jobId: string;
  agentId: string;
  property: PropertyAddress;
  status: 'queued' | 'researching' | 'completed' | 'failed';
  progress: ResearchProgress;
  reportMarkdown?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface PropertyServices {
  // Authorization
  checkAuth: (agentId: string, walletAddress: string) => Promise<boolean>;
  grantAuth: (agentId: string, walletAddress: string) => Promise<void>;
  revokeAuth: (agentId: string, walletAddress: string) => Promise<void>;

  // Job management
  createJob: (agentId: string, property: PropertyAddress, requestedBy?: string) => Promise<PropertyResearchJob>;
  getJob: (jobId: string) => Promise<PropertyResearchJob | null>;
  getJobsForAgent: (agentId: string, statusFilter?: string) => Promise<PropertyResearchJob[]>;
  deleteJob: (jobId: string) => Promise<void>;

  // Research execution
  executeResearch: (jobId: string) => Promise<PropertyResearchJob | null>;
}

// =============================================================================
// Tool Definitions
// =============================================================================

export const createPropertyTools = (services: PropertyServices) => [
  // ---------------------------------------------------------------------------
  // Authorization Tools
  // ---------------------------------------------------------------------------

  defineManualTool({
    name: 'request_property_research',
    description:
      'Request authorization to perform property research. The user must grant permission before research can begin. Use this when the user asks you to "enable property research" or research properties.',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      reason: z
        .string()
        .default('Property research for real estate analysis')
        .describe('Why property research authorization is needed'),
    }),
  }),

  // ---------------------------------------------------------------------------
  // Job Management Tools
  // ---------------------------------------------------------------------------

  defineTool({
    name: 'add_property_to_research',
    description:
      'Add a property address to the research queue. Requires property research authorization. The property will be researched using web search to gather listings, comparables, neighborhood info, schools, and tax records.',
    category: 'property',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      address: z.string().describe('Street address (e.g., "123 Main St")'),
      city: z.string().describe('City name'),
      state: z.string().describe('State (2-letter code or full name)'),
      zip: z.string().describe('ZIP code'),
      county: z.string().optional().describe('County name (helps with assessor records)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Check authorization
        const hasAuth = await services.checkAuth(context.agentId, context.userId || '');
        if (!hasAuth) {
          return {
            success: false,
            error:
              'Property research not authorized. Please ask the user to enable property research first using the request_property_research tool.',
            data: { requiresAuth: true },
          };
        }

        // Create the research job
        const job = await services.createJob(
          context.agentId,
          {
            address: input.address,
            city: input.city,
            state: input.state,
            zip: input.zip,
            county: input.county,
          },
          context.userId
        );

        return {
          success: true,
          data: {
            jobId: job.jobId,
            status: job.status,
            property: job.property,
            message: `Property added to research queue. Job ID: ${job.jobId}`,
          },
          pendingJob: {
            jobId: job.jobId,
            type: 'property_research',
            status: job.status,
            prompt: `${input.address}, ${input.city}, ${input.state}`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to add property to research queue',
        };
      }
    },
  }),

  defineTool({
    name: 'start_property_research',
    description:
      'Start researching a queued property. This will perform web searches to gather property data and generate a report.',
    category: 'property',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to start researching'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Check authorization
        const hasAuth = await services.checkAuth(context.agentId, context.userId || '');
        if (!hasAuth) {
          return {
            success: false,
            error: 'Property research not authorized.',
          };
        }

        // Start the research
        const job = await services.executeResearch(input.jobId);

        if (!job) {
          return {
            success: false,
            error: 'Job not found',
          };
        }

        if (job.status === 'completed') {
          return {
            success: true,
            data: {
              jobId: job.jobId,
              status: job.status,
              property: job.property,
              report: job.reportMarkdown,
              message: 'Research completed successfully!',
            },
          };
        } else if (job.status === 'failed') {
          return {
            success: false,
            error: job.error || 'Research failed',
            data: {
              jobId: job.jobId,
              status: job.status,
              progress: job.progress,
            },
          };
        }

        return {
          success: true,
          data: {
            jobId: job.jobId,
            status: job.status,
            progress: job.progress,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to execute research',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_research_status',
    description: 'Get the status of a property research job, including progress and any generated report.',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to check'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const job = await services.getJob(input.jobId);

        if (!job) {
          return {
            success: false,
            error: 'Job not found',
          };
        }

        return {
          success: true,
          data: {
            jobId: job.jobId,
            status: job.status,
            property: job.property,
            progress: job.progress,
            report: job.reportMarkdown,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get job status',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'list_research_queue',
    description: 'List all property research jobs for this agent, optionally filtered by status.',
    inputSchema: z.object({
      status: z
        .enum(['queued', 'researching', 'completed', 'failed'])
        .optional()
        .describe('Filter by job status'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const jobs = await services.getJobsForAgent(context.agentId, input.status);

        return {
          success: true,
          data: {
            count: jobs.length,
            jobs: jobs.map((j) => ({
              jobId: j.jobId,
              status: j.status,
              property: j.property,
              progress: j.progress,
              createdAt: j.createdAt,
              completedAt: j.completedAt,
              hasReport: !!j.reportMarkdown,
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list research queue',
        };
      }
    },
  }),

  defineTool({
    name: 'delete_research_job',
    description: 'Delete a property research job from the queue.',
    category: 'property',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to delete'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Check authorization
        const hasAuth = await services.checkAuth(context.agentId, context.userId || '');
        if (!hasAuth) {
          return {
            success: false,
            error: 'Property research not authorized.',
          };
        }

        await services.deleteJob(input.jobId);

        return {
          success: true,
          data: {
            message: `Job ${input.jobId} deleted`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete job',
        };
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Quick Research Tool (combined add + execute)
  // ---------------------------------------------------------------------------

  defineTool({
    name: 'research_property',
    description:
      'Research a property address immediately. This is a convenience tool that adds the property to the queue and executes research in one step. Returns a comprehensive report with listings, comparables, neighborhood info, schools, and tax records.',
    category: 'property',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      address: z.string().describe('Street address (e.g., "123 Main St")'),
      city: z.string().describe('City name'),
      state: z.string().describe('State (2-letter code or full name)'),
      zip: z.string().describe('ZIP code'),
      county: z.string().optional().describe('County name (helps with assessor records)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Check authorization
        const hasAuth = await services.checkAuth(context.agentId, context.userId || '');
        if (!hasAuth) {
          return {
            success: false,
            error:
              'Property research not authorized. Please ask the user to enable property research first.',
            data: { requiresAuth: true },
          };
        }

        // Create the job
        const job = await services.createJob(
          context.agentId,
          {
            address: input.address,
            city: input.city,
            state: input.state,
            zip: input.zip,
            county: input.county,
          },
          context.userId
        );

        // Execute research immediately
        const completedJob = await services.executeResearch(job.jobId);

        if (!completedJob) {
          return {
            success: false,
            error: 'Failed to execute research',
          };
        }

        if (completedJob.status === 'completed') {
          return {
            success: true,
            data: {
              jobId: completedJob.jobId,
              status: 'completed',
              property: completedJob.property,
              report: completedJob.reportMarkdown,
            },
          };
        } else {
          return {
            success: false,
            error: completedJob.error || 'Research failed',
            data: {
              jobId: completedJob.jobId,
              status: completedJob.status,
              progress: completedJob.progress,
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to research property',
        };
      }
    },
  }),
];

export default createPropertyTools;
