/**
 * Embedding Service - Generate vector embeddings for semantic search
 *
 * Primary: AWS Bedrock Titan Embeddings v2 (1024 dimensions)
 * Fallback: OpenAI text-embedding-3-small via OpenRouter
 *
 * @module embedding
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { logger } from '@swarm/core';

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly modelId: string;
  readonly dimensions: number;
}

export interface EmbeddingConfig {
  provider: 'bedrock' | 'openrouter';
  model?: string;
  dimensions?: number;
  openrouterApiKey?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Current embedding model version - increment when changing models */
export const EMBEDDING_VERSION = 1;

/** Default embedding model */
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

/** Default embedding dimensions */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/** Maximum input text length (Titan limit is ~8000 tokens, ~32000 chars) */
const MAX_INPUT_LENGTH = 8000;

// ============================================================================
// Bedrock Titan Embeddings
// ============================================================================

export class BedrockEmbeddingService implements EmbeddingService {
  private client: BedrockRuntimeClient;
  readonly modelId: string;
  readonly dimensions: number;

  constructor(config: Partial<EmbeddingConfig> = {}) {
    this.client = new BedrockRuntimeClient({ region: 'us-east-1' });
    this.modelId = config.model || DEFAULT_EMBEDDING_MODEL;
    this.dimensions = config.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, MAX_INPUT_LENGTH);

    try {
      const response = await this.client.send(new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: truncated,
          dimensions: this.dimensions,
          normalize: true,
        }),
      }));

      const result = JSON.parse(new TextDecoder().decode(response.body));

      if (!result.embedding || !Array.isArray(result.embedding)) {
        throw new Error('Invalid embedding response from Bedrock');
      }

      return result.embedding as number[];
    } catch (error) {
      logger.error('Bedrock embedding error', {
        event: 'embedding_error',
        provider: 'bedrock',
        model: this.modelId,
        inputLength: truncated.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Titan doesn't support batch API, so parallelize with concurrency limit
    const BATCH_SIZE = 5;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...embeddings);

      // Small delay between batches to avoid throttling
      if (i + BATCH_SIZE < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }
}

// ============================================================================
// OpenRouter Embeddings (OpenAI text-embedding-3-small)
// ============================================================================

export class OpenRouterEmbeddingService implements EmbeddingService {
  private apiKey: string;
  readonly modelId: string;
  readonly dimensions: number;

  constructor(apiKey: string, model: string = 'openai/text-embedding-3-small') {
    this.apiKey = apiKey;
    this.modelId = model;
    this.dimensions = 1536; // OpenAI embedding dimensions
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, MAX_INPUT_LENGTH);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://swarm.ai',
          'X-Title': 'Swarm Memory',
        },
        body: JSON.stringify({
          model: this.modelId,
          input: truncated,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter embedding error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      if (!data.data?.[0]?.embedding) {
        throw new Error('Invalid embedding response from OpenRouter');
      }

      return data.data[0].embedding;
    } catch (error) {
      logger.error('OpenRouter embedding error', {
        event: 'embedding_error',
        provider: 'openrouter',
        model: this.modelId,
        inputLength: truncated.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // OpenRouter supports batch embeddings
    const truncated = texts.map(t => t.slice(0, MAX_INPUT_LENGTH));

    try {
      const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://swarm.ai',
          'X-Title': 'Swarm Memory',
        },
        body: JSON.stringify({
          model: this.modelId,
          input: truncated,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter batch embedding error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => d.embedding);
    } catch (error) {
      logger.error('OpenRouter batch embedding error', {
        event: 'embedding_batch_error',
        provider: 'openrouter',
        model: this.modelId,
        batchSize: texts.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let _embeddingService: EmbeddingService | null = null;

/**
 * Create an embedding service with fallback
 *
 * Tries Bedrock first, falls back to OpenRouter if available
 */
export function createEmbeddingService(
  secrets: Record<string, string> = {}
): EmbeddingService {
  // Try Bedrock first (no API key needed, uses IAM)
  try {
    const service = new BedrockEmbeddingService();
    logger.info('Using Bedrock embedding service', {
      event: 'embedding_service_created',
      provider: 'bedrock',
      model: service.modelId,
    });
    return service;
  } catch (error) {
    logger.warn('Bedrock embedding unavailable', {
      event: 'embedding_service_fallback',
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }

  // Fall back to OpenRouter
  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];
  if (apiKey) {
    const service = new OpenRouterEmbeddingService(apiKey);
    logger.info('Using OpenRouter embedding service', {
      event: 'embedding_service_created',
      provider: 'openrouter',
      model: service.modelId,
    });
    return service;
  }

  throw new Error('No embedding service available: Bedrock failed and no OpenRouter API key');
}

/**
 * Get or create the default embedding service (singleton)
 */
export function getEmbeddingService(
  secrets: Record<string, string> = {}
): EmbeddingService {
  if (!_embeddingService) {
    _embeddingService = createEmbeddingService(secrets);
  }
  return _embeddingService;
}

/**
 * Override the embedding service.
 *
 * Local-first runtimes inject an embedded llama.cpp provider here so memory
 * embeddings stay on-device without changing hosted AWS behavior.
 */
export function _setEmbeddingService(service: EmbeddingService | null): void {
  _embeddingService = service;
}

/**
 * Reset the embedding service (for testing)
 */
export function _resetEmbeddingService(): void {
  _embeddingService = null;
}

// ============================================================================
// Similarity Functions
// ============================================================================

/**
 * Compute cosine similarity between two vectors
 *
 * @returns Similarity score between -1 and 1 (1 = identical, 0 = orthogonal)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    logger.warn('Cosine similarity dimension mismatch', {
      event: 'cosine_similarity_mismatch',
      dimA: a.length,
      dimB: b.length,
    });
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Find the most similar vectors to a query
 *
 * @param query - Query vector
 * @param candidates - Array of candidate vectors with IDs
 * @param topK - Number of results to return
 * @param minSimilarity - Minimum similarity threshold
 * @returns Array of {id, similarity} sorted by similarity descending
 */
export function findSimilar<T extends { id: string; embedding: number[] }>(
  query: number[],
  candidates: T[],
  topK: number = 10,
  minSimilarity: number = 0.3
): Array<{ item: T; similarity: number }> {
  const scored = candidates
    .map(item => ({
      item,
      similarity: cosineSimilarity(query, item.embedding),
    }))
    .filter(({ similarity }) => similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);

  return scored;
}
