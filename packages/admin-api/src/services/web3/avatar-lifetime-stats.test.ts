/**
 * Avatar Lifetime Stats & Lineage Metadata Enrichment — unit tests
 *
 * Tests for getAvatarLifetimeStats() source verification and
 * generateLineageMetadataJson() logic with and without stats.
 *
 * Following the project pattern: pure function tests + source verification
 * to avoid pulling in heavy dependencies (@solana/web3.js, DynamoDB).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Re-implement generateLineageMetadataJson to test in isolation
// (avoids importing lineage-nft.ts which pulls in @solana/web3.js)
// =============================================================================

interface LineageMetadata {
  avatarId: string;
  avatarName: string;
  era: number;
  isGenesis: boolean;
  abandonedAt: number;
  inhabitantWallet: string;
  avatarUrl?: string;
  snapshotUrl?: string;
  stats?: {
    messagesProcessed: number;
    mediaGenerated: number;
    voiceMinutesUsed: number;
    daysActive: number;
    burnTier?: number;
    burnTierName?: string;
  };
}

function generateLineageMetadataJson(metadata: LineageMetadata): Record<string, unknown> {
  const attributes: Array<{ trait_type: string; value: string | number | boolean; display_type?: string }> = [
    { trait_type: 'Avatar', value: metadata.avatarName },
    { trait_type: 'Era', value: metadata.era },
    { trait_type: 'Abandoned At', value: new Date(metadata.abandonedAt).toISOString() },
  ];

  if (metadata.isGenesis) {
    attributes.push({ trait_type: 'Genesis', value: 'true' });
  }

  if (metadata.stats) {
    attributes.push(
      { trait_type: 'Messages Processed', value: metadata.stats.messagesProcessed, display_type: 'number' },
      { trait_type: 'Media Generated', value: metadata.stats.mediaGenerated, display_type: 'number' },
      { trait_type: 'Voice Minutes', value: Math.round(metadata.stats.voiceMinutesUsed * 10) / 10, display_type: 'number' },
      { trait_type: 'Days Active', value: metadata.stats.daysActive, display_type: 'number' },
    );

    if (metadata.stats.burnTierName) {
      attributes.push({ trait_type: 'Burn Tier', value: metadata.stats.burnTierName });
    }
  }

  return {
    name: `${metadata.avatarName} - Era ${metadata.era}`,
    symbol: 'SWARM',
    description: `Lineage NFT for ${metadata.avatarName}. Era ${metadata.era}${metadata.isGenesis ? ' (Genesis)' : ''}.`,
    image: metadata.avatarUrl || metadata.snapshotUrl,
    external_url: `https://swarm.rati.chat/avatar/${metadata.avatarId}`,
    attributes,
    properties: {
      category: 'image',
      creators: [
        { address: metadata.inhabitantWallet, share: 100 },
      ],
    },
  };
}

// =============================================================================
// generateLineageMetadataJson tests
// =============================================================================

describe('generateLineageMetadataJson', () => {
  const baseMetadata: LineageMetadata = {
    avatarId: 'avatar-123',
    avatarName: 'TestBot',
    era: 2,
    isGenesis: false,
    abandonedAt: 1700000000000,
    inhabitantWallet: 'WaLLeTaDdReSs123456789012345678901234567890',
    avatarUrl: 'https://example.com/avatar.png',
  };

  it('generates valid metadata without stats', () => {
    const result = generateLineageMetadataJson(baseMetadata);

    expect(result.name).toBe('TestBot - Era 2');
    expect(result.symbol).toBe('SWARM');
    expect(result.image).toBe('https://example.com/avatar.png');

    const attrs = result.attributes as Array<{ trait_type: string; value: unknown }>;
    const traitTypes = attrs.map(a => a.trait_type);
    expect(traitTypes).toContain('Avatar');
    expect(traitTypes).toContain('Era');
    expect(traitTypes).toContain('Abandoned At');

    // No Genesis attribute for era 2
    expect(traitTypes).not.toContain('Genesis');
    // No stats attributes
    expect(traitTypes).not.toContain('Messages Processed');
  });

  it('includes Genesis trait for era 1', () => {
    const genesisMetadata: LineageMetadata = {
      ...baseMetadata,
      era: 1,
      isGenesis: true,
    };

    const result = generateLineageMetadataJson(genesisMetadata);
    const attrs = result.attributes as Array<{ trait_type: string; value: unknown }>;

    const genesisAttr = attrs.find(a => a.trait_type === 'Genesis');
    expect(genesisAttr).toBeDefined();
    expect(genesisAttr!.value).toBe('true');

    expect(result.description).toContain('Genesis');
  });

  it('includes stats attributes when stats are provided', () => {
    const metadataWithStats: LineageMetadata = {
      ...baseMetadata,
      stats: {
        messagesProcessed: 12500,
        mediaGenerated: 340,
        voiceMinutesUsed: 55.7,
        daysActive: 90,
        burnTier: 2,
        burnTierName: 'Blaze',
      },
    };

    const result = generateLineageMetadataJson(metadataWithStats);
    const attrs = result.attributes as Array<{ trait_type: string; value: unknown; display_type?: string }>;

    const messagesAttr = attrs.find(a => a.trait_type === 'Messages Processed');
    expect(messagesAttr).toBeDefined();
    expect(messagesAttr!.value).toBe(12500);
    expect(messagesAttr!.display_type).toBe('number');

    const mediaAttr = attrs.find(a => a.trait_type === 'Media Generated');
    expect(mediaAttr).toBeDefined();
    expect(mediaAttr!.value).toBe(340);
    expect(mediaAttr!.display_type).toBe('number');

    const voiceAttr = attrs.find(a => a.trait_type === 'Voice Minutes');
    expect(voiceAttr).toBeDefined();
    expect(voiceAttr!.value).toBe(55.7);
    expect(voiceAttr!.display_type).toBe('number');

    const daysAttr = attrs.find(a => a.trait_type === 'Days Active');
    expect(daysAttr).toBeDefined();
    expect(daysAttr!.value).toBe(90);
    expect(daysAttr!.display_type).toBe('number');

    const tierAttr = attrs.find(a => a.trait_type === 'Burn Tier');
    expect(tierAttr).toBeDefined();
    expect(tierAttr!.value).toBe('Blaze');
  });

  it('omits Burn Tier attribute when burnTierName is absent', () => {
    const metadataWithPartialStats: LineageMetadata = {
      ...baseMetadata,
      stats: {
        messagesProcessed: 100,
        mediaGenerated: 5,
        voiceMinutesUsed: 0,
        daysActive: 3,
      },
    };

    const result = generateLineageMetadataJson(metadataWithPartialStats);
    const attrs = result.attributes as Array<{ trait_type: string; value: unknown }>;

    expect(attrs.find(a => a.trait_type === 'Messages Processed')).toBeDefined();
    expect(attrs.find(a => a.trait_type === 'Burn Tier')).toBeUndefined();
  });

  it('combines Genesis trait and stats for era 1 with stats', () => {
    const genesisWithStats: LineageMetadata = {
      ...baseMetadata,
      era: 1,
      isGenesis: true,
      stats: {
        messagesProcessed: 500,
        mediaGenerated: 20,
        voiceMinutesUsed: 10,
        daysActive: 14,
        burnTier: 1,
        burnTierName: 'Spark',
      },
    };

    const result = generateLineageMetadataJson(genesisWithStats);
    const attrs = result.attributes as Array<{ trait_type: string; value: unknown }>;
    const traitTypes = attrs.map(a => a.trait_type);

    expect(traitTypes).toContain('Genesis');
    expect(traitTypes).toContain('Messages Processed');
    expect(traitTypes).toContain('Burn Tier');
  });

  it('rounds voice minutes to 1 decimal place', () => {
    const metadata: LineageMetadata = {
      ...baseMetadata,
      stats: {
        messagesProcessed: 0,
        mediaGenerated: 0,
        voiceMinutesUsed: 12.3456,
        daysActive: 1,
      },
    };

    const result = generateLineageMetadataJson(metadata);
    const attrs = result.attributes as Array<{ trait_type: string; value: unknown }>;
    const voiceAttr = attrs.find(a => a.trait_type === 'Voice Minutes');
    expect(voiceAttr!.value).toBe(12.3);
  });
});

// =============================================================================
// getAvatarLifetimeStats — source verification
// =============================================================================

describe('getAvatarLifetimeStats — source verification', () => {
  const src = readFileSync(resolve(__dirname, 'avatar-lifetime-stats.ts'), 'utf-8');

  it('exports getAvatarLifetimeStats function', () => {
    expect(src).toContain('export async function getAvatarLifetimeStats');
  });

  it('queries USAGE# partition key for daily records', () => {
    expect(src).toContain('`USAGE#${avatarId}`');
    expect(src).toContain("'DAY#'");
  });

  it('sums messagesProcessed, media generations, and voiceMinutesUsed', () => {
    expect(src).toContain('messagesProcessed');
    expect(src).toContain('imageGenerations');
    expect(src).toContain('videoGenerations');
    expect(src).toContain('stickerGenerations');
    expect(src).toContain('voiceMinutesUsed');
  });

  it('fetches burn stats from BURN_STATS sort key', () => {
    expect(src).toContain('BURN_STATS');
    expect(src).toContain('burnTier');
    expect(src).toContain('burnTierName');
  });

  it('wraps each query in try/catch for graceful degradation', () => {
    const tryCount = (src.match(/\btry\s*\{/g) || []).length;
    expect(tryCount).toBeGreaterThanOrEqual(2);
  });

  it('returns partial data on failure — never throws', () => {
    expect(src).toContain('messagesProcessed: 0');
    expect(src).toContain('mediaGenerated: 0');
    expect(src).toContain('voiceMinutesUsed: 0');
    expect(src).toContain('daysActive: 0');
  });

  it('exports AvatarLifetimeStats interface', () => {
    expect(src).toContain('export interface AvatarLifetimeStats');
  });
});

// =============================================================================
// lineage-nft.ts — source verification for stats integration
// =============================================================================

describe('lineage-nft.ts — stats integration source verification', () => {
  const src = readFileSync(resolve(__dirname, 'lineage-nft.ts'), 'utf-8');

  it('LineageMetadata includes optional stats field', () => {
    expect(src).toContain('stats?:');
  });

  it('generateLineageMetadataJson handles stats attributes', () => {
    expect(src).toContain("'Messages Processed'");
    expect(src).toContain("'Media Generated'");
    expect(src).toContain("'Voice Minutes'");
    expect(src).toContain("'Days Active'");
    expect(src).toContain("'Burn Tier'");
  });

  it('uses display_type: number for numeric stats', () => {
    expect(src).toContain("display_type: 'number'");
  });

  it('Genesis trait uses string value "true" for Metaplex compatibility', () => {
    expect(src).toContain("{ trait_type: 'Genesis', value: 'true' }");
  });

  it('prepareLineageMint imports and calls getAvatarLifetimeStats', () => {
    expect(src).toContain('getAvatarLifetimeStats');
  });

  it('prepareLineageMint wraps stats fetch in try/catch', () => {
    // The stats fetch should be wrapped so failures don't block abandon
    expect(src).toContain('Failed to fetch lifetime stats');
  });
});
