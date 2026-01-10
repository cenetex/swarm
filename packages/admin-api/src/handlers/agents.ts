/**
 * Agent Management API Handler
 * REST endpoints for creating and managing agents
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as agentService from '../services/agents.js';
import * as secretsService from '../services/secrets.js';

// CORS headers - restricted to configured admin domain
const allowedOrigin = process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * Lambda handler for agent management API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate
    const session = await authenticateRequest(event);
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const method = event.requestContext.http.method;
    const path = event.rawPath;

    // POST /agents - Create a new agent
    if (method === 'POST' && path === '/agents') {
      const body = JSON.parse(event.body || '{}');
      const { name, description } = body;

      if (!name || typeof name !== 'string') {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Name is required' }),
        };
      }

      const agent = await agentService.createAgent(name, session, description);

      return {
        statusCode: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // GET /agents - List all agents
    if (method === 'GET' && path === '/agents') {
      const agents = await agentService.listAgents();

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agents),
      };
    }

    // GET /agents/{id} - Get single agent
    const agentIdMatch = path.match(/^\/agents\/([^/]+)$/);
    if (method === 'GET' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      const agent = await agentService.getAgent(agentId);

      if (!agent) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Agent not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // PUT /agents/{id} - Update agent
    if (method === 'PUT' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      const body = JSON.parse(event.body || '{}');

      const agent = await agentService.updateAgent(agentId, body, session);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // DELETE /agents/{id} - Delete agent
    if (method === 'DELETE' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      await agentService.deleteAgent(agentId, session);

      return {
        statusCode: 204,
        headers: corsHeaders,
      };
    }

    // POST /agents/{id}/secrets - Save a secret for an agent
    const secretsMatch = path.match(/^\/agents\/([^/]+)\/secrets$/);
    if (method === 'POST' && secretsMatch) {
      const agentId = secretsMatch[1];
      const body = JSON.parse(event.body || '{}');
      const { key, value } = body;

      if (!key || !value) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'key and value are required' }),
        };
      }

      await secretsService.storeSecret(
        agentId,
        key,
        'default',
        value,
        session,
        `${key} for agent ${agentId}`
      );

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: `${key} stored securely` }),
      };
    }

    // GET /agents/{id}/secrets - List secrets (not values)
    if (method === 'GET' && secretsMatch) {
      const agentId = secretsMatch[1];
      const secrets = await secretsService.listSecrets(agentId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(secrets),
      };
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    console.error('Agent handler error:', error);

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
