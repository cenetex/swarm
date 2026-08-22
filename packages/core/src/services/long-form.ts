/**
 * Long-Form Content Pipeline Service
 *
 * Supports drafting and delivery of content beyond platform character limits.
 * Provides chunked messaging with sequence markers, idempotent chunk tracking,
 * inbound reassembly, and full document export.
 *
 * DynamoDB Schema:
 * PK: LONGFORM#<platform>
 * SK: DOC#<createdAt>#<id>
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@swarm/core';
import { randomUUID } from 'crypto';
import type { Platform } from '../types/platform.js';
import type { LongFormDocument, ChunkMeta } from '../types/long-form.js';
import { PLATFORM_CHAR_LIMITS } from '../types/long-form.js';

// TTL for long-form documents: 90 days
const LONGFORM_TTL_DAYS = 90;
const SECONDS_PER_DAY = 86400;

// Sequence marker format: " [N/T]" — appended to each chunk
// The marker itself occupies at most " [NNN/NNN]".length = 11 chars.
// We reserve 12 chars to be safe.
const SEQUENCE_MARKER_OVERHEAD = 12;

let _client: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

/** Test hook: inject a mock DynamoDB document client. */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _client = client;
}

function computeTtl(): number {
  return Math.floor(Date.now() / 1000) + LONGFORM_TTL_DAYS * SECONDS_PER_DAY;
}

function buildPK(platform: Platform): string {
  return `LONGFORM#${platform}`;
}

function buildSK(createdAt: number, id: string): string {
  return `DOC#${createdAt}#${id}`;
}

function getTableName(): string {
  const name = process.env.SWARM_TABLE_NAME || process.env.DYNAMODB_TABLE_NAME;
  if (!name) {
    throw new Error('SWARM_TABLE_NAME or DYNAMODB_TABLE_NAME env var is required');
  }
  return name;
}

// =============================================================================
// CHUNK SPLITTING
// =============================================================================

/**
 * Split content into platform-compliant chunks with "[N/T]" sequence markers.
 *
 * The marker is appended to each chunk. When content fits in a single chunk,
 * no marker is added (single-chunk documents are transparent to the user).
 */
export function chunkContent(content: string, platform: Platform): ChunkMeta[] {
  const limit = PLATFORM_CHAR_LIMITS[platform] ?? 4096;

  // If content fits in a single chunk (no marker needed), return as-is.
  if (content.length <= limit) {
    return [{ index: 0, total: 1, content }];
  }

  // Multi-chunk path: split using reduced budget to leave room for markers.
  const chunkBudget = limit - SEQUENCE_MARKER_OVERHEAD;
  const rawChunks = splitIntoRawChunks(content, chunkBudget);

  const total = rawChunks.length;
  return rawChunks.map((raw, index) => ({
    index,
    total,
    content: `${raw} [${index + 1}/${total}]`,
  }));
}

/**
 * Split text into raw chunks of at most `maxLen` characters.
 * Prefers splitting on whitespace boundaries when possible.
 */
function splitIntoRawChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split on a whitespace boundary at or before maxLen
    let splitAt = maxLen;
    const lastSpace = remaining.lastIndexOf(' ', maxLen);
    if (lastSpace > 0) {
      splitAt = lastSpace;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// =============================================================================
// REASSEMBLY
// =============================================================================

/**
 * Reassemble ordered chunks into full content.
 * Strips sequence markers (" [N/T]") before joining.
 */
export function reassembleChunks(chunks: ChunkMeta[]): string {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const markerPattern = /\s*\[\d+\/\d+\]$/;
  return ordered
    .map((c) => c.content.replace(markerPattern, ''))
    .join(' ')
    .trim();
}

// =============================================================================
// DYNAMODB OPERATIONS
// =============================================================================

/**
 * Store a long-form draft document in DynamoDB.
 */
export async function storeDraft(
  platform: Platform,
  content: string,
  tableName?: string
): Promise<LongFormDocument> {
  const client = getDynamoClient();
  const table = tableName ?? getTableName();
  const now = Date.now();
  const id = randomUUID();

  const doc: LongFormDocument = {
    id,
    content,
    platform,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    ttl: computeTtl(),
  };

  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: buildPK(platform),
        sk: buildSK(now, id),
        ...doc,
      },
    })
  );

  return doc;
}

/**
 * Fetch a stored long-form document by platform, createdAt, and id.
 */
export async function getDocument(
  platform: Platform,
  createdAt: number,
  id: string,
  tableName?: string
): Promise<LongFormDocument | null> {
  const client = getDynamoClient();
  const table = tableName ?? getTableName();

  const result = await client.send(
    new GetCommand({
      TableName: table,
      Key: {
        pk: buildPK(platform),
        sk: buildSK(createdAt, id),
      },
    })
  );

  if (!result.Item) return null;

  const item = result.Item as Record<string, unknown>;
  return {
    id: item.id as string,
    content: item.content as string,
    platform: item.platform as Platform,
    status: item.status as LongFormDocument['status'],
    chunks: item.chunks as ChunkMeta[] | undefined,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
    ttl: item.ttl as number | undefined,
  };
}

/**
 * Mark a specific chunk as sent (idempotent — safe to call on retry).
 *
 * If the chunk already has a sentAt, the update is skipped to preserve
 * the original delivery timestamp and messageId.
 */
export async function markChunkSent(
  platform: Platform,
  createdAt: number,
  docId: string,
  chunkIndex: number,
  messageId: string,
  tableName?: string
): Promise<void> {
  const client = getDynamoClient();
  const table = tableName ?? getTableName();
  const now = Date.now();

  // Idempotent: only write if chunk.sentAt is not yet set
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: {
        pk: buildPK(platform),
        sk: buildSK(createdAt, docId),
      },
      // list_append on chunks[index] is complex in DynamoDB; we track per-chunk
      // metadata in a map keyed by index for idempotent updates.
      UpdateExpression:
        'SET #chunkMeta.#idx.#sentAt = if_not_exists(#chunkMeta.#idx.#sentAt, :sentAt), ' +
        '#chunkMeta.#idx.#messageId = if_not_exists(#chunkMeta.#idx.#messageId, :messageId), ' +
        '#updatedAt = :updatedAt',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: {
        '#chunkMeta': 'chunkMeta',
        '#idx': String(chunkIndex),
        '#sentAt': 'sentAt',
        '#messageId': 'messageId',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':sentAt': now,
        ':messageId': messageId,
        ':updatedAt': now,
      },
    })
  );
}

/**
 * Export the full content of a document (for API export path).
 */
export async function exportDocument(
  platform: Platform,
  createdAt: number,
  docId: string,
  tableName?: string
): Promise<string | null> {
  const doc = await getDocument(platform, createdAt, docId, tableName);
  return doc ? doc.content : null;
}
