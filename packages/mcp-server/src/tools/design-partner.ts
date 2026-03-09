/**
 * Design Partner Admin Tools
 *
 * MCP tools for managing design partner invite codes via the admin chat.
 * Admin-only: create, list, and revoke invite codes.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface DesignPartnerInviteInfo {
  code: string;
  status: 'active' | 'redeemed' | 'revoked' | 'expired';
  plan: 'pro' | 'enterprise';
  createdAt: number;
  createdBy: string;
  note?: string;
  expiresAt?: number;
  redeemedAt?: number;
  redeemedBy?: string;
}

export interface DesignPartnerInfo {
  accountId: string;
  avatarId: string;
  plan: 'pro' | 'enterprise';
  status: 'invited' | 'active' | 'churned' | 'refunded';
  onboardedAt: number;
}

export interface DesignPartnerMeta {
  activePartnerCount: number;
  totalCodesIssued: number;
  totalRedeemed: number;
}

export interface DesignPartnerServices {
  /** Create a new invite code (admin-only) */
  createInviteCode: (params: {
    plan: 'pro' | 'enterprise';
    createdBy: string;
    note?: string;
    expiresAt?: number;
  }) => Promise<DesignPartnerInviteInfo | null>;

  /** List all invite codes */
  listInviteCodes: () => Promise<DesignPartnerInviteInfo[]>;

  /** Revoke an active invite code */
  revokeInviteCode: (code: string, actorId: string) => Promise<boolean>;

  /** List all design partners */
  listPartners: () => Promise<DesignPartnerInfo[]>;

  /** Get meta counters */
  getMeta: () => Promise<DesignPartnerMeta>;

  /** Max allowed partners */
  maxPartners: number;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createDesignPartnerTools = (services: DesignPartnerServices) => [
  defineTool({
    name: 'create_invite_code',
    description:
      'Create a new design partner invite code. Returns a code like DP-XXXX-XXXX that can be shared with a prospective design partner. ' +
      'The code entitles the redeemer to a Pro or Enterprise plan. Maximum 10 active design partners allowed.',
    category: 'config',
    toolset: 'admin',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      plan: z.enum(['pro', 'enterprise']).describe('Which plan the invite grants'),
      note: z.string().optional().describe('Who this code is for (e.g., "Alice from Project X")'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!context.session?.isAdmin) {
        return { success: false, error: 'Admin access required.' };
      }

      const actorId = context.session.email || context.userId || 'unknown';
      const invite = await services.createInviteCode({
        plan: input.plan,
        createdBy: actorId,
        note: input.note,
      });

      if (!invite) {
        return {
          success: false,
          error: `Cannot create invite: maximum design partner limit (${services.maxPartners}) reached.`,
        };
      }

      return {
        success: true,
        data: {
          code: invite.code,
          plan: invite.plan,
          note: invite.note,
          message: `Invite code created: ${invite.code} (${invite.plan} plan).${invite.note ? ` Note: ${invite.note}` : ''} Share this code with the design partner.`,
        },
      };
    },
  }),

  defineTool({
    name: 'list_invite_codes',
    description:
      'List all design partner invite codes and their status (active, redeemed, revoked, expired). ' +
      'Also shows current partner count and capacity.',
    category: 'readonly',
    toolset: 'admin',
    platforms: ['admin-ui'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!context.session?.isAdmin) {
        return { success: false, error: 'Admin access required.' };
      }

      const [invites, partners, meta] = await Promise.all([
        services.listInviteCodes(),
        services.listPartners(),
        services.getMeta(),
      ]);

      const active = invites.filter(i => i.status === 'active');
      const redeemed = invites.filter(i => i.status === 'redeemed');

      return {
        success: true,
        data: {
          invites: invites.map(i => ({
            code: i.code,
            status: i.status,
            plan: i.plan,
            note: i.note,
            createdAt: new Date(i.createdAt).toISOString(),
            ...(i.redeemedAt ? { redeemedAt: new Date(i.redeemedAt).toISOString() } : {}),
          })),
          summary: {
            totalCodes: invites.length,
            active: active.length,
            redeemed: redeemed.length,
            activePartners: meta.activePartnerCount,
            maxPartners: services.maxPartners,
            slotsRemaining: services.maxPartners - meta.activePartnerCount,
          },
          partners: partners.map(p => ({
            accountId: p.accountId,
            plan: p.plan,
            status: p.status,
            onboardedAt: new Date(p.onboardedAt).toISOString(),
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'revoke_invite_code',
    description:
      'Revoke an active invite code so it can no longer be redeemed. ' +
      'Only works on codes with "active" status. Already-redeemed codes cannot be revoked.',
    category: 'config',
    toolset: 'admin',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      code: z.string().trim().min(1).describe('The invite code to revoke (e.g., DP-XXXX-XXXX)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!context.session?.isAdmin) {
        return { success: false, error: 'Admin access required.' };
      }

      const code = input.code.toUpperCase();
      const actorId = context.session.email || context.userId || 'unknown';
      const success = await services.revokeInviteCode(code, actorId);

      if (!success) {
        return {
          success: false,
          error: `Could not revoke ${code}. It may not exist, or it's already redeemed/revoked.`,
        };
      }

      return {
        success: true,
        data: {
          code,
          message: `Invite code ${code} has been revoked.`,
        },
      };
    },
  }),
];
