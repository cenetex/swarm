/**
 * Shared utilities for avatar route handlers.
 *
 * Pure functions with NO service-module imports so domain-handler test files
 * never need to mock anything on behalf of this module.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';

// ── Admin wallets ──────────────────────────────────────────────────────────
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').split(',').filter(Boolean);

export function isAdminWallet(walletAddress: string): boolean {
  return ADMIN_WALLETS.includes(walletAddress);
}

// ── Response helpers ───────────────────────────────────────────────────────

export function jsonResponse(
  corsHeaders: Record<string, string>,
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ── Time parsing ───────────────────────────────────────────────────────────

/**
 * Parse a relative time string like "30m", "1h", "24h" to a timestamp.
 */
export function parseSinceParam(since: string): number | undefined {
  const match = since.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  if (!value) return undefined;
  const unit = match[2].toLowerCase();
  const ms =
    unit === 'm' ? value * 60 * 1000
    : unit === 'h' ? value * 60 * 60 * 1000
    : unit === 'd' ? value * 24 * 60 * 60 * 1000
    : 0;
  return Date.now() - ms;
}

export function parseSinceQueryParam(value?: string): number | undefined {
  if (!value) return undefined;
  const relative = parseSinceParam(value);
  if (relative !== undefined) return relative;
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) ? numeric : undefined;
}

// ── Auth guard ─────────────────────────────────────────────────────────────

type GetAvatarFn = (id: string) => Promise<{
  creatorWallet?: string | null;
} | null>;

function getOwnershipErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Return an error response if the caller is neither admin nor owner.
 * Returns `null` when access is granted.
 *
 * `getAvatar` is injected by the caller so this module has no service imports.
 */
export async function requireOwnerOrAdmin(
  ctx: RouteContext,
  avatarId: string,
  getAvatar: GetAvatarFn,
): Promise<APIGatewayProxyResultV2 | null> {
  if (ctx.effectiveIsAdmin) return null;
  if (!ctx.walletAddress) {
    return jsonResponse(ctx.corsHeaders, 403, { error: 'Authentication required' });
  }

  if (ctx.assertAvatarOwnership) {
    try {
      await ctx.assertAvatarOwnership(avatarId, ctx.walletAddress, { isAdmin: false });
      return null;
    } catch (error) {
      const code = getOwnershipErrorCode(error);
      if (code === 'verification_unavailable') {
        return jsonResponse(ctx.corsHeaders, 503, {
          error: 'Ownership verification temporarily unavailable',
          code,
        });
      }
      return jsonResponse(ctx.corsHeaders, 404, { error: 'Avatar not found' });
    }
  }

  const existing = await getAvatar(avatarId);
  if (
    !existing ||
    existing.creatorWallet !== ctx.walletAddress
  ) {
    return jsonResponse(ctx.corsHeaders, 404, { error: 'Avatar not found' });
  }
  return null;
}
