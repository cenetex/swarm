/**
 * Agent Identity Tools — Body 4.
 *
 * Tools for the agent to inspect and use its Ed25519 identity keypair.
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

export interface AgentIdentityServices {
  getPubkey: () => Promise<string>;
  getHexPubkey: () => Promise<string>;
  signMessage: (message: string) => Promise<{ signature: string; pubkey: string }>;
  verifySignature: (message: string, signature: string, pubkey: string) => Promise<boolean>;
  getWalletAddresses?: () => Promise<{ solana: string; evm: string }>;
  publishIdentityRecord?: () => Promise<{ txId: string; url: string }>;
  getStationPosition?: () => Promise<{ x: number; y: number }>;
  mineRati?: () => Promise<{ stationCurrency: number; ratiAmount: number; epoch: number }>;
  bridgeRatiToSolana?: (amount?: number, recipient?: string) => Promise<{ attestation: any; solanaTxSig?: string; status: string }>;
}

/** Alias for consumers that import via the shorter name. */
export type IdentityServices = AgentIdentityServices;

export function registerAgentIdentityTools(
  services: AgentIdentityServices,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "get_agent_pubkey",
      description:
        "Get your Ed25519 public key (base58 encoded). This is your canonical identity across platforms.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const pubkey = await services.getPubkey();
        return { success: true, pubkey };
      },
    },
    {
      name: "get_agent_pubkey_hex",
      description:
        "Get your Ed25519 public key in hex format.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const pubkey = await services.getHexPubkey();
        return { success: true, pubkey };
      },
    },
    {
      name: "sign_message",
      description:
        "Sign a message with your Ed25519 identity keypair. Returns the base58-encoded signature and your public key.",
      category: "readonly",
      inputSchema: z.object({
        message: z.string().describe("The message to sign"),
      }),
      execute: async (args: { message: string }) => {
        const result = await services.signMessage(args.message);
        return { success: true, ...result };
      },
    },
  ];

  // Optional: wallet address derivation (Phase 0)
  if (services.getWalletAddresses) {
    tools.push({
      name: "get_wallet_addresses",
      description:
        "Get your derived wallet addresses for Solana and EVM chains. " +
        "These are deterministic — the same keypair always produces the same addresses.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const addrs = await services.getWalletAddresses!();
        return { success: true, ...addrs };
      },
    });
  }

  // Optional: Arweave identity publishing (Phase 0)
  if (services.publishIdentityRecord) {
    tools.push({
      name: "publish_identity",
      description:
        "Publish your identity record to Arweave for permanent, cross-chain verification. " +
        "This creates a content-addressed proof that your public key owns this avatar.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await services.publishIdentityRecord!();
        return { success: true, ...result };
      },
    });
  }

  // Phase 1: Station position
  if (services.getStationPosition) {
    tools.push({
      name: "get_station_position",
      description:
        "Get your Signal station position derived from your identity keypair. " +
        "Each avatar gets a unique, deterministic position in Signal space.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const pos = await services.getStationPosition!();
        return { success: true, ...pos };
      },
    });
  }

  // Phase 1: Mine RATi (simulated from agent activity)
  if (services.mineRati) {
    tools.push({
      name: "mine_rati",
      description:
        "Process RATi-grade fragments mined at your Signal station. " +
        "Signal has RATi-grade ore (0.14% chance, 10x payout) — when processed " +
        "at your station, it produces RATi claims that can be bridged to Solana/Base. " +
        "In dev mode without Signal, uses simulated activity-based mining.",
      category: "readonly",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await services.mineRati!();
        return { success: true, ...result };
      },
    });
  }

  // Phase 1: Bridge RATi to Solana
  if (services.bridgeRatiToSolana) {
    tools.push({
      name: "bridge_rati_to_solana",
      description:
        "Bridge mined RATi to Solana devnet. Signs a bridge attestation with your " +
        "identity keypair and submits it to the bridge contract.",
      category: "readonly",
      inputSchema: z.object({
        amount: z.number().optional().describe("Amount of RATi to bridge (default: all mined RATi)"),
        recipient: z.string().optional().describe("Solana wallet address to receive RATi (default: your derived wallet)"),
      }),
      execute: async (args: { amount?: number; recipient?: string }) => {
        const result = await services.bridgeRatiToSolana!(args.amount, args.recipient);
        return { success: true, ...result };
      },
    });
  }

  return tools;
}
