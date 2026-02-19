#!/usr/bin/env npx tsx
/**
 * Upload NFT Assets to Arweave via Irys
 *
 * Uploads avatar images and metadata to Arweave using Irys (formerly Bundlr).
 * Arweave provides permanent, decentralized storage ideal for NFT assets.
 *
 * Usage:
 *   npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts [options]
 *
 * Options:
 *   --input, -i       Input directory (default: ./nft-export)
 *   --network, -n     Irys network: 'mainnet' or 'devnet' (default: devnet)
 *   --token, -t       Payment token: 'solana', 'ethereum', 'matic', 'arweave' (default: solana)
 *   --wallet, -w      Path to wallet keypair JSON file
 *   --images-only     Only upload images, skip metadata
 *   --metadata-only   Only upload metadata (requires --image-base-uri)
 *   --image-base-uri  Arweave URI for images (for metadata-only mode)
 *   --dry-run         Estimate costs without uploading
 *
 * Environment:
 *   IRYS_WALLET_KEY   Base58 private key (alternative to --wallet file)
 *   IRYS_RPC_URL      Custom RPC URL for the payment network
 *
 * Prerequisites:
 *   npm install @irys/sdk
 *
 * Example Workflow:
 *   1. Export avatars:
 *      npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts
 *
 *   2. Download images:
 *      npx tsx packages/admin-api/src/scripts/prepare-nft-images.ts
 *
 *   3. Upload to Arweave:
 *      npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts \\
 *        --wallet ~/.config/solana/id.json \\
 *        --network mainnet
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

interface UploadOptions {
  inputDir: string;
  network: 'mainnet' | 'devnet';
  token: 'solana' | 'ethereum' | 'matic' | 'arweave';
  walletPath?: string;
  imagesOnly: boolean;
  metadataOnly: boolean;
  imageBaseUri?: string;
  dryRun: boolean;
  format: 'evm' | 'svm' | 'both';
}

interface UploadResult {
  filename: string;
  arweaveId: string;
  arweaveUri: string;
  size: number;
}

interface UploadManifest {
  uploadedAt: string;
  network: string;
  token: string;
  totalFiles: number;
  totalBytes: number;
  images: UploadResult[];
  metadata: {
    evm: UploadResult[];
    svm: UploadResult[];
  };
  collectionMetadata?: {
    evm?: UploadResult;
    svm?: UploadResult;
  };
}

// =============================================================================
// Irys Client Setup
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IrysClient = any;

async function createIrysClient(options: UploadOptions): Promise<IrysClient> {
  // Dynamic import to handle optional dependency
  let Irys: new (config: object) => IrysClient;
  try {
    // @ts-expect-error - Optional dependency, may not be installed
    const module = await import('@irys/sdk');
    Irys = module.default;
  } catch {
    console.error('Error: @irys/sdk not installed. Run: npm install @irys/sdk');
    process.exit(1);
  }

  const url = options.network === 'mainnet'
    ? 'https://node1.irys.xyz'
    : 'https://devnet.irys.xyz';

  // Get wallet key
  let key: string | object;
  if (options.walletPath) {
    const walletData = fs.readFileSync(options.walletPath, 'utf-8');
    key = JSON.parse(walletData);
  } else if (process.env.IRYS_WALLET_KEY) {
    key = process.env.IRYS_WALLET_KEY;
  } else {
    console.error('Error: No wallet provided. Use --wallet or set IRYS_WALLET_KEY');
    process.exit(1);
  }

  const rpcUrl = process.env.IRYS_RPC_URL;

  const irys = new Irys({
    url,
    token: options.token,
    key,
    config: rpcUrl ? { providerUrl: rpcUrl } : undefined,
  });

  await irys.ready();
  return irys;
}

// =============================================================================
// File Operations
// =============================================================================

function getFilesInDir(dir: string, extension?: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter(f => !extension || f.endsWith(extension))
    .map(f => path.join(dir, f))
    .filter(f => fs.statSync(f).isFile());
}

function getFileSize(filepath: string): number {
  return fs.statSync(filepath).size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// =============================================================================
// Upload Functions
// =============================================================================

async function uploadFile(
  irys: { uploadFile: (path: string, opts?: object) => Promise<{ id: string }> },
  filepath: string,
  contentType: string
): Promise<UploadResult> {
  const filename = path.basename(filepath);
  const size = getFileSize(filepath);

  console.log(`  Uploading ${filename} (${formatBytes(size)})...`);

  const response = await irys.uploadFile(filepath, {
    tags: [
      { name: 'Content-Type', value: contentType },
      { name: 'App-Name', value: 'RATi-Avatar-NFT' },
    ],
  });

  const arweaveUri = `https://arweave.net/${response.id}`;
  console.log(`  ✓ ${filename} -> ${arweaveUri}`);

  return {
    filename,
    arweaveId: response.id,
    arweaveUri,
    size,
  };
}

async function estimateCost(
  irys: { getPrice: (size: number) => Promise<{ toString: () => string }> },
  totalBytes: number
): Promise<string> {
  const price = await irys.getPrice(totalBytes);
  return price.toString();
}

// =============================================================================
// Main Upload Function
// =============================================================================

async function uploadToArweave(options: UploadOptions): Promise<void> {
  console.log('='.repeat(60));
  console.log('RATi Avatar NFT - Arweave Upload');
  console.log('='.repeat(60));
  console.log(`Input: ${options.inputDir}`);
  console.log(`Network: ${options.network}`);
  console.log(`Token: ${options.token}`);
  if (options.dryRun) console.log('[DRY RUN MODE - Estimating costs only]');
  console.log('='.repeat(60));

  // Collect files to upload
  const imagesDir = path.join(options.inputDir, 'images');
  const evmDir = path.join(options.inputDir, 'evm');
  const svmDir = path.join(options.inputDir, 'svm');

  const imageFiles = options.metadataOnly ? [] : getFilesInDir(imagesDir, '.png');
  const evmMetadataFiles = options.imagesOnly ? [] : getFilesInDir(evmDir, '.json');
  const svmMetadataFiles = options.imagesOnly ? [] : getFilesInDir(svmDir, '.json');

  console.log(`\nFiles to upload:`);
  console.log(`  Images: ${imageFiles.length}`);
  console.log(`  EVM Metadata: ${evmMetadataFiles.length}`);
  console.log(`  SVM Metadata: ${svmMetadataFiles.length}`);

  const totalBytes = [
    ...imageFiles,
    ...evmMetadataFiles,
    ...svmMetadataFiles,
  ].reduce((sum, f) => sum + getFileSize(f), 0);

  console.log(`  Total size: ${formatBytes(totalBytes)}`);

  // Create Irys client
  console.log('\nConnecting to Irys...');
  const irys = await createIrysClient(options);
  console.log(`Connected! Wallet balance: ${irys.utils.fromAtomic(await irys.getLoadedBalance())} ${options.token}`);

  // Estimate cost
  const estimatedCost = await estimateCost(irys, totalBytes);
  console.log(`Estimated cost: ${irys.utils.fromAtomic(estimatedCost)} ${options.token}`);

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would upload files. Exiting.');
    return;
  }

  // Upload images first
  const manifest: UploadManifest = {
    uploadedAt: new Date().toISOString(),
    network: options.network,
    token: options.token,
    totalFiles: 0,
    totalBytes: 0,
    images: [],
    metadata: {
      evm: [],
      svm: [],
    },
  };

  if (imageFiles.length > 0 && !options.metadataOnly) {
    console.log('\n--- Uploading Images ---');
    for (const filepath of imageFiles) {
      const result = await uploadFile(irys, filepath, 'image/png');
      manifest.images.push(result);
      manifest.totalFiles++;
      manifest.totalBytes += result.size;
    }
  }

  // Get image base URI for metadata update
  let imageBaseUri = options.imageBaseUri;
  if (!imageBaseUri && manifest.images.length > 0) {
    // Use the first image's base path (remove filename)
    const firstImage = manifest.images.find(i => i.filename === '1.png');
    if (firstImage) {
      imageBaseUri = `https://arweave.net`;
    }
  }

  // Upload EVM metadata
  if (evmMetadataFiles.length > 0 && !options.imagesOnly) {
    console.log('\n--- Uploading EVM Metadata ---');

    // Update metadata with Arweave image URIs before uploading
    for (const filepath of evmMetadataFiles) {
      const filename = path.basename(filepath);

      // Update image URI in metadata if we uploaded images
      if (imageBaseUri && filename !== 'collection.json') {
        const tokenId = filename.replace('.json', '');
        const imageResult = manifest.images.find(i => i.filename === `${tokenId}.png`);

        if (imageResult) {
          const metadata = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
          metadata.image = imageResult.arweaveUri;
          fs.writeFileSync(filepath, JSON.stringify(metadata, null, 2));
        }
      }

      const result = await uploadFile(irys, filepath, 'application/json');

      if (filename === 'collection.json') {
        manifest.collectionMetadata = manifest.collectionMetadata || {};
        manifest.collectionMetadata.evm = result;
      } else {
        manifest.metadata.evm.push(result);
      }

      manifest.totalFiles++;
      manifest.totalBytes += result.size;
    }
  }

  // Upload SVM metadata
  if (svmMetadataFiles.length > 0 && !options.imagesOnly) {
    console.log('\n--- Uploading SVM Metadata ---');

    for (const filepath of svmMetadataFiles) {
      const filename = path.basename(filepath);

      // Update image URI in metadata if we uploaded images
      if (imageBaseUri && filename !== 'collection.json') {
        const tokenId = filename.replace('.json', '');
        const imageResult = manifest.images.find(i => i.filename === `${tokenId}.png`);

        if (imageResult) {
          const metadata = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
          metadata.image = imageResult.arweaveUri;

          // Also update files array for Metaplex
          if (metadata.properties?.files) {
            metadata.properties.files = metadata.properties.files.map((f: { uri: string; type: string }) => ({
              ...f,
              uri: f.type === 'image/png' ? imageResult.arweaveUri : f.uri,
            }));
          }

          fs.writeFileSync(filepath, JSON.stringify(metadata, null, 2));
        }
      }

      const result = await uploadFile(irys, filepath, 'application/json');

      if (filename === 'collection.json') {
        manifest.collectionMetadata = manifest.collectionMetadata || {};
        manifest.collectionMetadata.svm = result;
      } else {
        manifest.metadata.svm.push(result);
      }

      manifest.totalFiles++;
      manifest.totalBytes += result.size;
    }
  }

  // Write upload manifest
  const manifestPath = path.join(options.inputDir, 'arweave-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest: ${manifestPath}`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Upload Complete!');
  console.log('='.repeat(60));
  console.log(`Total files: ${manifest.totalFiles}`);
  console.log(`Total size: ${formatBytes(manifest.totalBytes)}`);

  if (manifest.collectionMetadata?.svm) {
    console.log(`\nSVM Collection Metadata: ${manifest.collectionMetadata.svm.arweaveUri}`);
  }
  if (manifest.collectionMetadata?.evm) {
    console.log(`EVM Collection Metadata: ${manifest.collectionMetadata.evm.arweaveUri}`);
  }

  if (manifest.metadata.svm.length > 0) {
    console.log(`\nSVM Token Metadata URIs:`);
    manifest.metadata.svm.slice(0, 3).forEach(m => {
      console.log(`  ${m.filename}: ${m.arweaveUri}`);
    });
    if (manifest.metadata.svm.length > 3) {
      console.log(`  ... and ${manifest.metadata.svm.length - 3} more`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Next Steps for Minting:');
  console.log('='.repeat(60));
  console.log('1. Use the Arweave URIs from arweave-manifest.json');
  console.log('2. For Solana (Metaplex):');
  console.log('   - Set metadata URI to the SVM JSON URIs');
  console.log('   - Example: sugar upload with arweave config');
  console.log('3. For EVM (OpenSea):');
  console.log('   - Set tokenURI to return the EVM JSON URIs');
  console.log('   - Or use a baseURI pattern');
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): UploadOptions {
  const args = process.argv.slice(2);
  const options: UploadOptions = {
    inputDir: './nft-export',
    network: 'devnet',
    token: 'solana',
    imagesOnly: false,
    metadataOnly: false,
    dryRun: false,
    format: 'both',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--input':
      case '-i':
        options.inputDir = next;
        i++;
        break;
      case '--network':
      case '-n':
        if (next === 'mainnet' || next === 'devnet') {
          options.network = next;
        }
        i++;
        break;
      case '--token':
      case '-t':
        if (next === 'solana' || next === 'ethereum' || next === 'matic' || next === 'arweave') {
          options.token = next;
        }
        i++;
        break;
      case '--wallet':
      case '-w':
        options.walletPath = next;
        i++;
        break;
      case '--images-only':
        options.imagesOnly = true;
        break;
      case '--metadata-only':
        options.metadataOnly = true;
        break;
      case '--image-base-uri':
        options.imageBaseUri = next;
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
RATi Avatar NFT - Arweave Upload Script

Uploads NFT images and metadata to Arweave via Irys for permanent storage.

Usage:
  npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts [options]

Options:
  --input, -i <dir>       Input directory (default: ./nft-export)
  --network, -n <net>     Irys network: 'mainnet' or 'devnet' (default: devnet)
  --token, -t <token>     Payment token: 'solana', 'ethereum', 'matic', 'arweave'
  --wallet, -w <path>     Path to wallet keypair JSON file
  --images-only           Only upload images
  --metadata-only         Only upload metadata
  --image-base-uri <uri>  Arweave base URI for images (for metadata-only)
  --dry-run               Estimate costs without uploading
  --help, -h              Show this help message

Environment:
  IRYS_WALLET_KEY         Base58 private key (alternative to --wallet)
  IRYS_RPC_URL            Custom RPC URL for the payment network

Prerequisites:
  npm install @irys/sdk

Example Workflow:
  # 1. Export and prepare
  npx tsx packages/admin-api/src/scripts/export-avatar-nfts.ts
  npx tsx packages/admin-api/src/scripts/prepare-nft-images.ts

  # 2. Estimate costs (dry run)
  npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts \\
    --wallet ~/.config/solana/id.json --dry-run

  # 3. Upload to devnet first
  npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts \\
    --wallet ~/.config/solana/id.json --network devnet

  # 4. Upload to mainnet
  npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts \\
    --wallet ~/.config/solana/id.json --network mainnet

Arweave URIs:
  All files are accessible at: https://arweave.net/{transactionId}
  URIs are permanent and immutable.
`);
        process.exit(0);
    }
  }

  return options;
}

// Run
const options = parseArgs();
uploadToArweave(options).catch((error) => {
  console.error('Upload failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
