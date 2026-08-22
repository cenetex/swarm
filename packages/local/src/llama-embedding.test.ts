import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  LocalLlamaEmbeddingService,
  localLlamaEmbeddingsEnabled,
} from './llama-embedding.js';

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.SWARM_LOCAL_EMBEDDINGS;
  delete process.env.SWARM_LOCAL_EMBEDDING_MODEL_PATH;
  delete process.env.SWARM_LOCAL_EMBEDDING_MODEL_ID;
  delete process.env.SWARM_LOCAL_EMBEDDING_DIMENSIONS;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local llama.cpp embeddings', () => {
  it('is enabled by default and can be disabled with env', () => {
    expect(localLlamaEmbeddingsEnabled()).toBe(true);
    process.env.SWARM_LOCAL_EMBEDDINGS = '0';
    expect(localLlamaEmbeddingsEnabled()).toBe(false);
  });

  it('reports model status without loading native llama.cpp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-embedding-test-'));
    tempDirs.push(dir);
    const modelPath = join(dir, 'model.gguf');
    const service = new LocalLlamaEmbeddingService({ modelPath });

    const missing = await service.status(false);
    expect(missing.provider).toBe('llama.cpp');
    expect(missing.modelId).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
    expect(missing.dimensions).toBe(DEFAULT_LOCAL_EMBEDDING_DIMENSIONS);
    expect(missing.modelExists).toBe(false);
    expect(missing.ready).toBe(false);

    writeFileSync(modelPath, 'not a real gguf');
    const present = await service.status(false);
    expect(present.modelExists).toBe(true);
    expect(present.ready).toBe(true);
  });
});
