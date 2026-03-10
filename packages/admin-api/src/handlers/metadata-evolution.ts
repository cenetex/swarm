/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Metadata Evolution Scheduled Handler
 *
 * EventBridge scheduled rule triggers this Lambda monthly to evolve
 * Ascension NFT metadata with up-to-date avatar lifetime stats.
 *
 * The handler scans for all ascended avatars, generates evolved metadata,
 * uploads it to Arweave, and records the new URI. On-chain URI update
 * is deferred until Metaplex Umi SDK integration is complete.
 */
import type { ScheduledEvent } from 'aws-lambda';
import { evolveAllAscensionMetadata } from '../services/web3/ascension-metadata-evolution.js';
import type { ArweaveServiceConfig } from '../services/web3/arweave.js';

export async function handler(event: ScheduledEvent): Promise<void> {
  console.log('[MetadataEvolution] Triggered by EventBridge', {
    time: event.time,
    source: event.source,
  });

  const arweaveConfig: ArweaveServiceConfig = {
    network: (process.env.ARWEAVE_NETWORK as 'mainnet' | 'devnet') || 'devnet',
    walletSecretName: process.env.ARWEAVE_WALLET_SECRET || 'swarm/arweave-wallet',
    rpcUrl: process.env.IRYS_RPC_URL,
  };

  // Default cooldown: 7 days (avatars evolved within the last 7 days are skipped)
  const cooldownMs = parseInt(process.env.EVOLUTION_COOLDOWN_DAYS || '7', 10) * 24 * 60 * 60 * 1000;

  const result = await evolveAllAscensionMetadata(arweaveConfig, cooldownMs);

  console.log('[MetadataEvolution] Complete', {
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
  });

  // Log individual failures for debugging
  for (const r of result.results) {
    if (!r.success && !r.skipped) {
      console.error(`[MetadataEvolution] FAILED ${r.avatarId} (${r.avatarName}): ${r.error}`);
    }
  }
}
