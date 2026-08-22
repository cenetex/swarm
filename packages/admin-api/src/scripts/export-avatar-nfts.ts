#!/usr/bin/env npx tsx
/**
 * Export Avatars as NFT Metadata
 *
 * Generates NFT-compatible JSON metadata files for avatars in both:
 * - EVM format (OpenSea/ERC-721 compatible)
 * - SVM format (Metaplex/Solana compatible)
 *
 * Usage:
 *   npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts [options]
 *
 * Options:
 *   --output, -o    Output directory (default: ./nft-export)
 *   --format, -f    Format: 'evm', 'svm', or 'both' (default: both)
 *   --avatar, -a    Export specific avatar ID (default: all)
 *   --collection    Collection name for the NFTs
 *   --symbol        Collection symbol (default: RATI)
 *   --dry-run       Preview without writing files
 *
 * Environment:
 *   ADMIN_TABLE     DynamoDB table name (required for DB export)
 *   AWS_REGION      AWS region
 *
 * Examples:
 *   # Export all avatars to both formats
 *   npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts
 *
 *   # Export specific avatar to EVM format
 *   npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts -a my-avatar-123 -f evm
 *
 *   # Export with custom collection name
 *   npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts --collection "RATi Genesis Avatars"
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@swarm/core';
import * as fs from 'fs';
import * as path from 'path';
import type { AvatarRecord } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface ExportOptions {
  outputDir: string;
  format: 'evm' | 'svm' | 'both';
  avatarId?: string;
  collectionName: string;
  symbol: string;
  dryRun: boolean;
  baseUri?: string;           // Base URI for metadata (e.g., ipfs://Qm.../metadata/)
  imageBaseUri?: string;      // Base URI for images (e.g., ipfs://Qm.../images/)
  creatorAddress?: string;    // Default creator address
  sellerFeeBasisPoints?: number; // Royalty in basis points (e.g., 500 = 5%)
}

interface NFTAttribute {
  trait_type: string;
  value: string | number | boolean;
  display_type?: 'number' | 'boost_percentage' | 'boost_number' | 'date';
}

interface EVMMetadata {
  name: string;
  description: string;
  image: string;
  external_url?: string;
  animation_url?: string;
  attributes: NFTAttribute[];
  // OpenSea-specific
  background_color?: string;
}

interface SVMMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  animation_url?: string;
  attributes: NFTAttribute[];
  properties: {
    category: 'image' | 'video' | 'audio' | 'vr' | 'html';
    files?: Array<{
      uri: string;
      type: string;
      cdn?: boolean;
    }>;
    creators?: Array<{
      address: string;
      share: number;
    }>;
  };
  seller_fee_basis_points?: number;
  collection?: {
    name: string;
    family?: string;
  };
}

interface CollectionMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  seller_fee_basis_points: number;
  fee_recipient?: string;
}

// =============================================================================
// Avatar to NFT Attribute Conversion
// =============================================================================

/**
 * Extract attributes from avatar for NFT metadata
 * Following the RATi Avatar NFT Spec
 */
