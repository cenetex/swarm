/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Jobs Handler
 * Lightweight endpoint for polling media job status
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { isAuthError } from '../auth/errors.js';
import * as mediaJobs from '../services/media-jobs.js';
import * as chatJobs from '../services/chat-jobs.js';
import * as avatars from '../services/avatars.js';
import { getCorsHeaders } from '../http/cors.js';

/**
 * Lambda handler for job status API.
 *
 * Admins can poll any job; non-admin wallet users can poll jobs only for
 * avatars they own.
 *
 * - GET /jobs/{jobId} - Get job status
 * - GET /jobs?avatarId=xxx - List pending jobs for an avatar
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);

    const isAdmin = requireAdmin(session);

    const ensureAvatarAccess = async (avatarId: string | undefined | null): Promise<APIGatewayProxyStructuredResultV2 | null> => {
      if (isAdmin) return null;

      if (!avatarId) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId is required' }),
        };
      }

      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      const walletAddress = session.userId;
      if (!walletAddress || avatar.creatorWallet !== walletAddress) {
        // Hide existence when the user doesn't have access.
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      return null;
    };

    // Check for jobId in path parameters
    const jobId = event.pathParameters?.jobId;

    if (jobId) {
      // GET /jobs/{jobId} - Get specific job status
      const mediaJob = await mediaJobs.getJob(jobId);
      if (mediaJob) {
        const accessError = await ensureAvatarAccess(mediaJob.avatarId);
        if (accessError) {
          // Hide existence if unauthorized.
          if (accessError.statusCode === 400) return accessError;
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
            jobId: mediaJob.jobId,
            type: mediaJob.type,
            status: mediaJob.status,
            prompt: mediaJob.prompt,
            createdAt: mediaJob.createdAt,
            updatedAt: mediaJob.updatedAt,
            completedAt: mediaJob.completedAt,
            resultUrl: mediaJob.resultUrl,
            // Add 'url' alias for frontend compatibility
            url: mediaJob.resultUrl,
            error: mediaJob.error,
          }),
        };
      }

      const chatJob = await chatJobs.getChatJob(jobId);

      if (!chatJob) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Job not found' }),
        };
      }

      const accessError = await ensureAvatarAccess(chatJob.avatarId);
      if (accessError) {
        // Hide existence if unauthorized.
        if (accessError.statusCode === 400) return accessError;
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
          jobId: chatJob.jobId,
          type: chatJob.type,
          status: chatJob.status,
          prompt: chatJob.prompt,
          createdAt: chatJob.createdAt,
          updatedAt: chatJob.updatedAt,
          completedAt: chatJob.completedAt,
          error: chatJob.error,
          response: chatJob.result?.response,
          history: chatJob.result?.history,
          media: chatJob.result?.media,
          pendingJobs: chatJob.result?.pendingJobs,
          pendingToolCall: chatJob.result?.pendingToolCall,
          avatarUpdates: chatJob.result?.avatarUpdates,
        }),
      };
    }

    // GET /jobs?avatarId=xxx - List pending jobs for an avatar
    const avatarId = event.queryStringParameters?.avatarId;

    if (!avatarId) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'avatarId query parameter required' }),
      };
    }

    const accessError = await ensureAvatarAccess(avatarId);
    if (accessError) return accessError;

    const [mediaPending, chatPending] = await Promise.all([
      mediaJobs.getPendingJobs(avatarId),
      chatJobs.getPendingChatJobs(avatarId),
    ]);

    const jobs = [
      ...mediaPending.map(job => ({
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        prompt: job.prompt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        resultUrl: job.resultUrl,
        url: job.resultUrl,
      })),
      ...chatPending.map(job => ({
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        prompt: job.prompt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    ];

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: jobs.length,
        jobs,
      }),
    };
  } catch (error) {
    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Treat missing/expired sessions as auth failures (not 500s)
    if (errorMessage === 'No authentication token provided' || errorMessage === 'Session expired') {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errorMessage }),
      };
    }

    console.error('Jobs handler error:', error instanceof Error ? error.message : String(error));

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: errorMessage,
        requestId: event.requestContext.requestId,
      }),
    };
  }
}
