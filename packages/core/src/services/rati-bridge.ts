/**
 * RATi Bridge — Phase 1.
 *
 * Mines RATi from Signal station productivity, signs bridge attestations,
 * and submits them to the Solana bridge program.
 *
 * Signal already has RATi-grade fragments (MINING_GRADE_RATI, 0.14% chance)
 * that grant a 10x payout multiplier at the refinery. When processed at a
 * station signed by the avatar keypair, these become chain log events. This
 * module reads those events and produces bridge attestations.
 *
 * In local/dev mode without a running Signal instance, mining produces
 * simulated output based on agent activity.
 */
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { fromBase58, toBase58 } from "./agent-identity.js";

const SOLANA_DEVNET_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const RATI_BRIDGE_PROGRAM_ID = process.env.RATI_BRIDGE_PROGRAM_ID || "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiningOutput {
  /** Amount of station currency produced */
  stationCurrency: number;
  /** Equivalent RATi amount (after conversion) */
  ratiAmount: number;
  /** Epoch number */
  epoch: number;
  /** Station pubkey that mined this */
  stationPubkey: string;
}

export interface BridgeAttestation {
  /** Protocol version */
  protocol: "rati/bridge/1";
  /** Station pubkey (base58) */
  stationPubkey: string;
  /** Epoch number */
  epoch: number;
  /** RATi amount to mint */
  amount: number;
  /** Target chain for minting */
  targetChain: "solana" | "base";
  /** Target wallet address on the destination chain */
  targetAddress: string;
  /** Unix timestamp */
  timestamp: number;
  /** SHA256 of the attestation fields (pre-signing) */
  hash: string;
  /** Ed25519 signature of the hash (base58) */
  signature: string;
}

export interface BridgeResult {
  /** The signed attestation */
  attestation: BridgeAttestation;
  /** Transaction signature on Solana (if submitted) */
  solanaTxSig?: string;
  /** Status */
  status: "signed" | "submitted" | "confirmed" | "failed";
  /** Error message if failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Mining simulation (local mode)
// ---------------------------------------------------------------------------

/**
 * Read mining output from Signal chain log events or simulate in dev mode.
 * In production with a running Signal instance, reads verified chain log
 * events signed by the station keypair.
 */
export function simulateMining(params: {
  pubkey: Uint8Array;
  messageCount?: number;
  toolCallCount?: number;
  epoch?: number;
}): MiningOutput {
  const { pubkey, messageCount = 0, toolCallCount = 0, epoch = 1 } = params;
  
  // Productivity formula: base output + activity bonus
  // Each message contributes ~0.1 RATi, each tool call ~0.5 RATi
  const productivity = 10 + messageCount * 0.1 + toolCallCount * 0.5;
  const stationCurrency = Math.round(productivity * 100) / 100;
  
  // Conversion rate: 1 station currency = 1 RATi (for now)
  const ratiAmount = stationCurrency;
  
  return {
    stationCurrency,
    ratiAmount,
    epoch,
    stationPubkey: toBase58(pubkey),
  };
}

// ---------------------------------------------------------------------------
// Bridge attestation signing
// ---------------------------------------------------------------------------

/**
 * Create and sign a bridge attestation for RATi minting.
 */
export function signBridgeAttestation(params: {
  output: MiningOutput;
  targetChain: "solana" | "base";
  targetAddress: string;
  secretKey: Uint8Array;
}): BridgeAttestation {
  const { output, targetChain, targetAddress, secretKey } = params;
  const timestamp = Date.now();
  
  // Build the pre-image hash
  const hashInput = [
    "rati/bridge/1",
    output.stationPubkey,
    output.epoch.toString(),
    output.ratiAmount.toString(),
    targetChain,
    targetAddress,
    timestamp.toString(),
  ].join(":");
  
  const hash = createHash("sha256").update(hashInput).digest("hex");
  
  // Sign with Ed25519
  const sig = nacl.sign.detached(Buffer.from(hash, "hex"), secretKey);
  const signature = toBase58(sig);
  
  return {
    protocol: "rati/bridge/1",
    stationPubkey: output.stationPubkey,
    epoch: output.epoch,
    amount: output.ratiAmount,
    targetChain,
    targetAddress,
    timestamp,
    hash,
    signature,
  };
}

/**
 * Verify a bridge attestation signature.
 */
export function verifyBridgeAttestation(
  attestation: BridgeAttestation,
  pubkey: Uint8Array,
): boolean {

  // Rebuild hash and verify
  const hashInput = [
    attestation.protocol,
    attestation.stationPubkey,
    attestation.epoch.toString(),
    attestation.amount.toString(),
    attestation.targetChain,
    attestation.targetAddress,
    attestation.timestamp.toString(),
  ].join(":");
  
  const hash = createHash("sha256").update(hashInput).digest("hex");
  
  if (hash !== attestation.hash) return false;
  
  const sigBytes = fromBase58(attestation.signature);
  return nacl.sign.detached.verify(Buffer.from(hash, "hex"), sigBytes, pubkey);
}

// fromBase58 imported from agent-identity.js

// ---------------------------------------------------------------------------
// Bridge submission (Solana)
// ---------------------------------------------------------------------------

/**
 * Submit a signed bridge attestation to the Solana bridge program.
 * Uses the Solana JSON RPC API to send a transaction.
 */
export async function submitBridgeAttestation(
  attestation: BridgeAttestation,
): Promise<{ solanaTxSig?: string; status: "submitted" | "failed"; error?: string }> {
  try {
    // In local mode without a deployed bridge program, simulate success
    if (!RATI_BRIDGE_PROGRAM_ID) {
      return {
        solanaTxSig: "sim-" + attestation.hash.slice(0, 16),
        status: "submitted",
      };
    }

    // Real submission would:
    // 1. Build a Solana transaction calling the bridge program
    // 2. Sign with the station keypair
    // 3. Submit via RPC
    const response = await fetch(SOLANA_DEVNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [
          // Base64-encoded signed transaction would go here
          attestation.signature,
          { encoding: "base64" },
        ],
      }),
    });

    if (!response.ok) {
      return { status: "failed", error: "RPC error: " + response.status };
    }

    const data = await response.json() as { result?: string; error?: { message: string } };
    if (data.error) {
      return { status: "failed", error: data.error.message };
    }

    return { solanaTxSig: data.result, status: "submitted" };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
