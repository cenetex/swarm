/**
 * System & integration model routes.
 *
 * - GET /system/status
 * - GET /integrations/models
 * - GET /integrations/models/search
 */
import type { RouteContext } from './types.js';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { jsonResponse, parseSinceQueryParam } from './shared.js';
import * as observabilityService from '../../services/observability.js';
import * as integrationsService from '../../services/integrations.js';
import { searchReplicateModels } from '../../services/media/replicate-schema.js';
import { AVAILABLE_MODELS, type ModelInfo } from '../../services/models-registry.js';

// Module-level cache for the Replicate API key resolved from Secrets Manager.
let cachedReplicateApiKey: string | null = null;

/**
 * Resolve the Replicate API key from env vars or Secrets Manager ARN.
 * Caches the resolved value for the Lambda container lifetime.
 */
async function resolveReplicateApiKey(): Promise<string | null> {
  // Check plain env vars first (fastest path)
  const envKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (envKey) return envKey;

  // Return cached value if already resolved
  if (cachedReplicateApiKey) return cachedReplicateApiKey;

  // Resolve from Secrets Manager ARN
  const secretArn = process.env.REPLICATE_API_KEY_SECRET_ARN;
  if (!secretArn) return null;

  try {
    const secretsClient = new SecretsManagerClient({});
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    if (response.SecretString) {
      try {
        const parsed = JSON.parse(response.SecretString);
        cachedReplicateApiKey = parsed.api_key || parsed.apiKey || response.SecretString;
      } catch {
        cachedReplicateApiKey = response.SecretString;
      }
      return cachedReplicateApiKey;
    }
  } catch {
    // Fall through — caller will use hardcoded fallback
  }

  return null;
}

export async function handleSystemRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders, event, effectiveIsAdmin } = ctx;

  // GET /system/status — Admin-only system overview
  if (method === 'GET' && path === '/system/status') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const params = event.queryStringParameters || {};
    const since = parseSinceQueryParam(params.since);
    const avatarId = params.avatarId;
    const status = await observabilityService.getSystemStatus({ since, avatarId });
    return jsonResponse(corsHeaders, 200, status);
  }

  // GET /integrations/models — Centralized model catalog
  if (method === 'GET' && path === '/integrations/models') {
    const integrationParam = event.queryStringParameters?.integration;
    const allowed = ['replicate', 'openai', 'anthropic', 'openrouter'] as const;

    if (integrationParam && !allowed.includes(integrationParam as (typeof allowed)[number])) {
      return jsonResponse(corsHeaders, 400, {
        error: `Unknown integration: ${integrationParam}`,
      });
    }

    if (integrationParam) {
      const modelsByCapability = integrationsService.getAvailableModelsForIntegration(
        integrationParam as (typeof allowed)[number],
      );
      return jsonResponse(corsHeaders, 200, {
        integration: integrationParam,
        modelsByCapability,
      });
    }

    const integrations = allowed.reduce<
      Record<string, ReturnType<typeof integrationsService.getAvailableModelsForIntegration>>
    >((acc, integration) => {
      acc[integration] = integrationsService.getAvailableModelsForIntegration(integration);
      return acc;
    }, {});

    return jsonResponse(corsHeaders, 200, { integrations });
  }

  // GET /integrations/models/search — Search Replicate model catalog
  if (method === 'GET' && path === '/integrations/models/search') {
    const params = event.queryStringParameters || {};
    const query = params.q?.trim();
    const capability = params.capability;
    const integration = params.integration;

    // Currently only Replicate supports live search
    if (integration && integration !== 'replicate') {
      return jsonResponse(corsHeaders, 400, {
        error: 'Model search is currently only supported for Replicate',
      });
    }

    if (!query || query.length < 2) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Query parameter "q" must be at least 2 characters',
      });
    }

    // Get system Replicate API key from env or Secrets Manager
    const apiKey = await resolveReplicateApiKey();

    if (!apiKey) {
      // Fall back to hardcoded models filtered by query
      const filtered = filterHardcodedModels(query, capability);
      return jsonResponse(corsHeaders, 200, {
        results: filtered,
        source: 'hardcoded',
      });
    }

    try {
      // Append capability hint to improve search relevance
      const searchQuery = capability
        ? `${query} ${capability.replace(/_/g, ' ')}`
        : query;

      const { results } = await searchReplicateModels(searchQuery, apiKey);

      const mapped: ModelInfo[] = results.map((r) => ({
        id: `${r.owner}/${r.name}`,
        name: r.name,
        provider: 'replicate' as const,
        capabilities: inferCapabilities(r),
        description: r.description || '',
        tier: 'standard' as const,
        speed: 'medium' as const,
        quality: 'standard' as const,
        version: r.latest_version?.id,
      }));

      // Filter by capability if specified
      const filtered = capability
        ? mapped.filter((m) => m.capabilities.includes(capability as ModelInfo['capabilities'][number]))
        : mapped;

      return jsonResponse(corsHeaders, 200, {
        results: filtered,
        source: 'replicate_api',
      });
    } catch {
      // On API failure, fall back to hardcoded models
      const filtered = filterHardcodedModels(query, capability);
      return jsonResponse(corsHeaders, 200, {
        results: filtered,
        source: 'hardcoded',
      });
    }
  }

  return null;
}

/**
 * Infer capabilities from a Replicate model search result based on its name/description.
 */
function inferCapabilities(
  model: { name: string; description: string; owner: string },
): ModelInfo['capabilities'] {
  const text = `${model.name} ${model.description} ${model.owner}`.toLowerCase();
  const caps: ModelInfo['capabilities'] = [];

  if (
    text.includes('image') ||
    text.includes('flux') ||
    text.includes('diffusion') ||
    text.includes('sdxl') ||
    text.includes('dalle') ||
    text.includes('text-to-image') ||
    text.includes('img2img')
  ) {
    caps.push('image_generation');
  }

  if (
    text.includes('video') ||
    text.includes('animate') ||
    text.includes('motion')
  ) {
    caps.push('video_generation');
  }

  if (
    text.includes('audio') ||
    text.includes('music') ||
    text.includes('sound')
  ) {
    caps.push('audio_generation');
  }

  if (
    text.includes('tts') ||
    text.includes('text-to-speech') ||
    text.includes('voice')
  ) {
    caps.push('text_to_speech');
  }

  if (
    text.includes('transcri') ||
    text.includes('speech-to-text') ||
    text.includes('whisper') ||
    text.includes('asr')
  ) {
    caps.push('transcription');
  }

  // Default: if we can't infer, assume image generation (most common on Replicate)
  if (caps.length === 0) {
    caps.push('image_generation');
  }

  return caps;
}

/**
 * Filter hardcoded models by query string and optional capability.
 */
function filterHardcodedModels(query: string, capability?: string): ModelInfo[] {
  const q = query.toLowerCase();
  return AVAILABLE_MODELS.filter((m) => {
    const matchesQuery =
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q);
    const matchesCap = !capability || m.capabilities.includes(capability as ModelInfo['capabilities'][number]);
    const isReplicate = m.provider === 'replicate';
    return matchesQuery && matchesCap && isReplicate;
  });
}
