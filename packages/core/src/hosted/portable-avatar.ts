import { z } from 'zod';

export const PORTABLE_AVATAR_SCHEMA = 'swarm.avatar/v1' as const;

const publicPromptSchema = z.object({
  system: z.string().max(50_000),
  starters: z.array(z.string().max(500)).max(20),
}).strict();

const capabilitySchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  description: z.string().max(1_000).optional(),
}).strict();

const memoryEntrySchema = z.object({
  id: z.string().min(1).max(160),
  createdAt: z.string().datetime(),
  content: z.string().max(20_000),
  source: z.string().max(500).optional(),
}).strict();

const mediaReferenceSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(['avatar', 'image', 'audio', 'video', 'document', 'other']),
  uri: z.string().min(1).max(2_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  mediaType: z.string().max(160).optional(),
}).strict();

export const portableAvatarBundleV1Schema = z.object({
  schema: z.literal(PORTABLE_AVATAR_SCHEMA),
  identity: z.object({
    avatarId: z.string().min(1).max(160),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80),
    name: z.string().min(1).max(80),
    description: z.string().max(1_000),
    controller: z.object({
      type: z.literal('solana-wallet'),
      address: z.string().min(32).max(64),
    }).strict(),
  }).strict(),
  publication: z.object({
    visibility: z.enum(['public', 'private']),
    listed: z.boolean(),
  }).strict(),
  prompts: publicPromptSchema,
  capabilities: z.array(capabilitySchema).max(100),
  sharedMemory: z.object({
    summary: z.string().max(20_000),
    entries: z.array(memoryEntrySchema).max(10_000),
  }).strict(),
  media: z.array(mediaReferenceSchema).max(1_000),
  lineage: z.object({
    parentAvatarId: z.string().min(1).max(160).optional(),
    previousRevisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  }).strict(),
  revision: z.object({
    createdAt: z.string().datetime(),
  }).strict(),
}).strict().refine(
  (bundle) => bundle.publication.visibility === 'public' || !bundle.publication.listed,
  { message: 'Private avatars cannot be listed.', path: ['publication', 'listed'] },
);

export type PortableAvatarBundleV1 = z.infer<typeof portableAvatarBundleV1Schema>;

export type PortableAvatarRevision = {
  revisionId: string;
  sha256: string;
  bundle: PortableAvatarBundleV1;
};

export type PortableAvatarNftMetadata = {
  name: string;
  description: string;
  external_url?: string;
  properties: {
    category: 'swarm-avatar';
    schema: typeof PORTABLE_AVATAR_SCHEMA;
    avatar_id: string;
    revision_id: string;
    bundle_uri: string;
    bundle_sha256: string;
    controller: string;
  };
  attributes: Array<{ trait_type: string; value: string }>;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function parsePortableAvatarBundle(value: unknown): PortableAvatarBundleV1 {
  return portableAvatarBundleV1Schema.parse(value);
}

export function canonicalPortableAvatarJson(value: unknown): string {
  const bundle = parsePortableAvatarBundle(value);
  return JSON.stringify(canonicalValue(bundle));
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function portableAvatarRevision(value: unknown): Promise<PortableAvatarRevision> {
  const bundle = parsePortableAvatarBundle(value);
  const canonicalJson = canonicalPortableAvatarJson(bundle);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
  const sha256 = hex(digest);
  return { revisionId: `sha256:${sha256}`, sha256, bundle };
}

export function portableAvatarNftMetadata(
  revision: PortableAvatarRevision,
  bundleUri: string,
  externalUrl?: string,
): PortableAvatarNftMetadata {
  return {
    name: revision.bundle.identity.name,
    description: revision.bundle.identity.description,
    ...(externalUrl ? { external_url: externalUrl } : {}),
    properties: {
      category: 'swarm-avatar',
      schema: PORTABLE_AVATAR_SCHEMA,
      avatar_id: revision.bundle.identity.avatarId,
      revision_id: revision.revisionId,
      bundle_uri: bundleUri,
      bundle_sha256: revision.sha256,
      controller: revision.bundle.identity.controller.address,
    },
    attributes: [
      { trait_type: 'Schema', value: PORTABLE_AVATAR_SCHEMA },
      { trait_type: 'Visibility', value: revision.bundle.publication.visibility },
      { trait_type: 'Listed', value: revision.bundle.publication.listed ? 'yes' : 'no' },
    ],
  };
}
