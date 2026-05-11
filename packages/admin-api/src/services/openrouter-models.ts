import type { AICapability } from '../types.js';
import { AVAILABLE_MODELS, type ModelInfo } from './models-registry.js';

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_VIDEO_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/videos/models';

interface OpenRouterCatalogModel {
  id?: string;
  name?: string;
  description?: string;
  architecture?: {
    output_modalities?: string[];
  };
  output_modalities?: string[];
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    video?: string;
  };
}

interface SearchOpenRouterModelsOptions {
  apiKey?: string;
  capability?: 'image' | 'video' | AICapability;
  limit?: number;
}

function normalizeMediaCapability(
  capability?: 'image' | 'video' | AICapability,
): 'image_generation' | 'video_generation' | undefined {
  if (capability === 'image' || capability === 'image_generation') return 'image_generation';
  if (capability === 'video' || capability === 'video_generation') return 'video_generation';
  return undefined;
}

function modelMatchesQuery(model: Pick<ModelInfo, 'id' | 'name' | 'description'>, query: string): boolean {
  const q = query.toLowerCase();
  return (
    model.id.toLowerCase().includes(q) ||
    model.name.toLowerCase().includes(q) ||
    model.description.toLowerCase().includes(q)
  );
}

function hardcodedOpenRouterModels(
  query: string,
  capability?: 'image_generation' | 'video_generation',
): ModelInfo[] {
  return AVAILABLE_MODELS.filter((model) =>
    model.provider === 'openrouter' &&
    (!capability || model.capabilities.includes(capability)) &&
    modelMatchesQuery(model, query)
  );
}

function inferCapabilities(
  model: OpenRouterCatalogModel,
  requestedCapability?: 'image_generation' | 'video_generation',
): AICapability[] {
  if (requestedCapability) return [requestedCapability];

  const outputModalities = [
    ...(model.architecture?.output_modalities || []),
    ...(model.output_modalities || []),
  ].map((m) => m.toLowerCase());

  const text = `${model.id || ''} ${model.name || ''} ${model.description || ''}`.toLowerCase();
  const capabilities: AICapability[] = [];
  if (outputModalities.includes('image') || text.includes('image') || text.includes('flux')) {
    capabilities.push('image_generation');
  }
  if (outputModalities.includes('video') || text.includes('video') || text.includes('veo') || text.includes('kling') || text.includes('seedance')) {
    capabilities.push('video_generation');
  }
  return capabilities.length > 0 ? capabilities : ['image_generation'];
}

function inferTier(model: OpenRouterCatalogModel): ModelInfo['tier'] {
  const prices = Object.values(model.pricing || {})
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (prices.length === 0) return 'standard';
  return Math.max(...prices) >= 0.05 ? 'premium' : 'standard';
}

function mapOpenRouterModel(
  model: OpenRouterCatalogModel,
  requestedCapability?: 'image_generation' | 'video_generation',
): ModelInfo | null {
  if (!model.id) return null;
  return {
    id: model.id,
    name: model.name || model.id.split('/').pop() || model.id,
    provider: 'openrouter',
    capabilities: inferCapabilities(model, requestedCapability),
    description: model.description || 'OpenRouter media model',
    tier: inferTier(model),
    speed: 'medium',
    quality: 'high',
  };
}

function extractCatalogModels(payload: unknown): OpenRouterCatalogModel[] {
  if (Array.isArray(payload)) {
    return payload as OpenRouterCatalogModel[];
  }
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data as OpenRouterCatalogModel[];
    }
  }
  return [];
}

export async function searchOpenRouterModels(
  query: string,
  options: SearchOpenRouterModelsOptions = {},
): Promise<ModelInfo[]> {
  const capability = normalizeMediaCapability(options.capability);
  const limit = options.limit ?? 20;
  const endpoint = capability === 'video_generation'
    ? OPENROUTER_VIDEO_MODELS_ENDPOINT
    : `${OPENROUTER_MODELS_ENDPOINT}?output_modalities=image`;

  try {
    const headers: Record<string, string> = {};
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }

    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      throw new Error(`OpenRouter model search failed: HTTP ${response.status}`);
    }

    const models = extractCatalogModels(await response.json())
      .map((model) => mapOpenRouterModel(model, capability))
      .filter((model): model is ModelInfo => Boolean(model))
      .filter((model) => !capability || model.capabilities.includes(capability))
      .filter((model) => modelMatchesQuery(model, query));

    return models.slice(0, limit);
  } catch {
    return hardcodedOpenRouterModels(query, capability).slice(0, limit);
  }
}
