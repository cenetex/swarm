/**
 * MCP Design Partner Services
 *
 * Adapts the design-partner billing service for the MCP tool interface.
 */
import type { DesignPartnerServices } from '@swarm/mcp-server';
import * as dp from '../billing/design-partner.js';

export function createDesignPartnerServices(): DesignPartnerServices {
  return {
    maxPartners: dp.MAX_DESIGN_PARTNERS,

    createInviteCode: async (params) => {
      const invite = await dp.createInviteCode(params);
      if (!invite) return null;
      return {
        code: invite.code,
        status: invite.status,
        plan: invite.plan,
        createdAt: invite.createdAt,
        createdBy: invite.createdBy,
        note: invite.note,
        expiresAt: invite.expiresAt,
      };
    },

    listInviteCodes: async () => {
      const invites = await dp.listInviteCodes();
      return invites.map(i => ({
        code: i.code,
        status: i.status,
        plan: i.plan,
        createdAt: i.createdAt,
        createdBy: i.createdBy,
        note: i.note,
        expiresAt: i.expiresAt,
        redeemedAt: i.redeemedAt,
        redeemedBy: i.redeemedBy,
      }));
    },

    revokeInviteCode: (code, actorId) => dp.revokeInviteCode(code, actorId),

    listPartners: async () => {
      const partners = await dp.listPartners();
      return partners.map(p => ({
        accountId: p.accountId,
        avatarId: p.avatarId,
        plan: p.plan,
        status: p.status,
        onboardedAt: p.onboardedAt,
      }));
    },

    getMeta: async () => {
      const meta = await dp.getDesignPartnerMeta();
      return {
        activePartnerCount: meta?.activePartnerCount ?? 0,
        totalCodesIssued: meta?.totalCodesIssued ?? 0,
        totalRedeemed: meta?.totalRedeemed ?? 0,
      };
    },
  };
}
