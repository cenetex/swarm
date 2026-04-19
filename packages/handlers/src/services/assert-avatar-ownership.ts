/**
 * Avatar ownership gate (handlers)
 *
 * The admin-api side of #1385 (PR 1 / #1397) gates requests by comparing the
 * authenticated caller's wallet against the current on-chain holder of the
 * avatar's backing NFT. Webhook handlers don't have a caller wallet to
 * compare against — a Telegram message's "caller" is a Telegram user id, not
 * a Solana wallet — so we instead check the WEAKER invariant:
 *
 *   For an NFT-backed avatar, the wallet that claimed it (`creatorWallet`)
 *   must STILL be the current on-chain holder.
 *
 * When the claimer has transferred the NFT, the avatar is effectively
 * orphaned: there is no way for the webhook layer to know whether the new
 * holder wants the avatar to keep running on Telegram/Discord under the old
 * claimer's bot credentials. Fail-closed: we block the message until the
 * new holder claims the avatar (which invalidates the cache and refreshes
 * `creatorWallet` on the admin-api side).
 *
 * Non-NFT avatars are never gated here — they predate NFT claim and their
 * `creatorWallet` is a fixed identity, not a transferable token.
 *
 * See #1385 PR 3 and the audit at `docs/security/nft-ownership-audit-2026-04-17.md`.
 */
import { getCachedNFTOwner } from './nft-ownership-cache.js';

export type HandlerOwnershipErrorCode =
  | 'nft_revoked'
  | 'verification_unavailable';

export class HandlerOwnershipError extends Error {
  readonly code: HandlerOwnershipErrorCode;

  constructor(params: { code: HandlerOwnershipErrorCode; message?: string }) {
    super(params.message ?? params.code);
    this.name = 'HandlerOwnershipError';
    this.code = params.code;
  }
}

/** Subset of the avatar record the gate needs. */
export interface AvatarOwnershipSubject {
  avatarId: string;
  nftMint?: string | null;
  creatorWallet?: string | null;
}

/**
 * Verify that an NFT-backed avatar is still owned by the wallet that claimed
 * it. Throws `HandlerOwnershipError` on any deny path. Non-NFT avatars pass
 * through untouched.
 *
 * The function may also be pointed at a mock cache in tests via the optional
 * `deps.getCachedNFTOwner` override.
 */
export async function assertAvatarStillOwnedByClaimer(
  avatar: AvatarOwnershipSubject,
  deps: {
    getCachedNFTOwner?: (mint: string) => Promise<string | null>;
  } = {},
): Promise<void> {
  if (!avatar.nftMint) return;
  if (!avatar.creatorWallet) return;

  const resolve = deps.getCachedNFTOwner ?? getCachedNFTOwner;
  let currentOwner: string | null;
  try {
    currentOwner = await resolve(avatar.nftMint);
  } catch {
    throw new HandlerOwnershipError({ code: 'verification_unavailable' });
  }

  if (currentOwner !== avatar.creatorWallet) {
    throw new HandlerOwnershipError({ code: 'nft_revoked' });
  }
}
