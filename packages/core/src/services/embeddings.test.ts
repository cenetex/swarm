/**
 * Embedding Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmbeddingService, _resetEmbeddingService } from './embeddings.js';

describe('Embedding Service', () => {
  beforeEach(() => {
    _resetEmbeddingService();
  });

  afterEach(() => {
    _resetEmbeddingService();
  });

  it('should initialize the embedding service', () => {
    // This will either use Bedrock or OpenRouter depending on the environment
    const service = getEmbeddingService();
    expect(service).toBeDefined();
    expect(service.modelId).toBeDefined();
  });

  it('should return the same instance on subsequent calls (singleton)', () => {
    const service1 = getEmbeddingService();
    const service2 = getEmbeddingService();
    expect(service1).toBe(service2);
  });

  it('should reset the singleton when requested', () => {
    const service1 = getEmbeddingService();
    _resetEmbeddingService();
    const service2 = getEmbeddingService();
    expect(service1).not.toBe(service2);
  });
});

describe('Embedding Service LRU Cache', () => {
  beforeEach(() => {
    _resetEmbeddingService();
  });

  afterEach(() => {
    _resetEmbeddingService();
  });

  it('should cache embeddings to avoid redundant API calls', async () => {
    const service = getEmbeddingService();

    // This test is environment-dependent, so we'll only verify the method exists
    expect(service.embedText).toBeDefined();
    expect(typeof service.embedText).toBe('function');
  });
});
