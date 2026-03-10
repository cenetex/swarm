/**
 * Arweave Upload Service
 *
 * Programmatic interface for uploading NFT metadata to Arweave via Irys.
 * Extracted from the CLI script for use in automated pipelines (e.g.
 * scheduled metadata evolution for Ascension NFTs).
 *
 * Wallet key is loaded from AWS Secrets Manager at runtime.
 * The Irys SDK is imported dynamically so the service degrades gracefully
 * if the optional dependency is not installed.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IrysClient = any;

export interface ArweaveUploadResult {
  arweaveId: string;
  arweaveUri: string;
  sizeBytes: number;
}

export interface ArweaveServiceConfig {
  /** 'mainnet' or 'devnet'. Default: 'devnet'. */
  network?: 'mainnet' | 'devnet';
  /** Payment token. Default: 'solana'. */
  token?: 'solana' | 'ethereum' | 'matic' | 'arweave';
  /** Secrets Manager secret name containing the wallet keypair JSON. */
  walletSecretName?: string;
  /** Direct wallet key (base58 or JSON array). Takes precedence over Secrets Manager. */
  walletKey?: string;
  /** Custom RPC URL for the payment network. */
  rpcUrl?: string;
}

const DEFAULT_WALLET_SECRET = process.env.ARWEAVE_WALLET_SECRET || 'swarm/arweave-wallet';

let _secretsClient: SecretsManagerClient | null = null;
function getSecretsClient(): SecretsManagerClient {
  if (!_secretsClient) {
    _secretsClient = new SecretsManagerClient({});
  }
  return _secretsClient;
}

/**
 * Resolve the wallet key — direct config, env var, or Secrets Manager.
 */
async function resolveWalletKey(config: ArweaveServiceConfig): Promise<string | object> {
  // 1. Direct config
  if (config.walletKey) {
    try {
      return JSON.parse(config.walletKey);
    } catch {
      return config.walletKey; // base58 string
    }
  }

  // 2. Environment variable
  if (process.env.IRYS_WALLET_KEY) {
    try {
      return JSON.parse(process.env.IRYS_WALLET_KEY);
    } catch {
      return process.env.IRYS_WALLET_KEY;
    }
  }

  // 3. Secrets Manager
  const secretName = config.walletSecretName || DEFAULT_WALLET_SECRET;
  const result = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );

  if (!result.SecretString) {
    throw new Error(`Wallet secret '${secretName}' is empty`);
  }

  try {
    return JSON.parse(result.SecretString);
  } catch {
    return result.SecretString;
  }
}

/**
 * Create and connect an Irys client.
 */
async function createIrysClient(config: ArweaveServiceConfig): Promise<IrysClient> {
  let Irys: new (cfg: object) => IrysClient;
  try {
    // @ts-expect-error — Optional dependency
    const mod = await import('@irys/sdk');
    Irys = mod.default;
  } catch {
    throw new Error('@irys/sdk not installed. Run: pnpm add @irys/sdk');
  }

  const network = config.network || 'devnet';
  const url = network === 'mainnet'
    ? 'https://node1.irys.xyz'
    : 'https://devnet.irys.xyz';

  const key = await resolveWalletKey(config);
  const rpcUrl = config.rpcUrl || process.env.IRYS_RPC_URL;

  const irys = new Irys({
    url,
    token: config.token || 'solana',
    key,
    config: rpcUrl ? { providerUrl: rpcUrl } : undefined,
  });

  await irys.ready();
  return irys;
}

/**
 * Upload a JSON object to Arweave and return the permanent URI.
 */
export async function uploadJsonToArweave(
  data: object,
  config: ArweaveServiceConfig = {},
): Promise<ArweaveUploadResult> {
  const irys = await createIrysClient(config);

  const jsonStr = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(jsonStr, 'utf-8');

  const response = await irys.upload(buffer, {
    tags: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'RATi-Avatar-NFT' },
      { name: 'Upload-Type', value: 'metadata-evolution' },
    ],
  });

  return {
    arweaveId: response.id,
    arweaveUri: `https://arweave.net/${response.id}`,
    sizeBytes: buffer.length,
  };
}

/**
 * Upload a binary buffer (e.g. image) to Arweave.
 */
export async function uploadBufferToArweave(
  buffer: Buffer,
  contentType: string,
  config: ArweaveServiceConfig = {},
): Promise<ArweaveUploadResult> {
  const irys = await createIrysClient(config);

  const response = await irys.upload(buffer, {
    tags: [
      { name: 'Content-Type', value: contentType },
      { name: 'App-Name', value: 'RATi-Avatar-NFT' },
    ],
  });

  return {
    arweaveId: response.id,
    arweaveUri: `https://arweave.net/${response.id}`,
    sizeBytes: buffer.length,
  };
}

/**
 * Estimate the cost (in payment token) for uploading a given number of bytes.
 */
export async function estimateUploadCost(
  sizeBytes: number,
  config: ArweaveServiceConfig = {},
): Promise<{ cost: string; token: string }> {
  const irys = await createIrysClient(config);
  const price = await irys.getPrice(sizeBytes);
  return {
    cost: irys.utils.fromAtomic(price),
    token: config.token || 'solana',
  };
}
