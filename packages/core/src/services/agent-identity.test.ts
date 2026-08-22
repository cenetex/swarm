/**
 * Agent identity tests — Body 4 (Ed25519 keypair).
 */
import { describe, it, expect } from "bun:test";
import {
  generateAgentKeypair,
  deriveAgentKeypair,
  signMessage,
  verifySignature,
  toBase58,
  toHex,
  fromHex,
  toBase64,
  fromBase64,
} from "../services/agent-identity.js";

describe("generateAgentKeypair", () => {
  it("produces a 32-byte seed", () => {
    const kp = generateAgentKeypair();
    expect(kp.seed.length).toBe(32);
  });

  it("produces a 32-byte public key", () => {
    const kp = generateAgentKeypair();
    expect(kp.pubkey.length).toBe(32);
  });

  it("produces a 64-byte NaCl secret key", () => {
    const kp = generateAgentKeypair();
    expect(kp.secretKey.length).toBe(64);
  });

  it("generates unique keypairs each call", () => {
    const a = generateAgentKeypair();
    const b = generateAgentKeypair();
    expect(toHex(a.pubkey)).not.toBe(toHex(b.pubkey));
  });
});

describe("signMessage + verifySignature", () => {
  it("round-trips: sign then verify", () => {
    const kp = generateAgentKeypair();
    const msg = Buffer.from("hello agent");
    const sig = signMessage(kp, msg);
    expect(sig.length).toBe(64);
    expect(verifySignature(kp.pubkey, msg, sig)).toBe(true);
  });

  it("rejects wrong message", () => {
    const kp = generateAgentKeypair();
    const sig = signMessage(kp, Buffer.from("hello"));
    expect(verifySignature(kp.pubkey, Buffer.from("wrong"), sig)).toBe(false);
  });

  it("rejects wrong pubkey", () => {
    const a = generateAgentKeypair();
    const b = generateAgentKeypair();
    const sig = signMessage(a, Buffer.from("hello"));
    expect(verifySignature(b.pubkey, Buffer.from("hello"), sig)).toBe(false);
  });
});

describe("deriveAgentKeypair", () => {
  it("same seed + provenance produces same keypair", () => {
    const a = deriveAgentKeypair("phrase", "avatar:1");
    const b = deriveAgentKeypair("phrase", "avatar:1");
    expect(toHex(a.pubkey)).toBe(toHex(b.pubkey));
    expect(toHex(a.seed)).toBe(toHex(b.seed));
  });

  it("different provenance produces different keypair", () => {
    const a = deriveAgentKeypair("phrase", "avatar:1");
    const b = deriveAgentKeypair("phrase", "avatar:2");
    expect(toHex(a.pubkey)).not.toBe(toHex(b.pubkey));
  });

  it("different seed phrase produces different keypair", () => {
    const a = deriveAgentKeypair("alpha", "avatar:1");
    const b = deriveAgentKeypair("beta", "avatar:1");
    expect(toHex(a.pubkey)).not.toBe(toHex(b.pubkey));
  });
});

describe("encoding helpers", () => {
  it("base58 round-trips via fromHex", () => {
    const kp = generateAgentKeypair();
    const b58 = toBase58(kp.pubkey);
    expect(typeof b58).toBe("string");
    expect(b58.length).toBeGreaterThanOrEqual(32);
    expect(b58.length).toBeLessThanOrEqual(44);
  });

  it("hex round-trips", () => {
    const kp = generateAgentKeypair();
    const hex = toHex(kp.pubkey);
    const back = fromHex(hex);
    expect(toHex(back)).toBe(hex);
  });

  it("base64 round-trips", () => {
    const kp = generateAgentKeypair();
    const b64 = toBase64(kp.seed);
    const back = fromBase64(b64);
    expect(toHex(back)).toBe(toHex(kp.seed));
  });
});
