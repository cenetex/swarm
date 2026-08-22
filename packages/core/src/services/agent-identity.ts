/**
 * Agent Identity Service
 *
 * Gives every avatar an Ed25519 keypair (Body 4 of the Five Bodies).
 * Compatible with Signal stations (TweetNaCl), Solana (same curve),
 * and raticross (ActorSchema.pubkey).
 *
 * The keypair is stored encrypted via the existing secrets infrastructure.
 * The seed never touches disk unencrypted.
 */
import nacl from "tweetnacl";
import { createHash, randomBytes } from "node:crypto";
import { keccak256 } from "js-sha3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentKeypair {
  /** 32-byte secret seed */
  seed: Uint8Array;
  /** 32-byte public key */
  pubkey: Uint8Array;
  /** 64-byte NaCl secret key (seed || pubkey) */
  secretKey: Uint8Array;
}

export interface AgentIdentity {
  /** base58-encoded Ed25519 public key */
  pubkey: string;
  /** encrypted seed material (base64) */
  encryptedSeed: string;
  /** how the keypair was created */
  derivation: {
    type: "random" | "derived";
    /** derivation provenance string, if derived */
    provenance?: string;
  };
}

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

/**
 * Generate a new random Ed25519 keypair.
 * Returns raw bytes; caller must encrypt the seed before storage.
 */
export function generateAgentKeypair(): AgentKeypair {
  const seed = randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    seed,
    pubkey: kp.publicKey,
    secretKey: kp.secretKey, // NaCl format: 64 bytes (seed || pubkey)
  };
}

/**
 * Derive a keypair deterministically from a seed phrase and provenance string.
 * Uses SHA-512 of (seed || provenance) as the Ed25519 seed.
 * Matches Signal's station key derivation pattern.
 */
export function deriveAgentKeypair(seedPhrase: string, provenance: string): AgentKeypair {
  const hash = createHash("sha512")
    .update(seedPhrase)
    .update(":")
    .update(provenance)
    .digest();
  const seed = hash.subarray(0, 32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    seed,
    pubkey: kp.publicKey,
    secretKey: kp.secretKey,
  };
}

/**
 * Sign a message with the agent's keypair.
 * Returns the signature as a Uint8Array (64 bytes, Ed25519).
 */
export function signMessage(keypair: AgentKeypair, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, keypair.secretKey);
}

/**
 * Verify a signature against the agent's public key.
 */
export function verifySignature(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, pubkey);
}



// ---------------------------------------------------------------------------
// Signal station binding (Phase 1)
// ---------------------------------------------------------------------------

export interface StationPosition {
  /** X coordinate in Signal world space */
  x: number;
  /** Y coordinate in Signal world space */
  y: number;
}

/**
 * Derive a Signal station position from the agent's pubkey.
 * Uses SHA256(pubkey || "station") to produce deterministic coordinates.
 * Same approach as Signal's asteroid belt seeding — cryptographic scattering.
 */
export function deriveStationPosition(pubkey: Uint8Array): StationPosition {
  const hash = createHash("sha256")
    .update(pubkey)
    .update("station")
    .digest();
  
  // Map hash bytes to coordinates in a reasonable Signal world range
  // Signal world is typically [-10000, 10000] in both axes
  const x = ((hash[0] << 24 | hash[1] << 16 | hash[2] << 8 | hash[3]) >>> 0) % 20000 - 10000;
  const y = ((hash[4] << 24 | hash[5] << 16 | hash[6] << 8 | hash[7]) >>> 0) % 20000 - 10000;
  
  return { x, y };
}

/**
 * Export the keypair in NaCl format (64 bytes: seed || pubkey) for Signal.
 * The caller must handle secure key material — this function returns the raw
 * secret key bytes which should never be persisted unencrypted.
 */
export function exportKeypairForSignal(keypair: AgentKeypair): Uint8Array {
  return keypair.secretKey;
}

// ---------------------------------------------------------------------------
// Derived wallet addresses (Phase 0 — cross-chain identity)
// ---------------------------------------------------------------------------

export interface AgentWalletAddresses {
  /** base58-encoded Solana address (same as the agent pubkey) */
  solana: string;
  /** 0x-prefixed hex EVM address (keccak256 of pubkey, last 20 bytes) */
  evm: string;
}

/**
 * Derive cross-chain wallet addresses from the agent's public key.
 * Solana: the raw Ed25519 pubkey IS the Solana wallet address.
 * EVM: keccak256(pubkey) → last 20 bytes → 0x-prefixed hex.
 */
export function deriveWalletAddresses(pubkey: Uint8Array): AgentWalletAddresses {
  const solana = toBase58(pubkey);
  const hash = keccak256.create();
  hash.update(pubkey);
  const evmBytes = new Uint8Array(hash.arrayBuffer()).slice(12, 32); // last 20 bytes
  const evm = "0x" + toHex(evmBytes);
  return { solana, evm };
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Bitcoin-style base58 (compatible with Solana). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(buf: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zeros
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    digits.push(0);
  }
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join("");
}

export function fromBase58(value: string): Uint8Array {
  const bytes = [0];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < value.length && value[i] === BASE58_ALPHABET[0]; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
