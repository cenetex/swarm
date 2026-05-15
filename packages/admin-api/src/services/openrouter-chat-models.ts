import { logger } from '@swarm/core';

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models?output_modalities=text';
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

interface OpenRouterCatalogModel {
  id?: string;
  name?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
}

export interface OpenRouterChatModel {
  id: string;
  name: string;
  contextLength: number;
  supportedParameters: string[];
}

export interface OpenRouterChatModelPlan {
  primaryModel: string;
  fallbackModels: string[];
  source: 'configured' | 'catalog';
}

export interface ResolveOpenRouterChatModelOptions {
  requestModel?: unknown;
  avatarModel?: unknown;
  defaultModel?: unknown;
  requireTools?: boolean;
  apiKey?: string;
  fallbackCount?: number;
}

let cachedCatalog: { expiresAt: number; models: OpenRouterChatModel[] } | null = null;

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function includesText(value?: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('text');
}

function modelSupportsText(model: OpenRouterCatalogModel): boolean {
  const outputModalities = model.architecture?.output_modalities || [];

  if (outputModalities.length > 0) {
    return outputModalities.some((modality) => modality.toLowerCase() === 'text');
  }

  if (model.architecture?.modality) {
    return includesText(model.architecture.modality);
  }
  return true;
}

function modelSupportsTools(model: OpenRouterChatModel): boolean {
  return model.supportedParameters.includes('tools') || model.supportedParameters.includes('tool_choice');
}

function mapCatalogModel(model: OpenRouterCatalogModel): OpenRouterChatModel | null {
  if (!model.id || !modelSupportsText(model)) return null;
  return {
    id: model.id,
    name: model.name || model.id,
    contextLength: typeof model.context_length === 'number' ? model.context_length : 0,
    supportedParameters: model.supported_parameters || [],
  };
}

function extractModels(payload: unknown): OpenRouterCatalogModel[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: OpenRouterCatalogModel[] }).data;
  }
  return [];
}

function scoreModel(model: OpenRouterChatModel, requireTools: boolean): number {
  let score = Math.min(model.contextLength, 1_000_000) / 1_000;
  if (modelSupportsTools(model)) score += 1_000;
  if (requireTools && !modelSupportsTools(model)) score -= 10_000;

  const searchable = `${model.id} ${model.name}`.toLowerCase();
  if (searchable.includes('free')) score -= 500;
  if (searchable.includes('preview') || searchable.includes('beta') || searchable.includes('experimental')) score -= 50;
  return score;
}

function rankedModels(models: OpenRouterChatModel[], requireTools: boolean): OpenRouterChatModel[] {
  return [...models]
    .filter((model) => !requireTools || modelSupportsTools(model))
    .sort((a, b) => {
      const scoreDelta = scoreModel(b, requireTools) - scoreModel(a, requireTools);
      if (scoreDelta !== 0) return scoreDelta;
      return a.id.localeCompare(b.id);
    });
}

export async function listOpenRouterChatModels(apiKey?: string): Promise<OpenRouterChatModel[]> {
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cachedCatalog.models;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(OPENROUTER_MODELS_ENDPOINT, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog unavailable: HTTP ${response.status}`);
  }

  const models = extractModels(await response.json())
    .map(mapCatalogModel)
    .filter((model): model is OpenRouterChatModel => Boolean(model));

  if (models.length === 0) {
    throw new Error('OpenRouter model catalog returned no chat-capable models');
  }

  cachedCatalog = { expiresAt: now + CATALOG_CACHE_TTL_MS, models };
  return models;
}

export async function resolveOpenRouterChatModelPlan(
  options: ResolveOpenRouterChatModelOptions,
): Promise<OpenRouterChatModelPlan> {
  const requireTools = options.requireTools ?? false;
  const fallbackCount = options.fallbackCount ?? 2;
  const models = await listOpenRouterChatModels(options.apiKey);
  const ranked = rankedModels(models, requireTools);
  const byId = new Map(models.map((model) => [model.id, model]));

  for (const candidate of [options.requestModel, options.avatarModel, options.defaultModel].map(normalizeModelId)) {
    if (!candidate) continue;
    const model = byId.get(candidate);
    if (model && (!requireTools || modelSupportsTools(model))) {
      return {
        primaryModel: model.id,
        fallbackModels: ranked
          .map((fallbackModel) => fallbackModel.id)
          .filter((id) => id !== model.id)
          .slice(0, fallbackCount),
        source: 'configured',
      };
    }

    logger.warn('Configured OpenRouter model is not in the live catalog; selecting a live model', {
      event: 'openrouter_model_not_in_catalog',
      model: candidate,
      requireTools,
    });
  }

  const primary = ranked[0];
  if (!primary) {
    throw new Error('OpenRouter model catalog has no model matching the request requirements');
  }

  return {
    primaryModel: primary.id,
    fallbackModels: ranked
      .slice(1, 1 + fallbackCount)
      .map((model) => model.id),
    source: 'catalog',
  };
}

export function _resetOpenRouterChatModelCache(): void {
  cachedCatalog = null;
}
