import { existsSync, mkdirSync, statSync } from 'fs';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import type { EmbeddingResult, EmbeddingService as CoreEmbeddingService } from '@swarm/core';
import type { EmbeddingService as AdminEmbeddingService } from '../../admin-api/src/services/embedding.js';

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;

const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;

export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = 'bge-small-en-v1.5-q8_0';
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_LOCAL_EMBEDDING_MODEL_FILE = 'bge-small-en-v1.5-q8_0.gguf';
export const DEFAULT_LOCAL_EMBEDDING_MODEL_URL =
  'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf';

const MAX_INPUT_CHARS = 8000;

export interface LocalLlamaEmbeddingOptions {
  modelPath?: string;
  modelUrl?: string;
  modelId?: string;
  dimensions?: number;
}

export interface LocalLlamaEmbeddingStatus {
  provider: 'llama.cpp';
  enabled: boolean;
  ready: boolean;
  packageAvailable?: boolean;
  modelExists: boolean;
  modelPath: string;
  modelId: string;
  dimensions: number;
  downloadUrl: string;
  error?: string;
}

interface LlamaEmbeddingContext {
  getEmbeddingFor(text: string): Promise<{ vector: Float32Array | number[] }>;
}

interface LoadedEmbeddingRuntime {
  context: LlamaEmbeddingContext;
}

export type LocalEmbeddingService = CoreEmbeddingService &
  AdminEmbeddingService & {
    readonly provider: 'llama.cpp';
    status(checkPackage?: boolean): Promise<LocalLlamaEmbeddingStatus>;
    prepare(sampleText?: string): Promise<LocalLlamaEmbeddingStatus & { sampleVectorLength?: number }>;
  };

function appSupportDir(): string {
  const home = process.env.HOME ?? '/tmp';
  return join(home, 'Library', 'Application Support', 'Swarm');
}

export function getDefaultLocalEmbeddingModelPath(): string {
  return join(appSupportDir(), 'models', 'embeddings', DEFAULT_LOCAL_EMBEDDING_MODEL_FILE);
}

export function localLlamaEmbeddingsEnabled(): boolean {
  return process.env.SWARM_LOCAL_EMBEDDINGS !== '0';
}

function resolveOptions(options: LocalLlamaEmbeddingOptions = {}): Required<LocalLlamaEmbeddingOptions> {
  return {
    modelPath:
      options.modelPath ||
      process.env.SWARM_LOCAL_EMBEDDING_MODEL_PATH ||
      getDefaultLocalEmbeddingModelPath(),
    modelUrl:
      options.modelUrl ||
      process.env.SWARM_LOCAL_EMBEDDING_MODEL_URL ||
      DEFAULT_LOCAL_EMBEDDING_MODEL_URL,
    modelId:
      options.modelId ||
      process.env.SWARM_LOCAL_EMBEDDING_MODEL_ID ||
      DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
    dimensions:
      options.dimensions ||
      Number(process.env.SWARM_LOCAL_EMBEDDING_DIMENSIONS || DEFAULT_LOCAL_EMBEDDING_DIMENSIONS),
  };
}

async function nodeLlamaCppAvailable(): Promise<boolean> {
  try {
    await dynamicImport('node-llama-cpp');
    return true;
  } catch {
    return false;
  }
}

async function ensureDownloaded(path: string, url: string): Promise<void> {
  if (existsSync(path) && statSync(path).size > 0) return;

  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await rm(tmpPath, { force: true }).catch(() => undefined);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download embedding model: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('Downloaded embedding model was empty');

  await writeFile(tmpPath, bytes);
  await rename(tmpPath, path);
}

async function fileSha256(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export class LocalLlamaEmbeddingService implements LocalEmbeddingService {
  readonly provider = 'llama.cpp' as const;
  readonly modelId: string;
  readonly dimensions: number;

  private readonly modelPath: string;
  private readonly modelUrl: string;
  private runtimePromise: Promise<LoadedEmbeddingRuntime> | null = null;
  private readonly cache = new Map<string, number[]>();

  constructor(options: LocalLlamaEmbeddingOptions = {}) {
    const resolved = resolveOptions(options);
    this.modelPath = resolved.modelPath;
    this.modelUrl = resolved.modelUrl;
    this.modelId = resolved.modelId;
    this.dimensions = resolved.dimensions;
  }

  async embedText(text: string): Promise<EmbeddingResult> {
    const vector = await this.embed(text);
    return {
      vector,
      model: this.modelId,
    };
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.slice(0, MAX_INPUT_CHARS);
    const cacheKey = `${this.modelId}:${normalized}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const { context } = await this.loadRuntime();
    const result = await context.getEmbeddingFor(normalized);
    const vector = Array.from(result.vector);
    if (vector.length !== this.dimensions) {
      throw new Error(`Local embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`);
    }
    this.cache.set(cacheKey, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  async status(checkPackage = false): Promise<LocalLlamaEmbeddingStatus> {
    const modelExists = existsSync(this.modelPath) && statSync(this.modelPath).size > 0;
    let packageAvailable: boolean | undefined;
    let error: string | undefined;
    if (checkPackage) {
      packageAvailable = await nodeLlamaCppAvailable();
      if (!packageAvailable) error = 'node-llama-cpp is not installed';
    }
    return {
      provider: 'llama.cpp',
      enabled: localLlamaEmbeddingsEnabled(),
      ready: modelExists && (packageAvailable ?? true),
      ...(packageAvailable !== undefined ? { packageAvailable } : {}),
      modelExists,
      modelPath: this.modelPath,
      modelId: this.modelId,
      dimensions: this.dimensions,
      downloadUrl: this.modelUrl,
      ...(error ? { error } : {}),
    };
  }

  async prepare(sampleText = 'Swarm local semantic memory'): Promise<LocalLlamaEmbeddingStatus & { sampleVectorLength?: number }> {
    await ensureDownloaded(this.modelPath, this.modelUrl);
    const vector = await this.embed(sampleText);
    const status = await this.status(true);
    return {
      ...status,
      ready: true,
      sampleVectorLength: vector.length,
    };
  }

  async modelSha256(): Promise<string | undefined> {
    return fileSha256(this.modelPath);
  }

  private async loadRuntime(): Promise<LoadedEmbeddingRuntime> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = this.createRuntime();
    return this.runtimePromise;
  }

  private async createRuntime(): Promise<LoadedEmbeddingRuntime> {
    await ensureDownloaded(this.modelPath, this.modelUrl);
    const mod = await dynamicImport('node-llama-cpp');
    const getLlama = mod.getLlama as undefined | (() => Promise<{
      loadModel(options: { modelPath: string }): Promise<{
        createEmbeddingContext(): Promise<LlamaEmbeddingContext>;
      }>;
    }>);
    if (typeof getLlama !== 'function') {
      throw new Error('node-llama-cpp does not expose getLlama()');
    }

    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: this.modelPath });
    const context = await model.createEmbeddingContext();
    return { context };
  }
}

export function createLocalLlamaEmbeddingService(options?: LocalLlamaEmbeddingOptions): LocalLlamaEmbeddingService {
  return new LocalLlamaEmbeddingService(options);
}
