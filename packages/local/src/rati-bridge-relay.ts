/**
 * RATi Bridge Relay — auto-submit chain log proofs and claim bounties.
 *
 * When a RATi mining event is detected, this service submits the
 * bridge transaction and if the station has a relayBounty set,
 * automatically transfers the bounty to the submitter.
 *
 * The station pays from its own RATi balance — no protocol-level
 * minting for relayers. Each station sets its own bounty.
 */
import { toBase58 } from "@swarm/core";

/** Default relay bounty in RATi base units (0.1 RATi = 100,000,000) */
const DEFAULT_RELAY_BOUNTY = 100_000_000;

export interface RelayConfig {
  /** Relay bounty in RATi base units (9 decimals). Default 0.1 RATi. */
  relayBounty: number;
  /** Station pubkey (base58) that owns the RATi */
  stationPubkey: string;
  /** Station secret key for signing transfers (64 bytes NaCl format) */
  stationSecretKey?: Uint8Array;
}

/**
 * Submit a bridge transaction for a RATi mining event.
 * Returns the transaction signature and the submitter address.
 */
export async function submitBridgeProof(params: {
  chainLogEvent: Uint8Array;
  ed25519Signature: Uint8Array;
  stationPubkey: Uint8Array;
  submitterKeypair: Uint8Array;  // Solana keypair (64 bytes)
}): Promise<{ txSig: string; submitterAddress: string }> {
  // Build the bridge instruction data:
  // [2][station_pk:32][event_len:2][event:event_len][sig:64]
  const ixData = new Uint8Array(1 + 32 + 2 + params.chainLogEvent.length + 64);
  ixData[0] = 2; // IX_BRIDGE_PROOF
  ixData.set(params.stationPubkey, 1);
  // event_len (u16 LE)
  ixData[33] = params.chainLogEvent.length & 0xFF;
  ixData[34] = (params.chainLogEvent.length >> 8) & 0xFF;
  ixData.set(params.chainLogEvent, 35);
  ixData.set(params.ed25519Signature, 35 + params.chainLogEvent.length);

  // For now, return simulated result since we can'\''t sign Solana tx from Node easily
  const submitterAddress = toBase58(params.submitterKeypair.slice(32));
  return {
    txSig: "sim-" + Date.now().toString(36),
    submitterAddress,
  };
}

/**
 * Transfer RATi from station to submitter as a relay bounty.
 * Returns the transaction signature.
 */
export async function transferRelayBounty(params: {
  fromPubkey: string;
  toPubkey: string;
  amount: number; // base units (9 decimals)
  stationSecretKey: Uint8Array;
}): Promise<{ txSig: string }> {
  // In production: construct and sign a Solana token transfer
  // For now: log the intent
  console.log(
    `[RATi relay] ${params.amount / 1e9} RATi bounty: ${params.fromPubkey.slice(0, 8)}... → ${params.toPubkey.slice(0, 8)}...`
  );
  return { txSig: "sim-relay-" + Date.now().toString(36) };
}

/**
 * Get the relay bounty for a station.
 */
export function getRelayBounty(config?: Partial<RelayConfig>): number {
  return config?.relayBounty ?? DEFAULT_RELAY_BOUNTY;
}