function extractAvatarAttributes(avatar: AvatarRecord): NFTAttribute[] {
  const attributes: NFTAttribute[] = [];

  // Personality (most important - from persona field)
  if (avatar.persona) {
    // Extract first paragraph or first 500 chars as personality
    const personality = avatar.persona.split('\n\n')[0].slice(0, 500);
    attributes.push({
      trait_type: 'Personality',
      value: personality,
    });
  }

  // Era tracking
  if (avatar.currentEra !== undefined) {
    attributes.push({
      trait_type: 'Era',
      value: avatar.currentEra,
      display_type: 'number',
    });
  }

  // Generation
  attributes.push({
    trait_type: 'Generation',
    value: avatar.currentEra === 0 ? 'Genesis' : `Era ${avatar.currentEra}`,
  });

  // Slot type
  if (avatar.slotType) {
    attributes.push({
      trait_type: 'Slot Type',
      value: avatar.slotType === 'free' ? 'Free' : 'Orb',
    });
  }

  // Platform availability
  const platforms: string[] = [];
  if (avatar.platforms?.telegram?.enabled) platforms.push('Telegram');
  if (avatar.platforms?.twitter?.enabled) platforms.push('Twitter');
  if (avatar.platforms?.discord?.enabled) platforms.push('Discord');
  if (avatar.platforms?.web?.enabled) platforms.push('Web');

  if (platforms.length > 0) {
    attributes.push({
      trait_type: 'Platforms',
      value: platforms.join(', '),
    });
  }

  // Voice enabled
  if (avatar.voiceConfig?.enabled) {
    attributes.push({
      trait_type: 'Voice',
      value: 'Enabled',
    });
  }

  // LLM model
  if (avatar.llmConfig?.model) {
    attributes.push({
      trait_type: 'Model',
      value: avatar.llmConfig.model,
    });
  }

  // Health status
  if (avatar.healthStatus) {
    attributes.push({
      trait_type: 'Status',
      value: avatar.healthStatus.charAt(0).toUpperCase() + avatar.healthStatus.slice(1),
    });
  }

  // Creation date
  if (avatar.createdAt) {
    attributes.push({
      trait_type: 'Created',
      value: Math.floor(avatar.createdAt / 1000), // Unix timestamp in seconds
      display_type: 'date',
    });
  }

  // NFT-backed origin
  if (avatar.nftMint) {
    attributes.push({
      trait_type: 'Origin NFT',
      value: avatar.nftMint.slice(0, 8) + '...',
    });
    if (avatar.nftCollection) {
      attributes.push({
        trait_type: 'Origin Collection',
        value: avatar.nftCollection.slice(0, 8) + '...',
      });
    }
  }

  // Faction (if we add this later)
  // Voice style, Speaking style, Interests, Quirks can be added if stored

  return attributes;
}

// =============================================================================
// Metadata Generators
// =============================================================================

/**
 * Generate EVM (OpenSea/ERC-721) compatible metadata
 */
function generateEVMMetadata(
  avatar: AvatarRecord,
  options: ExportOptions,
  tokenId: number
): EVMMetadata {
  const imageUri = options.imageBaseUri
    ? `${options.imageBaseUri}/${tokenId}.png`
    : avatar.profileImage?.url || `https://swarm.rati.chat/api/avatars/${avatar.avatarId}/image`;

  return {
    name: avatar.name,
    description: avatar.description || `${avatar.name} - A RATi Avatar NFT. ${avatar.persona?.slice(0, 200) || ''}`,
    image: imageUri,
    external_url: `https://swarm.rati.chat/avatar/${avatar.avatarId}`,
    animation_url: avatar.characterReference?.url,
    attributes: extractAvatarAttributes(avatar),
  };
}

/**
 * Generate SVM (Metaplex/Solana) compatible metadata
 */
function generateSVMMetadata(
  avatar: AvatarRecord,
  options: ExportOptions,
  tokenId: number
): SVMMetadata {
  const imageUri = options.imageBaseUri
    ? `${options.imageBaseUri}/${tokenId}.png`
    : avatar.profileImage?.url || `https://swarm.rati.chat/api/avatars/${avatar.avatarId}/image`;

  const files: Array<{ uri: string; type: string }> = [
    { uri: imageUri, type: 'image/png' },
  ];

  if (avatar.characterReference?.url) {
    files.push({ uri: avatar.characterReference.url, type: 'video/mp4' });
  }

  return {
    name: avatar.name,
    symbol: options.symbol,
    description: avatar.description || `${avatar.name} - A RATi Avatar NFT. ${avatar.persona?.slice(0, 200) || ''}`,
    image: imageUri,
    external_url: `https://swarm.rati.chat/avatar/${avatar.avatarId}`,
    animation_url: avatar.characterReference?.url,
    attributes: extractAvatarAttributes(avatar),
    seller_fee_basis_points: options.sellerFeeBasisPoints || 500,
    collection: {
      name: options.collectionName,
      family: 'RATi',
    },
    properties: {
      category: 'image',
      files,
      creators: options.creatorAddress
        ? [{ address: options.creatorAddress, share: 100 }]
        : undefined,
    },
  };
}

