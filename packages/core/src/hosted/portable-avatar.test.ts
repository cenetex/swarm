import { describe, expect, it } from 'vitest';
import {
  canonicalPortableAvatarJson,
  parsePortableAvatarBundle,
  portableAvatarNftMetadata,
  portableAvatarRevision,
  type PortableAvatarBundleV1,
} from './portable-avatar.js';

function bundle(): PortableAvatarBundleV1 {
  return {
    schema: 'swarm.avatar/v1',
    identity: {
      avatarId: 'avatar_open_project',
      slug: 'open-project',
      name: 'Open Project',
      description: 'A public agent with portable identity and memory.',
      controller: { type: 'solana-wallet', address: '11111111111111111111111111111111' },
    },
    publication: { visibility: 'public', listed: true },
    prompts: { system: 'Build in public.', starters: ['What are you working on?'] },
    capabilities: [{ id: 'conversation', name: 'Conversation' }],
    sharedMemory: { summary: 'A public memory summary.', entries: [] },
    media: [],
    lineage: {},
    revision: { createdAt: '2026-08-30T12:00:00.000Z' },
  };
}

describe('portable avatar bundles', () => {
  it('creates the same revision id for equivalent key ordering', async () => {
    const first = bundle();
    const reordered: PortableAvatarBundleV1 = {
      revision: first.revision,
      lineage: first.lineage,
      media: first.media,
      sharedMemory: first.sharedMemory,
      capabilities: first.capabilities,
      prompts: first.prompts,
      publication: first.publication,
      identity: first.identity,
      schema: first.schema,
    };

    const left = await portableAvatarRevision(first);
    const right = await portableAvatarRevision(reordered);

    expect(left.revisionId).toBe(right.revisionId);
    expect(left.revisionId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(canonicalPortableAvatarJson(first)).toBe(canonicalPortableAvatarJson(reordered));
  });

  it('rejects unknown secret-bearing fields instead of exporting them', () => {
    const unsafe = { ...bundle(), apiKey: 'must-not-leak' };
    expect(() => parsePortableAvatarBundle(unsafe)).toThrow();
  });

  it('emits stable NFT-ready metadata that points at the portable artifact', async () => {
    const revision = await portableAvatarRevision(bundle());
    const metadata = portableAvatarNftMetadata(
      revision,
      `ar://${revision.sha256}`,
      'https://next.swarm.rati.chat/a/open-project',
    );

    expect(metadata.properties.bundle_uri).toBe(`ar://${revision.sha256}`);
    expect(metadata.properties.revision_id).toBe(revision.revisionId);
    expect(metadata.properties.controller).toBe('11111111111111111111111111111111');
  });
});
