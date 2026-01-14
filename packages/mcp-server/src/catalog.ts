/**
 * MCP Catalog + Ingestion Pipeline
 */
import { z } from 'zod';

export const McpCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url(),
  transport: z.enum(['stdio', 'http', 'ws']).default('http'),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  toolsets: z.array(z.string()).optional(),
  trustScore: z.number().min(0).max(1).optional(),
  allowedTools: z.array(z.string()).optional(),
  rateLimitPerMinute: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const McpCatalogSchema = z.object({
  updatedAt: z.number(),
  entries: z.array(McpCatalogEntrySchema),
});

export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>;
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

export interface CatalogIngestionOptions {
  minTrustScore?: number;
  allowIds?: string[];
  blockIds?: string[];
  maxEntries?: number;
}

function normalizeEntry(entry: McpCatalogEntry): McpCatalogEntry {
  const tags = entry.tags?.map(tag => tag.trim().toLowerCase()).filter(Boolean);
  const toolsets = entry.toolsets?.map(toolset => toolset.trim().toLowerCase()).filter(Boolean);

  return {
    ...entry,
    tags: tags?.length ? Array.from(new Set(tags)) : undefined,
    toolsets: toolsets?.length ? Array.from(new Set(toolsets)) : undefined,
  };
}

export function ingestCatalog(
  input: unknown,
  options: CatalogIngestionOptions = {}
): McpCatalog {
  const parsed = McpCatalogSchema.parse(input);

  let entries = parsed.entries.map(normalizeEntry);
  if (options.allowIds?.length) {
    const allow = new Set(options.allowIds);
    entries = entries.filter(entry => allow.has(entry.id));
  }
  if (options.blockIds?.length) {
    const block = new Set(options.blockIds);
    entries = entries.filter(entry => !block.has(entry.id));
  }
  if (options.minTrustScore !== undefined) {
    entries = entries.filter(entry => (entry.trustScore ?? 0) >= options.minTrustScore!);
  }
  if (options.maxEntries !== undefined) {
    entries = entries.slice(0, options.maxEntries);
  }

  return {
    updatedAt: parsed.updatedAt,
    entries,
  };
}
