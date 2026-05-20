import { isUsableOpenRouterModelId } from '../../utils/openrouter-model-id.js';
import type { AICapability } from './types.js';

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_VIDEO_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/videos/models';
const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;

export type OpenRouterMediaCapability = 'image_generation' | 'video_generation';

export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  description: string;
  architecture?: {
    output_modalities?: string[];
    modality?: string;
  };
  output_modalities?: string[];
  supported_parameters?: string[];
  pricing?: Record<string, string | undefined>;
  pricing_skus?: Record<string, string | undefined>;
}

interface CatalogCacheEntry {
  expiresAt: number;
  models: OpenRouterCatalogModel[];
}

interface ListOpenRouterMediaModelsOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
}

const catalogCache = new Map<OpenRouterMediaCapability, CatalogCacheEntry>();

export function clearOpenRouterMediaCatalogCache(): void {
  catalogCache.clear();
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCatalogTtlMs(): number {
  return parsePositiveInt(process.env.OPENROUTER_MEDIA_CATALOG_TTL_MS, DEFAULT_CATALOG_TTL_MS);
}

export function normalizeOpenRouterMediaCapability(
  capability: AICapability,
): OpenRouterMediaCapability | undefined {
  if (capability === 'image_generation' || capability === 'video_generation') {
    return capability;
  }
  return undefined;
}

function extractCatalogModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function normalizeCatalogModel(value: unknown): OpenRouterCatalogModel | null {
  if (!value || typeof value !== 'object') return null;
  const model = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    architecture?: OpenRouterCatalogModel['architecture'];
    output_modalities?: unknown;
    supported_parameters?: unknown;
    pricing?: OpenRouterCatalogModel['pricing'];
    pricing_skus?: OpenRouterCatalogModel['pricing_skus'];
  };
  if (!isUsableOpenRouterModelId(model.id)) return null;

  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.trim()
      ? model.name
      : model.id.split('/').pop() || model.id,
    description: typeof model.description === 'string' ? model.description : '',
    architecture: model.architecture,
    output_modalities: Array.isArray(model.output_modalities)
      ? model.output_modalities.filter((item): item is string => typeof item === 'string')
      : undefined,
    supported_parameters: Array.isArray(model.supported_parameters)
      ? model.supported_parameters.filter((item): item is string => typeof item === 'string')
      : undefined,
    pricing: model.pricing,
    pricing_skus: model.pricing_skus,
  };
}

function isImageCatalogModel(model: OpenRouterCatalogModel): boolean {
  const outputModalities = [
    ...(model.architecture?.output_modalities || []),
    ...(model.output_modalities || []),
  ].map((value) => value.toLowerCase());
  const modality = model.architecture?.modality?.toLowerCase() || '';
  const text = `${model.id} ${model.name} ${model.description}`.toLowerCase();

  return (
    outputModalities.includes('image') ||
    modality.includes('image') ||
    text.includes('image') ||
    text.includes('banana')
  );
}

function isVideoCatalogModel(model: OpenRouterCatalogModel): boolean {
  const text = `${model.id} ${model.name} ${model.description}`.toLowerCase();
  return text.includes('video') || text.includes('veo') || text.includes('kling');
}

function modelSupportsCapability(
  model: OpenRouterCatalogModel,
  capability: OpenRouterMediaCapability,
): boolean {
  return capability === 'image_generation'
    ? isImageCatalogModel(model)
    : isVideoCatalogModel(model);
}

function catalogEndpoint(capability: OpenRouterMediaCapability): string {
  return capability === 'video_generation'
    ? OPENROUTER_VIDEO_MODELS_ENDPOINT
    : `${OPENROUTER_MODELS_ENDPOINT}?output_modalities=image`;
}

export async function listOpenRouterMediaModels(
  capability: OpenRouterMediaCapability,
  options: ListOpenRouterMediaModelsOptions = {},
): Promise<OpenRouterCatalogModel[]> {
  const cached = catalogCache.get(capability);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  const headers: Record<string, string> = {};
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(catalogEndpoint(capability), { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter ${capability} model catalog unavailable: HTTP ${response.status}`);
  }

  const models = extractCatalogModels(await response.json())
    .map(normalizeCatalogModel)
    .filter((model): model is OpenRouterCatalogModel => Boolean(model))
    .filter((model) => modelSupportsCapability(model, capability));

  if (models.length === 0) {
    throw new Error(`OpenRouter ${capability} model catalog returned no usable models`);
  }

  catalogCache.set(capability, {
    models,
    expiresAt: Date.now() + getCatalogTtlMs(),
  });
  return models;
}

function scorePreferredImageModel(model: OpenRouterCatalogModel): number {
  const text = `${model.id} ${model.name}`.toLowerCase();
  if (text.includes('nano banana pro')) return 100;
  if (text.includes('gemini-3-pro-image')) return 95;
  if (text.includes('nano banana 2')) return 90;
  if (text.includes('gemini-3.1-flash-image')) return 85;
  if (text.includes('nano banana')) return 80;
  if (text.includes('gemini-2.5-flash-image')) return 75;
  if (text.includes('image')) return 10;
  return 0;
}

function scorePreferredVideoModel(model: OpenRouterCatalogModel): number {
  const text = `${model.id} ${model.name}`.toLowerCase();
  if (text.includes('veo 3.1 fast') || text.includes('veo-3.1-fast')) return 100;
  if (text.includes('veo 3.1') || text.includes('veo-3.1')) return 80;
  if (text.includes('video')) return 10;
  return 0;
}

export function selectPreferredOpenRouterMediaModel(
  models: OpenRouterCatalogModel[],
  capability: OpenRouterMediaCapability,
): OpenRouterCatalogModel | undefined {
  const scored = models
    .filter((model) => modelSupportsCapability(model, capability))
    .map((model, index) => ({
      model,
      index,
      score: capability === 'image_generation'
        ? scorePreferredImageModel(model)
        : scorePreferredVideoModel(model),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored[0]?.model;
}

export async function resolveDefaultOpenRouterMediaModel(
  capability: OpenRouterMediaCapability,
  options: ListOpenRouterMediaModelsOptions = {},
): Promise<OpenRouterCatalogModel> {
  const models = await listOpenRouterMediaModels(capability, options);
  const selected = selectPreferredOpenRouterMediaModel(models, capability);
  if (!selected) {
    throw new Error(`OpenRouter ${capability} model catalog returned no selectable default`);
  }
  return selected;
}

export async function isLiveOpenRouterMediaModelId(
  capability: OpenRouterMediaCapability,
  modelId: string,
  options: ListOpenRouterMediaModelsOptions = {},
): Promise<boolean> {
  if (!isUsableOpenRouterModelId(modelId)) return false;
  const models = await listOpenRouterMediaModels(capability, options);
  return models.some((model) => model.id === modelId);
}
