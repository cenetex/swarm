/**
 * Agent Identity MCP Services — Body 4 tools.
 *
 * Provides the agent access to its Ed25519 keypair for signing,
 * pubkey inspection, and identity verification.
 */
import type { UserSession } from "../../types.js";
import type { ServiceContainer } from "../service-container.js";
import type { IdentityServices } from "@swarm/mcp-server";
import { toBase58, toHex, fromBase64 } from "@swarm/core";
import nacl from "tweetnacl";

export { type IdentityServices } from "@swarm/mcp-server";

export function createIdentityServices(
  avatarId: string,
  _session: UserSession,
  svc: ServiceContainer,
): IdentityServices {
  return {
    getPubkey: async () => {
      const avatar = await svc.avatars.getAvatar(avatarId);
      if (!avatar?.identity?.pubkey) throw new Error("Agent has no identity keypair");
      return avatar.identity.pubkey;
    },

    getHexPubkey: async () => {
      const avatar = await svc.avatars.getAvatar(avatarId);
      if (!avatar?.identity?.pubkey) throw new Error("Agent has no identity");
      const kp = await loadKeypair(avatarId);
      return toHex(kp.pubkey);
    },

    signMessage: async (message: string) => {
      const avatar = await svc.avatars.getAvatar(avatarId);
      if (!avatar?.identity?.pubkey) throw new Error("Agent has no identity");
      const kp = await loadKeypair(avatarId);
      const sig = nacl.sign.detached(Buffer.from(message, "utf8"), kp.secretKey);
      return {
        signature: toBase58(sig),
        pubkey: avatar.identity.pubkey,
      };
    },

    verifySignature: async (message: string, signatureB58: string, pubkeyB58: string) => {
      const avatar = await svc.avatars.getAvatar(avatarId);
      if (!avatar?.identity?.pubkey) return false;
      if (pubkeyB58 !== avatar.identity.pubkey) return false;
      const kp = await loadKeypair(avatarId);
      const sig = nacl.sign.detached(Buffer.from(message, "utf8"), kp.secretKey);
      return toBase58(sig) === signatureB58;
    },
  };
}

async function loadKeypair(avatarId: string): Promise<{
  pubkey: Uint8Array;
  secretKey: Uint8Array;
}> {
  // Try the secrets service first
  const { getSecretsClient } = await import("../aws-clients.js");
  const { GetSecretValueCommand } = await import("@swarm/core");
  const secretsClient = getSecretsClient();
  
  try {
    const secretName = `avatar/${avatarId}/identity-seed`;
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (response.SecretString) {
      const seed = fromBase64(response.SecretString as string);
      const kp = nacl.sign.keyPair.fromSeed(seed);
      return { pubkey: kp.publicKey, secretKey: kp.secretKey };
    }
  } catch {
    // Fall back to avatar record (legacy base64 path)
  }
  
  // Legacy path: seed stored directly in avatar record
  const { getAvatar } = await import("../avatars.js");
  const avatar = await getAvatar(avatarId);
  if (!avatar?.identity?.encryptedSeed) {
    throw new Error("Agent has no identity keypair");
  }
  const seed = fromBase64(avatar.identity.encryptedSeed);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { pubkey: kp.publicKey, secretKey: kp.secretKey };
}
