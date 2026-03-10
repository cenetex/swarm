/**
 * Ascension NFT Metadata Evolution — unit tests
 *
 * Following the project pattern: source verification + pure function tests
 * to avoid pulling in heavy dependencies (@solana/web3.js, DynamoDB, Irys).
 *
 * Tests verify:
 * 1. The evolved metadata structure matches Metaplex standard
 * 2. Stats and resonance attributes are included when available
 * 3. Handler file exists and exports correctly
 * 4. CDK infra wiring is present
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Re-implement generateEvolvedMetadata for isolated testing
// =============================================================================

interface EvolvedMetadataInput {
  avatarId: string;
  name: string;
  isAscended: boolean;
  ascendedNftMint?: string;
  ascendedAt?: number;
  ascendedByWallet?: string;
  ascensionRatiBurnAmount?: number;
  profileImage?: { url: string };
}

interface StatsInput {
  messagesProcessed: number;
  mediaGenerated: number;
  voiceMinutesUsed: number;
  daysActive: number;
  burnTier?: number;
  burnTierName?: string;
}

interface ResonanceInput {
  resonance: number;
  tier: { label: string; energyRegenBonus: number };
}

interface MetadataAttribute {
  trait_type: string;
  value: string | number | boolean;
  display_type?: string;
}

function generateEvolvedMetadata(
  avatar: EvolvedMetadataInput,
  stats: StatsInput | null,
  resonance: ResonanceInput | null,
) {
  const tierName = 'Spark'; // Simplified for tests

  const attributes: MetadataAttribute[] = [
    { trait_type: 'Avatar ID', value: avatar.avatarId },
    { trait_type: 'Avatar Name', value: avatar.name },
    { trait_type: 'Ascended At', value: new Date(avatar.ascendedAt || 0).toISOString() },
    { trait_type: 'Ascension Tier', value: tierName },
    { trait_type: 'RATI Burned', value: avatar.ascensionRatiBurnAmount || 0, display_type: 'number' },
    { trait_type: 'Energy Boost', value: '+50%' },
    { trait_type: 'Persona Locked', value: 'true' },
  ];

  if (stats) {
    attributes.push(
      { trait_type: 'Messages Processed', value: stats.messagesProcessed, display_type: 'number' },
      { trait_type: 'Media Generated', value: stats.mediaGenerated, display_type: 'number' },
      { trait_type: 'Voice Minutes', value: Math.round(stats.voiceMinutesUsed * 10) / 10, display_type: 'number' },
      { trait_type: 'Days Active', value: stats.daysActive, display_type: 'number' },
    );
    if (stats.burnTierName) {
      attributes.push({ trait_type: 'Burn Tier', value: stats.burnTierName });
    }
  }

  if (resonance) {
    attributes.push(
      { trait_type: 'Orb Resonance', value: resonance.resonance, display_type: 'number' },
      { trait_type: 'Resonance Tier', value: resonance.tier.label },
    );
  }

  attributes.push({
    trait_type: 'Last Evolved',
    value: new Date().toISOString(),
  });

  return {
    name: `${avatar.name} (Ascended)`,
    symbol: 'ASCEND',
    description:
      `Ascended Avatar NFT for ${avatar.name}. ` +
      `This NFT grants ownership of the avatar — the holder can control this avatar. ` +
      `Persona and profile image are permanently locked. ` +
      `Stats evolve over time as the avatar is used.`,
    image: avatar.profileImage?.url || '',
    external_url: `https://rati.chat/avatar/${avatar.avatarId}`,
    attributes,
    properties: {
      category: 'image',
      creators: [
        { address: avatar.ascendedByWallet || '', share: 100 },
      ],
    },
  };
}

// =============================================================================
// Test Data
// =============================================================================

const testAvatar: EvolvedMetadataInput = {
  avatarId: 'test-avatar-42',
  name: 'TestBot',
  isAscended: true,
  ascendedNftMint: 'nft-mint-abc123',
  ascendedAt: 1709251200000, // 2024-03-01
  ascendedByWallet: 'wallet-xyz789',
  ascensionRatiBurnAmount: 500,
  profileImage: { url: 'https://example.com/avatar.png' },
};

const testStats: StatsInput = {
  messagesProcessed: 1500,
  mediaGenerated: 42,
  voiceMinutesUsed: 15.5,
  daysActive: 30,
  burnTier: 1,
  burnTierName: 'Spark',
};

const testResonance: ResonanceInput = {
  resonance: 5200,
  tier: { label: 'Silver', energyRegenBonus: 1 },
};

// =============================================================================
// Tests
// =============================================================================

describe('generateEvolvedMetadata', () => {
  it('generates correct base structure', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, null);

    expect(metadata.name).toBe('TestBot (Ascended)');
    expect(metadata.symbol).toBe('ASCEND');
    expect(metadata.image).toBe('https://example.com/avatar.png');
    expect(metadata.external_url).toBe('https://rati.chat/avatar/test-avatar-42');
    expect(metadata.properties.category).toBe('image');
    expect(metadata.properties.creators).toHaveLength(1);
    expect(metadata.properties.creators[0].address).toBe('wallet-xyz789');
    expect(metadata.properties.creators[0].share).toBe(100);
  });

  it('includes core ascension attributes', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, null);
    const attrs = metadata.attributes;

    const find = (trait: string) => attrs.find((a) => a.trait_type === trait);

    expect(find('Avatar ID')?.value).toBe('test-avatar-42');
    expect(find('Avatar Name')?.value).toBe('TestBot');
    expect(find('Ascension Tier')?.value).toBe('Spark');
    expect(find('RATI Burned')?.value).toBe(500);
    expect(find('RATI Burned')?.display_type).toBe('number');
    expect(find('Energy Boost')?.value).toBe('+50%');
    expect(find('Persona Locked')?.value).toBe('true');
  });

  it('includes Last Evolved timestamp', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, null);
    const evolvedAttr = metadata.attributes.find((a) => a.trait_type === 'Last Evolved');

    expect(evolvedAttr).toBeDefined();
    expect(String(evolvedAttr?.value)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes stats when provided', () => {
    const metadata = generateEvolvedMetadata(testAvatar, testStats, null);
    const attrs = metadata.attributes;
    const find = (trait: string) => attrs.find((a) => a.trait_type === trait);

    expect(find('Messages Processed')?.value).toBe(1500);
    expect(find('Messages Processed')?.display_type).toBe('number');
    expect(find('Media Generated')?.value).toBe(42);
    expect(find('Voice Minutes')?.value).toBe(15.5);
    expect(find('Days Active')?.value).toBe(30);
    expect(find('Burn Tier')?.value).toBe('Spark');
  });

  it('omits stats attributes when stats are null', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, null);
    const attrs = metadata.attributes;

    expect(attrs.find((a) => a.trait_type === 'Messages Processed')).toBeUndefined();
    expect(attrs.find((a) => a.trait_type === 'Media Generated')).toBeUndefined();
    expect(attrs.find((a) => a.trait_type === 'Voice Minutes')).toBeUndefined();
    expect(attrs.find((a) => a.trait_type === 'Days Active')).toBeUndefined();
  });

  it('includes resonance when provided', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, testResonance);
    const attrs = metadata.attributes;
    const find = (trait: string) => attrs.find((a) => a.trait_type === trait);

    expect(find('Orb Resonance')?.value).toBe(5200);
    expect(find('Orb Resonance')?.display_type).toBe('number');
    expect(find('Resonance Tier')?.value).toBe('Silver');
  });

  it('omits resonance attributes when resonance is null', () => {
    const metadata = generateEvolvedMetadata(testAvatar, null, null);
    const attrs = metadata.attributes;

    expect(attrs.find((a) => a.trait_type === 'Orb Resonance')).toBeUndefined();
    expect(attrs.find((a) => a.trait_type === 'Resonance Tier')).toBeUndefined();
  });

  it('includes both stats and resonance together', () => {
    const metadata = generateEvolvedMetadata(testAvatar, testStats, testResonance);
    const attrs = metadata.attributes;

    expect(attrs.find((a) => a.trait_type === 'Messages Processed')).toBeDefined();
    expect(attrs.find((a) => a.trait_type === 'Orb Resonance')).toBeDefined();
    expect(attrs.find((a) => a.trait_type === 'Last Evolved')).toBeDefined();
  });

  it('rounds voice minutes to 1 decimal place', () => {
    const statsWithLongDecimal = { ...testStats, voiceMinutesUsed: 15.5678 };
    const metadata = generateEvolvedMetadata(testAvatar, statsWithLongDecimal, null);
    const voiceAttr = metadata.attributes.find((a) => a.trait_type === 'Voice Minutes');

    expect(voiceAttr?.value).toBe(15.6);
  });

  it('omits Burn Tier attribute when burnTierName is not set', () => {
    const statsWithoutTierName = { ...testStats, burnTierName: undefined };
    const metadata = generateEvolvedMetadata(testAvatar, statsWithoutTierName, null);
    const burnTierAttr = metadata.attributes.find((a) => a.trait_type === 'Burn Tier');

    expect(burnTierAttr).toBeUndefined();
  });

  it('handles missing profileImage gracefully', () => {
    const avatarNoImage = { ...testAvatar, profileImage: undefined };
    const metadata = generateEvolvedMetadata(avatarNoImage, null, null);

    expect(metadata.image).toBe('');
  });

  it('handles missing ascendedByWallet', () => {
    const avatarNoWallet = { ...testAvatar, ascendedByWallet: undefined };
    const metadata = generateEvolvedMetadata(avatarNoWallet, null, null);

    expect(metadata.properties.creators[0].address).toBe('');
  });
});

describe('source verification', () => {
  const srcRoot = resolve(__dirname, '..', '..');

  it('ascension-metadata-evolution.ts exists and exports key functions', () => {
    const src = readFileSync(resolve(__dirname, 'ascension-metadata-evolution.ts'), 'utf-8');

    expect(src).toContain('export async function evolveAscensionMetadata');
    expect(src).toContain('export async function evolveAllAscensionMetadata');
    expect(src).toContain('uploadJsonToArweave');
    expect(src).toContain('getAvatarLifetimeStats');
    expect(src).toContain('getOrbResonance');
  });

  it('arweave.ts exists and exports upload functions', () => {
    const src = readFileSync(resolve(__dirname, 'arweave.ts'), 'utf-8');

    expect(src).toContain('export async function uploadJsonToArweave');
    expect(src).toContain('export async function uploadBufferToArweave');
    expect(src).toContain('export async function estimateUploadCost');
    expect(src).toContain('SecretsManagerClient');
  });

  it('metadata-evolution handler exists', () => {
    const handlerPath = resolve(srcRoot, 'handlers', 'metadata-evolution.ts');
    expect(existsSync(handlerPath)).toBe(true);

    const src = readFileSync(handlerPath, 'utf-8');
    expect(src).toContain('export async function handler');
    expect(src).toContain('evolveAllAscensionMetadata');
  });

  it('CDK infra wires the metadata evolution schedule', () => {
    const infraPath = resolve(srcRoot, '..', '..', 'infra', 'src', 'constructs', 'admin-api.ts');
    const src = readFileSync(infraPath, 'utf-8');

    expect(src).toContain('MetadataEvolutionHandler');
    expect(src).toContain('MetadataEvolutionSchedule');
    expect(src).toContain('metadata-evolution.ts');
    expect(src).toContain('ARWEAVE_WALLET_SECRET');
    expect(src).toContain('ARWEAVE_NETWORK');
    expect(src).toContain('EVOLUTION_COOLDOWN_DAYS');
  });

  it('web3/index.ts exports the new modules', () => {
    const src = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');

    expect(src).toContain("'./arweave.js'");
    expect(src).toContain("'./ascension-metadata-evolution.js'");
  });

  it('evolution metadata includes ScanCommand for batch processing', () => {
    const src = readFileSync(resolve(__dirname, 'ascension-metadata-evolution.ts'), 'utf-8');

    expect(src).toContain('ScanCommand');
    expect(src).toContain("isAscended = :true");
    expect(src).toContain('lastMetadataEvolution');
    expect(src).toContain('metadataEvolutionCount');
  });

  it('handler configures Arweave from environment variables', () => {
    const src = readFileSync(
      resolve(srcRoot, 'handlers', 'metadata-evolution.ts'),
      'utf-8',
    );

    expect(src).toContain('ARWEAVE_NETWORK');
    expect(src).toContain('ARWEAVE_WALLET_SECRET');
    expect(src).toContain('EVOLUTION_COOLDOWN_DAYS');
  });
});
