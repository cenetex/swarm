/**
 * Embedding Service — Generate text embeddings for semantic search
 *
 * Provides LRU caching (200 entries, 5min TTL) to avoid redundant API calls.
 * Supports OpenAI text-embedding-3-small via OpenRouter and AWS Bedrock Titan.
 *
 * @module embeddings
 */

import { logger } from '../utils/index.js';

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingResult {
  vector: number[];
  model: string;
}

export interface EmbeddingService {
  embedText(text: string): Promise<EmbeddingResult>;
  readonly modelId: string;
}

// ============================================================================
// LRU Cache
// ============================================================================

interface CacheEntry {
  vector: number[];
  model: string;
  timestamp: number;
}

class LRUCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize = 200;
  private readonly ttlMs = 5 * 60 * 1000; // 5 minutes

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const ageMs = Date.now() - entry.timestamp;
    if (ageMs > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  set(key: string, value: CacheEntry): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ============================================================================
// OpenRouter Service (OpenAI text-embedding-3-small)
// ============================================================================

class OpenRouterEmbeddingService implements EmbeddingService {
  private apiKey: string;
  private cache = new LRUCache();
  readonly modelId = 'openai/text-embedding-3-small';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embedText(text: string): Promise<EmbeddingResult> {
    const cacheKey = `openrouter:${text}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { vector: cached.vector, model: cached.model };
    }

    const truncated = text.slice(0, 8000);

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
        throw new Error(`OpenRouter error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      if (!data.data?.[0]?.embedding) {
        throw new Error('Invalid embedding response');
      }

      const vector = data.data[0].embedding;
      this.cache.set(cacheKey, { vector, model: this.modelId, timestamp: Date.now() });

      return { vector, model: this.modelId };
    } catch (error) {
      logger.error('OpenRouter embedding error', {
        event: 'embedding_error',
        provider: 'openrouter',
        model: this.modelId,
        inputLength: truncated.length,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw error;
    }
  }
}

// ============================================================================
// Bedrock Service (Titan Embeddings)
// ============================================================================

class BedrockEmbeddingService implements EmbeddingService {
  private cache = new LRUCache();
  readonly modelId = 'amazon.titan-embed-text-v2:0';

  async embedText(text: string): Promise<EmbeddingResult> {
    const cacheKey = `bedrock:${text}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { vector: cached.vector, model: cached.model };
    }

    const truncated = text.slice(0, 8000);

    try {
      // Lazy-load Bedrock client only if needed
      const { BedrockRuntimeClient, InvokeModelCommand } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const client = new BedrockRuntimeClient({ region: 'us-east-1' });
      const response = await client.send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: truncated,
            dimensions: 1024,
            normalize: true,
          }),
        })
      );

      const result = JSON.parse(new TextDecoder().decode(response.body));

      if (!result.embedding || !Array.isArray(result.embedding)) {
        throw new Error('Invalid Bedrock embedding response');
      }

      const vector = result.embedding as number[];
      this.cache.set(cacheKey, { vector, model: this.modelId, timestamp: Date.now() });

      return { vector, model: this.modelId };
    } catch (error) {
      logger.error('Bedrock embedding error', {
        event: 'embedding_error',
        provider: 'bedrock',
        model: this.modelId,
        inputLength: truncated.length,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw error;
    }
  }
}

// ============================================================================
// Factory & Singleton
// ============================================================================

let _embeddingService: EmbeddingService | null = null;

/**
 * Create an embedding service with fallback chain
 * 1. Try Bedrock (uses IAM, no API key needed)
 * 2. Fall back to OpenRouter if OPENROUTER_API_KEY is available
 */
function createEmbeddingService(): EmbeddingService {
  // Try Bedrock first
  try {
    const service = new BedrockEmbeddingService();
    logger.info('Embedding service created', {
      event: 'embedding_service_initialized',
      provider: 'bedrock',
      model: service.modelId,
    });
    return service;
  } catch (error) {
    logger.warn('Bedrock unavailable for embeddings', {
      event: 'embedding_service_bedrock_unavailable',
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }

  // Fall back to OpenRouter
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
  if (apiKey) {
    const service = new OpenRouterEmbeddingService(apiKey);
    logger.info('Embedding service created', {
      event: 'embedding_service_initialized',
      provider: 'openrouter',
      model: service.modelId,
    });
    return service;
  }

  throw new Error('No embedding provider available: Bedrock and OpenRouter unavailable');
}

/**
 * Get or create the default embedding service (singleton)
 */
export function getEmbeddingService(): EmbeddingService {
  if (!_embeddingService) {
    _embeddingService = createEmbeddingService();
  }
  return _embeddingService;
}

/**
 * Reset the embedding service (for testing)
 */
export function _resetEmbeddingService(): void {
  _embeddingService = null;
}
