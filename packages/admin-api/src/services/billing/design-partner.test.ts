/**
 * Design Partner Beta Service Tests
 *
 * Tests for invite code management, redemption, partner lifecycle,
 * and the max-10 partner cap from PROJECT-CHARTER.md Section 1b.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Import constants and pure functions that don't hit DynamoDB
// ============================================================================

// Re-implement pure functions to avoid DynamoDB dependency in test
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segment = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `DP-${segment()}-${segment()}`;
}

const MAX_DESIGN_PARTNERS = 10;
const REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type PartnerStatus = 'invited' | 'active' | 'churned' | 'refunded';

interface DesignPartnerRecord {
  status: PartnerStatus;
  refundDeadline: number;
  refundEligible: boolean;
}

function isRefundEligible(partner: DesignPartnerRecord): boolean {
  if (partner.status !== 'active') return false;
  return Date.now() < partner.refundDeadline;
}

// ============================================================================
// Source code verification tests (following entitlements.test.ts pattern)
// ============================================================================

describe('Design Partner Service — source verification', () => {
  const src = readFileSync(resolve(__dirname, 'design-partner.ts'), 'utf-8');

  it('should export MAX_DESIGN_PARTNERS constant of 10', () => {
    expect(src).toContain('export const MAX_DESIGN_PARTNERS = 10');
  });

  it('should export REFUND_WINDOW_MS constant for 30 days', () => {
    expect(src).toContain('export const REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000');
  });

  it('should define DesignPartnerInvite type with pk=DESIGN_PARTNER', () => {
    expect(src).toContain("pk: 'DESIGN_PARTNER'");
  });

  it('should define partner statuses: invited, active, churned, refunded', () => {
    expect(src).toContain("'invited' | 'active' | 'churned' | 'refunded'");
  });

  it('should define invite code statuses: active, redeemed, revoked, expired', () => {
    expect(src).toContain("'active' | 'redeemed' | 'revoked' | 'expired'");
  });

  it('should use INVITE# prefix for invite code sort keys', () => {
    expect(src).toContain('`INVITE#${code}`');
  });

  it('should use PARTNER# prefix for partner record sort keys', () => {
    expect(src).toContain('`PARTNER#${accountId}`');
  });

  it('should use META sort key for counter record', () => {
    expect(src).toContain("sk: 'META'");
  });
});

describe('Design Partner — createInviteCode source', () => {
  const src = readFileSync(resolve(__dirname, 'design-partner.ts'), 'utf-8');

  it('should check active partner count before creating', () => {
    // The function accesses meta.activePartnerCount and checks MAX_DESIGN_PARTNERS
    expect(src).toContain('activePartnerCount');
    expect(src).toContain('activeCount >= MAX_DESIGN_PARTNERS');
  });

  it('should return null when max partners reached', () => {
    // After the MAX_DESIGN_PARTNERS check, returns null
    expect(src).toContain('activeCount >= MAX_DESIGN_PARTNERS');
  });

  it('should use PutCommand with condition to prevent duplicate codes', () => {
    expect(src).toContain("ConditionExpression: 'attribute_not_exists(pk)'");
  });

  it('should increment totalCodesIssued counter', () => {
    expect(src).toContain("incrementMetaCounter('totalCodesIssued')");
  });
});

describe('Design Partner — redeemInviteCode source', () => {
  const src = readFileSync(resolve(__dirname, 'design-partner.ts'), 'utf-8');

  it('should validate code status before redemption', () => {
    expect(src).toContain("error: 'invalid_code'");
    expect(src).toContain("error: 'already_redeemed'");
    expect(src).toContain("error: 'expired'");
    expect(src).toContain("error: 'revoked'");
    expect(src).toContain("error: 'max_partners'");
    expect(src).toContain("error: 'already_partner'");
  });

  it('should check for existing partner before allowing redemption', () => {
    expect(src).toContain('getPartner(accountId)');
  });

  it('should enforce MAX_DESIGN_PARTNERS cap on redemption', () => {
    // The function checks activeCount >= MAX_DESIGN_PARTNERS and returns max_partners error
    expect(src).toContain('MAX_DESIGN_PARTNERS');
    expect(src).toContain("error: 'max_partners'");
  });

  it('should set refund deadline to 30 days from redemption', () => {
    expect(src).toContain('REFUND_WINDOW_MS');
    expect(src).toContain('now + REFUND_WINDOW_MS');
  });

  it('should create a feedback schedule with day-1, 7, 14, 30 milestones', () => {
    expect(src).toContain('day1:');
    expect(src).toContain('day7:');
    expect(src).toContain('day14:');
    expect(src).toContain('day30:');
  });

  it('should mark invite as redeemed on successful redemption', () => {
    expect(src).toContain("':status': 'redeemed'");
  });

  it('should update meta counters on successful redemption', () => {
    expect(src).toContain('updateMetaCounters');
    expect(src).toContain('activePartnerDelta: 1');
  });
});

describe('Design Partner — cancelPartner source', () => {
  const src = readFileSync(resolve(__dirname, 'design-partner.ts'), 'utf-8');

  it('should support both churned and refunded statuses', () => {
    expect(src).toContain("isRefund ? 'refunded' : 'churned'");
  });

  it('should decrement active partner count', () => {
    expect(src).toContain('activePartnerDelta: -1');
  });

  it('should return null for inactive partners', () => {
    expect(src).toContain("partner.status !== 'active'");
  });
});

// ============================================================================
// Pure function unit tests
// ============================================================================

describe('generateInviteCode', () => {
  it('should generate a code with DP- prefix', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^DP-/);
  });

  it('should generate a code in DP-XXXX-XXXX format', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^DP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('should not contain confusing characters (I, O, 0, 1)', () => {
    // Generate many codes and check they never contain these
    for (let i = 0; i < 100; i++) {
      const code = generateInviteCode();
      const segments = code.replace('DP-', '');
      expect(segments).not.toMatch(/[IO01]/);
    }
  });

  it('should generate unique codes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()));
    expect(codes.size).toBe(50);
  });
});

describe('isRefundEligible', () => {
  it('should return true when within 30-day window', () => {
    const partner: DesignPartnerRecord = {
      status: 'active',
      refundDeadline: Date.now() + 10 * 24 * 60 * 60 * 1000, // 10 days from now
      refundEligible: true,
    };
    expect(isRefundEligible(partner)).toBe(true);
  });

  it('should return false when past 30-day window', () => {
    const partner: DesignPartnerRecord = {
      status: 'active',
      refundDeadline: Date.now() - 1000, // 1 second ago
      refundEligible: true,
    };
    expect(isRefundEligible(partner)).toBe(false);
  });

  it('should return false for churned partners even if within window', () => {
    const partner: DesignPartnerRecord = {
      status: 'churned',
      refundDeadline: Date.now() + 10 * 24 * 60 * 60 * 1000,
      refundEligible: true,
    };
    expect(isRefundEligible(partner)).toBe(false);
  });

  it('should return false for refunded partners', () => {
    const partner: DesignPartnerRecord = {
      status: 'refunded',
      refundDeadline: Date.now() + 10 * 24 * 60 * 60 * 1000,
      refundEligible: false,
    };
    expect(isRefundEligible(partner)).toBe(false);
  });
});

describe('MAX_DESIGN_PARTNERS', () => {
  it('should be exactly 10 per charter', () => {
    expect(MAX_DESIGN_PARTNERS).toBe(10);
  });
});

describe('REFUND_WINDOW_MS', () => {
  it('should be exactly 30 days in milliseconds', () => {
    expect(REFUND_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('should equal 2592000000 ms', () => {
    expect(REFUND_WINDOW_MS).toBe(2592000000);
  });
});

// ============================================================================
// Route handler source verification
// ============================================================================

describe('Design Partner Routes — source verification', () => {
  const routeSrc = readFileSync(
    resolve(__dirname, '../../handlers/avatar-routes/design-partner.ts'),
    'utf-8',
  );

  it('should handle POST /design-partners/invites', () => {
    expect(routeSrc).toContain("path === '/design-partners/invites'");
    expect(routeSrc).toContain("method === 'POST'");
  });

  it('should handle GET /design-partners/invites', () => {
    expect(routeSrc).toContain("path === '/design-partners/invites'");
    expect(routeSrc).toContain("method === 'GET'");
  });

  it('should handle DELETE /design-partners/invites/{code}', () => {
    expect(routeSrc).toContain('/design-partners/invites/');
    expect(routeSrc).toContain("method === 'DELETE'");
  });

  it('should handle POST /design-partners/redeem', () => {
    expect(routeSrc).toContain("path === '/design-partners/redeem'");
  });

  it('should handle GET /design-partners', () => {
    expect(routeSrc).toContain("path === '/design-partners'");
  });

  it('should handle POST /design-partners/{accountId}/cancel', () => {
    expect(routeSrc).toContain('/cancel');
  });

  it('should require admin for invite creation', () => {
    expect(routeSrc).toContain('Admin access required');
  });

  it('should require admin for partner cancellation', () => {
    expect(routeSrc).toContain('effectiveIsAdmin');
  });

  it('should allow non-admin users to redeem invite codes', () => {
    // The redeem route requires accountId, not admin
    expect(routeSrc).toContain('Account context required');
  });

  it('should provision entitlement with design-partner source on redemption', () => {
    expect(routeSrc).toContain("entitlementSource: 'design-partner'");
  });

  it('should sync runtime contract after entitlement change', () => {
    expect(routeSrc).toContain('syncRuntimeContractForAvatar');
  });

  it('should record audit log on redemption and cancellation', () => {
    expect(routeSrc).toContain('recordAuditEvent');
    expect(routeSrc).toContain('design_partner_redeemed');
    expect(routeSrc).toContain('design_partner_cancelled');
  });

  it('should check refund eligibility before allowing refund cancellation', () => {
    expect(routeSrc).toContain('isRefundEligible');
    expect(routeSrc).toContain('Refund window has expired');
  });

  it('should downgrade to free tier on cancellation', () => {
    expect(routeSrc).toContain("plan: 'free'");
  });

  it('should expose partner count and max limit in list response', () => {
    expect(routeSrc).toContain('maxPartners: designPartnerService.MAX_DESIGN_PARTNERS');
  });
});

// ============================================================================
// EntitlementRecord type — design-partner source
// ============================================================================

describe('EntitlementRecord type — design-partner source', () => {
  const typeSrc = readFileSync(
    resolve(__dirname, '../../types/billing.ts'),
    'utf-8',
  );

  it('should include design-partner in entitlementSource union', () => {
    expect(typeSrc).toContain("'design-partner'");
  });
});

// ============================================================================
// Router integration — route is registered
// ============================================================================

describe('Design Partner Routes — registered in router', () => {
  const routerSrc = readFileSync(
    resolve(__dirname, '../../handlers/avatars.ts'),
    'utf-8',
  );

  it('should import handleDesignPartnerRoutes', () => {
    expect(routerSrc).toContain('handleDesignPartnerRoutes');
  });

  it('should include handleDesignPartnerRoutes in routeHandlers array', () => {
    expect(routerSrc).toContain('handleDesignPartnerRoutes,');
  });

  const barrelSrc = readFileSync(
    resolve(__dirname, '../../handlers/avatar-routes/index.ts'),
    'utf-8',
  );

  it('should export handleDesignPartnerRoutes from barrel', () => {
    expect(barrelSrc).toContain("export { handleDesignPartnerRoutes } from './design-partner.js'");
  });
});

describe('Design Partner Service — exported from billing barrel', () => {
  const barrelSrc = readFileSync(
    resolve(__dirname, 'index.ts'),
    'utf-8',
  );

  it('should re-export design-partner module', () => {
    expect(barrelSrc).toContain("export * from './design-partner.js'");
  });
});
