#!/usr/bin/env npx tsx
/**
 * Prepare Avatar Images for NFT Collection
 *
 * Downloads avatar profile images and prepares them for IPFS upload.
 * Works in conjunction with export-avatar-nfts.ts to create a complete
 * NFT collection ready for minting.
 *
 * Usage:
 *   npx tsx packages/admin-api/src/scripts/prepare-nft-images.ts [options]
 *
 * Options:
 *   --output, -o    Output directory (default: ./nft-export/images)
 *   --avatar, -a    Download specific avatar ID (default: all)
 *   --size          Image size in pixels (default: 512)
 *   --format        Image format: 'png' or 'webp' (default: png)
 *   --dry-run       Preview without downloading
 *
 * Environment:
 *   ADMIN_TABLE     DynamoDB table name (required)
 *   AWS_REGION      AWS region
 *
 * Output Structure:
 *   ./nft-export/images/
 *     1.png         - Token #1 image
 *     2.png         - Token #2 image
 *     ...
 *     collection.png - Collection cover image
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import * as fs from 'fs';
import * as path from 'path';
import type { AvatarRecord } from '../types.js';

interface PrepareOptions {
  outputDir: string;
  avatarId?: string;
  size: number;
  format: 'png' | 'webp';
  dryRun: boolean;
}

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

async function downloadImage(
  url: string,
  filepath: string,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log(`[DRY RUN] Would download: ${url} -> ${filepath}`);
    return true;
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      console.error(`Failed to download ${url}: HTTP ${response.status}`);
      return false;
    }

    const buffer = await response.arrayBuffer();
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`Downloaded: ${filepath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading ${url}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function prepareNFTImages(options: PrepareOptions): Promise<void> {
  console.log('='.repeat(60));
  console.log('RATi Avatar NFT Image Preparation');
  console.log('='.repeat(60));
  console.log(`Output: ${options.outputDir}`);
  console.log(`Format: ${options.format}`);
  console.log(`Size: ${options.size}px`);
  if (options.dryRun) console.log('[DRY RUN MODE]');
  console.log('='.repeat(60));

  // Fetch avatars
  console.log('\nFetching avatars...');
  const avatars = await fetchAvatars(options.avatarId);
  console.log(`Found ${avatars.length} avatar(s)`);

  if (avatars.length === 0) {
    console.log('No avatars to process.');
    return;
  }

  // Download images
  let successCount = 0;
  let failCount = 0;
  const manifest: Array<{ tokenId: number; avatarId: string; name: string; hasImage: boolean }> = [];

  for (let i = 0; i < avatars.length; i++) {
    const avatar = avatars[i];
    const tokenId = i + 1;
    const filename = `${tokenId}.${options.format}`;
    const filepath = path.join(options.outputDir, filename);

    console.log(`\n[${tokenId}/${avatars.length}] ${avatar.name} (${avatar.avatarId})`);

    const imageUrl = avatar.profileImage?.url;
    if (!imageUrl) {
      console.log('  No profile image URL');
      manifest.push({ tokenId, avatarId: avatar.avatarId, name: avatar.name, hasImage: false });
      failCount++;
      continue;
    }

    const success = await downloadImage(imageUrl, filepath, options.dryRun);
    manifest.push({ tokenId, avatarId: avatar.avatarId, name: avatar.name, hasImage: success });

    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Write image manifest
  const manifestPath = path.join(options.outputDir, 'image-manifest.json');
  const manifestData = {
    totalImages: avatars.length,
    successCount,
    failCount,
    format: options.format,
    preparedAt: new Date().toISOString(),
    images: manifest,
  };

  if (!options.dryRun) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
    console.log(`\nWrote manifest: ${manifestPath}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Image preparation complete!');
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  if (!options.dryRun) {
    console.log(`Output directory: ${options.outputDir}`);
  }
  console.log('='.repeat(60));

  // Print next steps
  console.log('\nNext Steps:');
  console.log('1. Upload images to IPFS:');
  console.log(`   npx ipfs-car pack ${options.outputDir} --output images.car`);
  console.log('   # or use NFT.Storage, Pinata, etc.');
  console.log('');
  console.log('2. Update metadata with IPFS URIs:');
  console.log('   npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts \\');
  console.log('     --image-base-uri "ipfs://YOUR_CID"');
}

function parseArgs(): PrepareOptions {
  const args = process.argv.slice(2);
  const options: PrepareOptions = {
    outputDir: './nft-export/images',
    size: 512,
    format: 'png',
    dryRun: false,
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
      case '--avatar':
      case '-a':
        options.avatarId = next;
        i++;
        break;
      case '--size':
        options.size = parseInt(next, 10);
        i++;
        break;
      case '--format':
        if (next === 'png' || next === 'webp') {
          options.format = next;
        }
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
RATi Avatar NFT Image Preparation Script

Downloads avatar profile images and prepares them for IPFS upload.

Usage:
  npx tsx packages/admin-api/src/scripts/prepare-nft-images.ts [options]

Options:
  --output, -o <dir>    Output directory (default: ./nft-export/images)
  --avatar, -a <id>     Download specific avatar ID (default: all)
  --size <pixels>       Target image size (default: 512)
  --format <fmt>        Image format: 'png' or 'webp' (default: png)
  --dry-run             Preview without downloading
  --help, -h            Show this help message

Environment:
  ADMIN_TABLE           DynamoDB table name (required)
  AWS_REGION            AWS region

Example Workflow:
  1. Download images:
     npx tsx packages/admin-api/src/scripts/prepare-nft-images.ts

  2. Upload to IPFS (using ipfs-car):
     npx ipfs-car pack ./nft-export/images --output images.car
     # Upload car file to NFT.Storage or similar

  3. Generate metadata with IPFS URIs:
     npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts \\
       --image-base-uri "ipfs://YOUR_IMAGES_CID"
`);
        process.exit(0);
    }
  }

  return options;
}

// Run
const options = parseArgs();
prepareNFTImages(options).catch((error) => {
  console.error('Image preparation failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
