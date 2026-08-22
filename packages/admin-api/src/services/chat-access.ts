import type { HttpResponse } from "@swarm/core";
import type { UserSession, AvatarRecord } from '../types.js';
import { AvatarOwnershipError } from './avatars.js';

export interface ChatAccessDeps {
  isAdmin: boolean;
  session: UserSession;
  getAvatar: (avatarId: string) => Promise<{ creatorWallet?: string | null } | null>;
  corsHeaders: Record<string, string>;
  /**
   * Avatar ID resolved from a trusted public subdomain host.
   * When present, any authenticated user may access that specific avatar.
   */
  publicAvatarId?: string | null;
  /**
   * Optional enforcement of current NFT ownership (#1385).
   *
   * When provided, the access checker delegates the owner-path decision to
   * this function instead of performing its own `creatorWallet` compare.
   * Implementations should throw `AvatarOwnershipError` (from
   * services/avatars.ts) on denial so the caller can map the `code` to an
   * HTTP status. Resolving to a record = "grant owner access".
   *
   * Kept optional so existing tests that don't care about NFT enforcement
   * — and non-owner paths like publicAvatarId — continue to work.
   */
  assertOwnership?: (
    avatarId: string,
    walletAddress: string,
  ) => Promise<AvatarRecord | null>;
}

export type AccessMode = 'admin' | 'owner' | 'public' | 'denied';

export interface AccessCheckResult {
  error: HttpResponse | null;
  mode: AccessMode;
}

export function createAvatarAccessChecker(deps: ChatAccessDeps) {
  const { isAdmin, session, getAvatar, corsHeaders, publicAvatarId, assertOwnership } = deps;

  return async (avatarId: string | undefined | null): Promise<HttpResponse | null> => {
    if (isAdmin) return null;

    if (!avatarId) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'avatarId is required' }),
      };
    }

    const walletAddress = session.userId;

    // Owner path: when `assertOwnership` is wired (production), delegate the
    // current-ownership check. Otherwise fall back to creatorWallet compare
    // for tests that haven't injected the dep.
    if (assertOwnership && walletAddress) {
      try {
        const owned = await assertOwnership(avatarId, walletAddress);
        if (owned) return null;
      } catch (err) {
        if (err instanceof AvatarOwnershipError && err.code === 'verification_unavailable') {
          return {
            statusCode: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'Ownership verification temporarily unavailable',
              code: err.code,
            }),
          };
        }
        // `not_found`, `not_owner`, `nft_revoked` — fall through so we can
        // still serve the public-avatar path (owner-denial doesn't override
        // a valid public view).
      }

      // Public access only for the avatar resolved from the trusted host context.
      if (publicAvatarId && avatarId === publicAvatarId) {
        return null;
      }

      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      };
    }

    const avatar = await getAvatar(avatarId);
    if (!avatar) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      };
    }

    const isOwner = walletAddress && avatar.creatorWallet === walletAddress;

    // Allow access if user owns the avatar
    if (isOwner) {
      return null;
    }

    // Allow public access only for the avatar resolved from the trusted host context.
    if (publicAvatarId && walletAddress && avatarId === publicAvatarId) {
      return null;
    }

    // Otherwise deny access
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Avatar not found' }),
    };
  };
}

/**
 * Extended access checker that returns both error and access mode
 */
export function createAvatarAccessCheckerWithMode(deps: ChatAccessDeps) {
  const { isAdmin, session, getAvatar, corsHeaders, publicAvatarId, assertOwnership } = deps;

  return async (avatarId: string | undefined | null): Promise<AccessCheckResult> => {
    if (isAdmin) {
      return { error: null, mode: 'admin' };
    }

    if (!avatarId) {
      return {
        error: {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId is required' }),
        },
        mode: 'denied',
      };
    }

    const walletAddress = session.userId;

    if (assertOwnership && walletAddress) {
      try {
        const owned = await assertOwnership(avatarId, walletAddress);
        if (owned) return { error: null, mode: 'owner' };
      } catch (err) {
        if (err instanceof AvatarOwnershipError && err.code === 'verification_unavailable') {
          return {
            error: {
              statusCode: 503,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                error: 'Ownership verification temporarily unavailable',
                code: err.code,
              }),
            },
            mode: 'denied',
          };
        }
        // fall through to public-path handling
      }

      if (publicAvatarId && avatarId === publicAvatarId) {
        return { error: null, mode: 'public' };
      }

      return {
        error: {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        },
        mode: 'denied',
      };
    }

    const avatar = await getAvatar(avatarId);
    if (!avatar) {
      return {
        error: {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        },
        mode: 'denied',
      };
    }

    const isOwner = walletAddress && avatar.creatorWallet === walletAddress;

    // Owner gets owner mode
    if (isOwner) {
      return { error: null, mode: 'owner' };
    }

    // Public access only for the avatar resolved from the trusted host context.
    if (publicAvatarId && walletAddress && avatarId === publicAvatarId) {
      return { error: null, mode: 'public' };
    }

    // Deny access
    return {
      error: {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      },
      mode: 'denied',
    };
  };
}
