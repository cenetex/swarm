import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_LOCAL_CHAT_CONTEXT_SIZE,
  DEFAULT_LOCAL_CHAT_MODEL_ID,
  LocalLlamaChatService,
  localLlamaChatEnabled,
} from './llama-chat.js';

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.SWARM_LOCAL_CHAT;
  delete process.env.SWARM_LOCAL_CHAT_MODEL_PATH;
  delete process.env.SWARM_LOCAL_CHAT_MODEL_ID;
  delete process.env.SWARM_LOCAL_CHAT_CONTEXT_SIZE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local llama.cpp chat', () => {
  it('is enabled by default and can be disabled with env', () => {
    expect(localLlamaChatEnabled()).toBe(true);
    process.env.SWARM_LOCAL_CHAT = '0';
    expect(localLlamaChatEnabled()).toBe(false);
  });

  it('reports model status without loading native llama.cpp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-chat-test-'));
    tempDirs.push(dir);
    const modelPath = join(dir, 'model.gguf');
    const service = new LocalLlamaChatService({ modelPath });

    const missing = await service.status(false, 'http://127.0.0.1:3001/v1');
    expect(missing.provider).toBe('llama.cpp');
    expect(missing.modelId).toBe(DEFAULT_LOCAL_CHAT_MODEL_ID);
    expect(missing.contextSize).toBe(DEFAULT_LOCAL_CHAT_CONTEXT_SIZE);
    expect(missing.modelExists).toBe(false);
    expect(missing.ready).toBe(false);
    expect(missing.endpoint).toBe('http://127.0.0.1:3001/v1');

    writeFileSync(modelPath, 'not a real gguf');
    const present = await service.status(false);
    expect(present.modelExists).toBe(true);
    expect(present.ready).toBe(true);
  });
});