/**
 * Generate collection metadata for EVM
 */
function generateEVMCollectionMetadata(options: ExportOptions): CollectionMetadata {
  return {
    name: options.collectionName,
    symbol: options.symbol,
    description: 'RATi Avatar NFT Collection - AI avatars that can be claimed and inhabited in the RATi ecosystem.',
    image: 'https://swarm.rati.chat/collection-image.png',
    external_url: 'https://swarm.rati.chat',
    seller_fee_basis_points: options.sellerFeeBasisPoints || 500,
  };
}

/**
 * Generate collection metadata for SVM (Metaplex)
 */
function generateSVMCollectionMetadata(options: ExportOptions): SVMMetadata {
  return {
    name: options.collectionName,
    symbol: options.symbol,
    description: 'RATi Avatar NFT Collection - AI avatars that can be claimed and inhabited in the RATi ecosystem.',
    image: 'https://swarm.rati.chat/collection-image.png',
    external_url: 'https://swarm.rati.chat',
    attributes: [
      { trait_type: 'Type', value: 'Collection' },
    ],
    seller_fee_basis_points: options.sellerFeeBasisPoints || 500,
    properties: {
      category: 'image',
      files: [
        { uri: 'https://swarm.rati.chat/collection-image.png', type: 'image/png' },
      ],
      creators: options.creatorAddress
        ? [{ address: options.creatorAddress, share: 100 }]
        : undefined,
    },
  };
}

// =============================================================================
// Database Access
// =============================================================================

async function fetchAvatars(avatarId?: string): Promise<AvatarRecord[]> {
  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) {
    console.error('ADMIN_TABLE environment variable not set');
    process.exit(1);
  }

  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  if (avatarId) {
    // Fetch specific avatar
    const result = await dynamoClient.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'sk = :sk AND avatarId = :avatarId',
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':avatarId': avatarId,
      },
    }));
    return (result.Items || []) as AvatarRecord[];
  }

  // Fetch all avatars
  const result = await dynamoClient.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: 'sk = :sk AND #status <> :deleted',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':deleted': 'deleted',
    },
  }));

  return (result.Items || []) as AvatarRecord[];
}

// =============================================================================
// File Output
// =============================================================================

