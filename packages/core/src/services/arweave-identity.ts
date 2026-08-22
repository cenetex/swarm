/**
 * Arweave Identity Record Publishing — Phase 0.
 *
 * Publishes a content-addressed identity record to Arweave at avatar creation
 * (and on soul-sheet changes / station binding). The record is the cross-chain
 * root of trust: any chain can verify "this pubkey owns this avatar" by
 * checking the Arweave record.
 */
import { createHash } from "node:crypto";

const ARWEAVE_GATEWAY = "https://arweave.net";

export interface ArweaveIdentityRecord {
  protocol: "raticross/identity/1";
  pubkey: string;
  created_at: number;
  soul_sheet_hash: string;
  previous_record_id?: string;
}

export interface ArweavePublishResult {
  /** Arweave transaction ID */
  txId: string;
  /** URL to view the record */
  url: string;
  /** The published record */
  record: ArweaveIdentityRecord;
}

/**
 * Build the identity record for an avatar.
 */
export function buildIdentityRecord(params: {
  pubkey: string;
  createdAt: number;
  soulSheetHash: string;
  previousRecordId?: string;
}): ArweaveIdentityRecord {
  return {
    protocol: "raticross/identity/1",
    pubkey: params.pubkey,
    created_at: params.createdAt,
    soul_sheet_hash: params.soulSheetHash,
    ...(params.previousRecordId ? { previous_record_id: params.previousRecordId } : {}),
  };
}

/**
 * Publish an identity record to Arweave.
 * Requires an Arweave JWK wallet for payment. Falls back to returning the
 * unsigned record if no wallet is provided (for offline/preview mode).
 */
export async function publishIdentityRecord(
  record: ArweaveIdentityRecord,
  arweaveWallet?: object,
): Promise<ArweavePublishResult> {
  const body = JSON.stringify(record);

  if (!arweaveWallet) {
    // Offline mode: return the record without publishing.
    // The caller can publish later with a wallet.
    const hash = createHash("sha256").update(body).digest("hex");
    return {
      txId: "offline-" + hash.slice(0, 16),
      url: "(offline — provide Arweave JWK to publish)",
      record,
    };
  }

  // Submit to Arweave via HTTP API
  const response = await fetch(ARWEAVE_GATEWAY + "/tx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: arweaveWallet,
      data: body,
      tags: [
        { name: "Protocol", value: "raticross/identity/1" },
        { name: "Pubkey", value: record.pubkey },
        { name: "Content-Type", value: "application/json" },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error("Arweave publish failed: " + response.status + " " + (await response.text()).slice(0, 200));
  }

  const result = await response.json() as { id: string };
  return {
    txId: result.id,
    url: ARWEAVE_GATEWAY + "/" + result.id,
    record,
  };
}

/**
 * Fetch an existing identity record from Arweave.
 */
export async function fetchIdentityRecord(txId: string): Promise<ArweaveIdentityRecord | null> {
  try {
    const response = await fetch(ARWEAVE_GATEWAY + "/" + txId);
    if (!response.ok) return null;
    return await response.json() as ArweaveIdentityRecord;
  } catch {
    return null;
  }
}
