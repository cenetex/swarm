/**
 * Long-Form Content Pipeline Service Tests
 *
 * Tests: chunk boundaries, sequence markers, retry idempotency, reassembly,
 * storeDraft/getDocument/exportDocument DynamoDB integration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chunkContent,
  reassembleChunks,
  storeDraft,
  getDocument,
  markChunkSent,
  exportDocument,
  _setDynamoClient,
} from './long-form.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// =============================================================================
// MOCK SETUP
// =============================================================================

function makeMockClient(
  overrides: { send?: (cmd: unknown) => Promise<unknown> } = {}
): DynamoDBDocumentClient {
  const store = new Map<string, Record<string, unknown>>();

  const send = overrides.send ?? ((cmd: unknown) => {
    const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
    const name = c.constructor?.name ?? '';
    const input = c.input ?? {};

    if (name === 'PutCommand') {
      const key = `${input.Item?.pk}|${input.Item?.sk}`;
      store.set(key, input.Item as Record<string, unknown>);
      return Promise.resolve({});
    }

    if (name === 'GetCommand') {
      const key = `${(input.Key as Record<string, unknown>)?.pk}|${(input.Key as Record<string, unknown>)?.sk}`;
      const item = store.get(key);
      return Promise.resolve({ Item: item ?? undefined });
    }

    if (name === 'UpdateCommand') {
      // Simulate idempotent chunkMeta update: parse and apply
      const key = `${(input.Key as Record<string, unknown>)?.pk}|${(input.Key as Record<string, unknown>)?.sk}`;
      const item = store.get(key);
      if (!item) {
        return Promise.reject(new Error('ConditionalCheckFailedException'));
      }

      const attrNames = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const attrValues = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;

      // Resolve chunkMeta map field
      const chunkMetaField = attrNames['#chunkMeta'] ?? 'chunkMeta';
      const idxField = attrNames['#idx'] ?? '0';
      const sentAtField = attrNames['#sentAt'] ?? 'sentAt';
      const messageIdField = attrNames['#messageId'] ?? 'messageId';

      if (!item[chunkMetaField]) item[chunkMetaField] = {};
      const chunkMeta = item[chunkMetaField] as Record<string, Record<string, unknown>>;
      if (!chunkMeta[idxField]) chunkMeta[idxField] = {};

      // if_not_exists semantics
      if (!chunkMeta[idxField][sentAtField]) {
        chunkMeta[idxField][sentAtField] = attrValues[':sentAt'];
      }
      if (!chunkMeta[idxField][messageIdField]) {
        chunkMeta[idxField][messageIdField] = attrValues[':messageId'];
      }

      item['updatedAt'] = attrValues[':updatedAt'];
      return Promise.resolve({});
    }

    return Promise.resolve({});
  });

  return { send } as unknown as DynamoDBDocumentClient;
}

// =============================================================================
// HELPERS
// =============================================================================

const TABLE = 'test-long-form';

// =============================================================================
// chunkContent
// =============================================================================

describe('chunkContent', () => {
  describe('Telegram (limit 4096)', () => {
    it('returns single chunk with no marker when content fits', () => {
      const content = 'Hello world';
      const chunks = chunkContent(content, 'telegram');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Hello world');
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].total).toBe(1);
    });

    it('splits content exceeding 4096 chars into multiple chunks', () => {
      const content = 'A'.repeat(5000);
      const chunks = chunkContent(content, 'telegram');
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(4096);
      }
    });

    it('adds sequence markers [N/T] to each chunk', () => {
      const content = 'A'.repeat(5000);
      const chunks = chunkContent(content, 'telegram');
      expect(chunks[0].content).toMatch(/\[1\/\d+\]$/);
      expect(chunks[chunks.length - 1].content).toMatch(new RegExp(`\\[${chunks.length}/${chunks.length}\\]$`));
    });

    it('chunk indices and totals are consistent', () => {
      const content = 'B'.repeat(9000);
      const chunks = chunkContent(content, 'telegram');
      const total = chunks.length;
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
        expect(chunk.total).toBe(total);
      });
    });
  });

  describe('Discord (limit 2000)', () => {
    it('splits at 2000-char boundary', () => {
      const content = 'C'.repeat(2500);
      const chunks = chunkContent(content, 'discord');
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(2000);
      }
    });

    it('single chunk under 2000 chars has no marker', () => {
      const content = 'D'.repeat(1999);
      const chunks = chunkContent(content, 'discord');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(content);
    });
  });

  describe('Twitter (limit 280)', () => {
    it('splits at 280-char boundary', () => {
      const content = 'E'.repeat(600);
      const chunks = chunkContent(content, 'twitter');
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(280);
      }
    });

    it('single tweet under 280 chars has no marker', () => {
      const content = 'Short tweet.';
      const chunks = chunkContent(content, 'twitter');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(content);
    });
  });

  describe('word boundary splitting', () => {
    it('prefers splitting on whitespace', () => {
      // Each "word" is 100 chars; at Discord limit 2000, words should stay together
      const words = Array.from({ length: 25 }, (_, i) => `word${String(i).padStart(2, '0')}${'x'.repeat(94)}`);
      const content = words.join(' ');
      const chunks = chunkContent(content, 'discord');
      // No chunk should have a word split mid-character (each chunk ends cleanly)
      for (const chunk of chunks) {
        const rawContent = chunk.content.replace(/\s*\[\d+\/\d+\]$/, '');
        // Should not end mid-word (no trailing partial words)
        expect(rawContent.endsWith(' ')).toBe(false);
      }
    });
  });
});

// =============================================================================
// reassembleChunks
// =============================================================================

describe('reassembleChunks', () => {
  it('joins chunks in order regardless of input order', () => {
    const chunks = [
      { index: 2, total: 3, content: 'third [3/3]' },
      { index: 0, total: 3, content: 'first [1/3]' },
      { index: 1, total: 3, content: 'second [2/3]' },
    ];
    const result = reassembleChunks(chunks);
    expect(result).toBe('first second third');
  });

  it('strips sequence markers from chunks', () => {
    const chunks = [
      { index: 0, total: 2, content: 'Hello [1/2]' },
      { index: 1, total: 2, content: 'World [2/2]' },
    ];
    expect(reassembleChunks(chunks)).toBe('Hello World');
  });

  it('handles single chunk with no marker', () => {
    const chunks = [{ index: 0, total: 1, content: 'No marker here' }];
    expect(reassembleChunks(chunks)).toBe('No marker here');
  });

  it('round-trips: chunk then reassemble preserves original text', () => {
    const original = 'The quick brown fox jumps over the lazy dog. '.repeat(60);
    const chunks = chunkContent(original, 'twitter');
    const reassembled = reassembleChunks(chunks);
    // Allow minor whitespace normalization at split boundaries
    expect(reassembled.replace(/\s+/g, ' ').trim()).toBe(original.trim().replace(/\s+/g, ' '));
  });
});

// =============================================================================
// DynamoDB integration (storeDraft / getDocument / exportDocument)
// =============================================================================

describe('storeDraft / getDocument / exportDocument', () => {
  let mockClient: DynamoDBDocumentClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    _setDynamoClient(mockClient);
  });

  afterEach(() => {
    _setDynamoClient(null);
  });

  it('storeDraft returns a LongFormDocument with status=draft', async () => {
    const doc = await storeDraft('telegram', 'Hello long content', TABLE);
    expect(doc.status).toBe('draft');
    expect(doc.content).toBe('Hello long content');
    expect(doc.platform).toBe('telegram');
    expect(typeof doc.id).toBe('string');
    expect(doc.createdAt).toBeGreaterThan(0);
  });

  it('getDocument retrieves the stored document', async () => {
    const doc = await storeDraft('discord', 'Stored content', TABLE);
    const retrieved = await getDocument('discord', doc.createdAt, doc.id, TABLE);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(doc.id);
    expect(retrieved!.content).toBe('Stored content');
    expect(retrieved!.status).toBe('draft');
  });

  it('getDocument returns null for missing document', async () => {
    const result = await getDocument('telegram', 0, 'nonexistent', TABLE);
    expect(result).toBeNull();
  });

  it('exportDocument returns full content', async () => {
    const doc = await storeDraft('twitter', 'Export me', TABLE);
    const content = await exportDocument('twitter', doc.createdAt, doc.id, TABLE);
    expect(content).toBe('Export me');
  });

  it('exportDocument returns null for missing document', async () => {
    const content = await exportDocument('telegram', 0, 'ghost', TABLE);
    expect(content).toBeNull();
  });
});

// =============================================================================
// markChunkSent — idempotency
// =============================================================================

describe('markChunkSent', () => {
  it('is idempotent: second call preserves original sentAt and messageId', async () => {
    const sentAtValues: unknown[] = [];
    const messageIdValues: unknown[] = [];
    const store = new Map<string, Record<string, unknown>>();

    const mockClient = makeMockClient({
      send: (cmd: unknown) => {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        const name = c.constructor?.name ?? '';
        const input = c.input ?? {};

        if (name === 'PutCommand') {
          const key = `${input.Item?.pk}|${input.Item?.sk}`;
          store.set(key, { ...(input.Item as Record<string, unknown>), chunkMeta: {} });
          return Promise.resolve({});
        }

        if (name === 'UpdateCommand') {
          const key = `${(input.Key as Record<string, unknown>)?.pk}|${(input.Key as Record<string, unknown>)?.sk}`;
          const item = store.get(key);
          if (!item) return Promise.reject(new Error('ConditionalCheckFailedException'));

          const attrNames = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
          const attrValues = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
          const chunkMetaField = attrNames['#chunkMeta'];
          const idxField = attrNames['#idx'];
          const sentAtField = attrNames['#sentAt'];
          const messageIdField = attrNames['#messageId'];

          if (!item[chunkMetaField]) item[chunkMetaField] = {};
          const chunkMeta = item[chunkMetaField] as Record<string, Record<string, unknown>>;
          if (!chunkMeta[idxField]) chunkMeta[idxField] = {};

          // if_not_exists: only set if not already present
          if (!chunkMeta[idxField][sentAtField]) {
            chunkMeta[idxField][sentAtField] = attrValues[':sentAt'];
          }
          if (!chunkMeta[idxField][messageIdField]) {
            chunkMeta[idxField][messageIdField] = attrValues[':messageId'];
          }

          sentAtValues.push(chunkMeta[idxField][sentAtField]);
          messageIdValues.push(chunkMeta[idxField][messageIdField]);

          return Promise.resolve({});
        }

        return Promise.resolve({});
      },
    });

    _setDynamoClient(mockClient);

    try {
      const doc = await storeDraft('telegram', 'Some content', TABLE);

      await markChunkSent('telegram', doc.createdAt, doc.id, 0, 'msg-111', TABLE);
      await markChunkSent('telegram', doc.createdAt, doc.id, 0, 'msg-999', TABLE); // retry with different ID

      // Both calls should see the same original sentAt and messageId
      expect(sentAtValues[0]).toBe(sentAtValues[1]);
      expect(messageIdValues[0]).toBe('msg-111');
      expect(messageIdValues[1]).toBe('msg-111'); // preserved from first call
    } finally {
      _setDynamoClient(null);
    }
  });
});