function writeMetadataFile(
  filepath: string,
  metadata: EVMMetadata | SVMMetadata | CollectionMetadata,
  dryRun: boolean
): void {
  const json = JSON.stringify(metadata, null, 2);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would write: ${filepath}`);
    console.log(json);
    return;
  }

  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filepath, json);
  console.log(`Wrote: ${filepath}`);
}

// =============================================================================
// Main Export Function
// =============================================================================

async function exportAvatarNFTs(options: ExportOptions): Promise<void> {
  console.log('='.repeat(60));
  console.log('RATi Avatar NFT Metadata Export');
  console.log('='.repeat(60));
  console.log(`Collection: ${options.collectionName}`);
  console.log(`Symbol: ${options.symbol}`);
  console.log(`Format: ${options.format}`);
  console.log(`Output: ${options.outputDir}`);
  if (options.dryRun) console.log('[DRY RUN MODE]');
  console.log('='.repeat(60));

  // Fetch avatars
  console.log('\nFetching avatars...');
  const avatars = await fetchAvatars(options.avatarId);
  console.log(`Found ${avatars.length} avatar(s)`);

  if (avatars.length === 0) {
    console.log('No avatars to export.');
    return;
  }

  // Generate metadata for each avatar
  const evmDir = path.join(options.outputDir, 'evm');
  const svmDir = path.join(options.outputDir, 'svm');

  // Write collection metadata
  if (options.format === 'evm' || options.format === 'both') {
    const evmCollection = generateEVMCollectionMetadata(options);
    writeMetadataFile(path.join(evmDir, 'collection.json'), evmCollection, options.dryRun);
  }

  if (options.format === 'svm' || options.format === 'both') {
    const svmCollection = generateSVMCollectionMetadata(options);
    writeMetadataFile(path.join(svmDir, 'collection.json'), svmCollection, options.dryRun);
  }

  // Write individual avatar metadata
  avatars.forEach((avatar, index) => {
    const tokenId = index + 1;
    console.log(`\nProcessing: ${avatar.name} (${avatar.avatarId}) -> Token #${tokenId}`);

    if (options.format === 'evm' || options.format === 'both') {
      const evmMetadata = generateEVMMetadata(avatar, options, tokenId);
      writeMetadataFile(path.join(evmDir, `${tokenId}.json`), evmMetadata, options.dryRun);
    }

    if (options.format === 'svm' || options.format === 'both') {
      const svmMetadata = generateSVMMetadata(avatar, options, tokenId);
      writeMetadataFile(path.join(svmDir, `${tokenId}.json`), svmMetadata, options.dryRun);
    }
  });

  // Write manifest
  const manifest = {
    collection: options.collectionName,
    symbol: options.symbol,
    totalSupply: avatars.length,
    exportedAt: new Date().toISOString(),
    avatars: avatars.map((a, i) => ({
      tokenId: i + 1,
      avatarId: a.avatarId,
      name: a.name,
    })),
  };

  writeMetadataFile(
    path.join(options.outputDir, 'manifest.json'),
    manifest as unknown as CollectionMetadata,
    options.dryRun
  );

  console.log('\n' + '='.repeat(60));
  console.log('Export complete!');
  console.log(`Total avatars: ${avatars.length}`);
  if (!options.dryRun) {
    console.log(`Output directory: ${options.outputDir}`);
  }
  console.log('='.repeat(60));
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): ExportOptions {
  const args = process.argv.slice(2);
  const options: ExportOptions = {
    outputDir: './nft-export',
    format: 'both',
    collectionName: 'RATi Avatars',
    symbol: 'RATI',
    dryRun: false,
    sellerFeeBasisPoints: 500,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--output':
      case '-o':
        options.outputDir = next;
        i++;
        break;
      case '--format':
      case '-f':
        if (next === 'evm' || next === 'svm' || next === 'both') {
          options.format = next;
        }
        i++;
        break;
      case '--avatar':
      case '-a':
        options.avatarId = next;
        i++;
        break;
      case '--collection':
        options.collectionName = next;
        i++;
        break;
      case '--symbol':
        options.symbol = next;
        i++;
        break;
      case '--base-uri':
        options.baseUri = next;
        i++;
        break;
      case '--image-base-uri':
        options.imageBaseUri = next;
        i++;
        break;
      case '--creator':
        options.creatorAddress = next;
        i++;
        break;
      case '--royalty':
        options.sellerFeeBasisPoints = parseInt(next, 10);
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
RATi Avatar NFT Metadata Export Script

Usage:
  npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts [options]

Options:
  --output, -o <dir>       Output directory (default: ./nft-export)
  --format, -f <format>    Format: 'evm', 'svm', or 'both' (default: both)
  --avatar, -a <id>        Export specific avatar ID (default: all)
  --collection <name>      Collection name (default: RATi Avatars)
  --symbol <sym>           Collection symbol (default: RATI)
  --base-uri <uri>         Base URI for metadata
  --image-base-uri <uri>   Base URI for images
  --creator <address>      Creator wallet address
  --royalty <bps>          Royalty in basis points (default: 500 = 5%)
  --dry-run                Preview without writing files
  --help, -h               Show this help message

Environment:
  ADMIN_TABLE              DynamoDB table name (required)
  AWS_REGION               AWS region

Examples:
  # Export all avatars
  npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts

  # Export to IPFS-ready format
  npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts \\
    --image-base-uri "ipfs://QmXXX/images" \\
    --collection "RATi Genesis" \\
    --creator "YourWalletAddress"
`);
        process.exit(0);
    }
  }

  return options;
}

// Run
const options = parseArgs();
exportAvatarNFTs(options).catch((error) => {
  console.error('Export failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
