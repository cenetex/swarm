/**
 * Jobs Handler
 * Lightweight endpoint for polling media job status
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as mediaJobs from '../services/media-jobs.js';

/**
 * Lambda handler for job status API
 * GET /jobs/{jobId} - Get job status
 * GET /jobs?agentId=xxx - List pending jobs for an agent
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // CORS headers
  const allowedOrigin = process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
  };

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);

    // Require admin access
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Check for jobId in path parameters
    const jobId = event.pathParameters?.jobId;

    if (jobId) {
      // GET /jobs/{jobId} - Get specific job status
      const job = await mediaJobs.getJob(jobId);

      if (!job) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Job not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
          resultUrl: job.resultUrl,
          error: job.error,
        }),
      };
    }

    // GET /jobs?agentId=xxx - List pending jobs for an agent
    const agentId = event.queryStringParameters?.agentId;

    if (!agentId) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'agentId query parameter required' }),
      };
    }

    const jobs = await mediaJobs.getPendingJobs(agentId);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: jobs.length,
        jobs: jobs.map(job => ({
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          resultUrl: job.resultUrl,
        })),
      }),
    };
  } catch (error) {
    console.error('Jobs handler error:', error);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
