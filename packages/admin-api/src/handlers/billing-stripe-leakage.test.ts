/**
 * Regression tests for Stripe customer leakage after avatar reassignment (issue #416)
 *
 * Verifies:
 * 1. Billing checkout/portal use account-scoped entitlement lookups (not avatar-only)
 * 2. reassignAvatar clears Stripe data from existing entitlements
 * 3. Existing owner billing paths continue to work
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Source-code inspection tests (no DynamoDB mocking needed)
// These verify the code structure to ensure the fix is correctly applied.
// ============================================================================

describe('billing handler - account-scoped entitlement lookups (issue #416)', () => {
  const billingSource = readFileSync(resolve(__dirname, 'billing.ts'), 'utf-8');

  describe('handleCheckout', () => {
    // Extract the handleCheckout function body
    const fnMatch = billingSource.match(/async function handleCheckout[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should exist', () => {
      expect(fnMatch).not.toBeNull();
    });

    it('should use getEntitlementByAccount (account-scoped) instead of getEntitlement (avatar-only)', () => {
      // The fix: use account-scoped lookup
      expect(fnBody).toContain('getEntitlementByAccount');
      // Should NOT use the unscoped getEntitlement for billing lookups
      expect(fnBody).not.toMatch(/(?<!\/\/.*)\bgetEntitlement\(/);
    });

    it('should pass accountId from wallet session to the lookup', () => {
      expect(fnBody).toContain('walletSession.accountId');
    });

    it('should check for missing accountId', () => {
      expect(fnBody).toContain("'Session missing account context'");
    });
  });

  describe('handlePortal', () => {
    // Extract the handlePortal function body
    const fnMatch = billingSource.match(/async function handlePortal[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should exist', () => {
      expect(fnMatch).not.toBeNull();
    });

    it('should use getEntitlementByAccount (account-scoped) instead of getEntitlement (avatar-only)', () => {
      expect(fnBody).toContain('getEntitlementByAccount');
      // Should NOT use the unscoped getEntitlement for billing lookups
      expect(fnBody).not.toMatch(/(?<!\/\/.*)\bgetEntitlement\(/);
    });

    it('should pass accountId from wallet session to the lookup', () => {
      expect(fnBody).toContain('walletSession.accountId');
    });

    it('should check for missing accountId before billing lookup', () => {
      expect(fnBody).toContain("'Session missing account context'");
    });
  });

  describe('imports', () => {
    it('should NOT import the unscoped getEntitlement function', () => {
      // The billing handler should only import account-scoped functions
      // (and subscription-based lookups for webhooks).
      // getEntitlement (avatar-only) should not be imported.
      const importBlock = billingSource.match(/import \{[\s\S]*?\} from ['"]\.\.\/services\/billing\/entitlements\.js['"]/);
      expect(importBlock).not.toBeNull();
      const importText = importBlock![0];
      expect(importText).not.toContain('getEntitlement,');
      expect(importText).toContain('getEntitlementByAccount');
    });
  });
});

describe('reassignAvatar - Stripe data clearing (issue #416)', () => {
  const avatarsSource = readFileSync(
    resolve(__dirname, '..', 'services', 'avatars.ts'),
    'utf-8',
  );

  // Extract the reassignAvatar function body
  const fnMatch = avatarsSource.match(/export async function reassignAvatar[\s\S]*?^}/m);
  const fnBody = fnMatch?.[0] ?? '';

  it('should exist', () => {
    expect(fnMatch).not.toBeNull();
  });

  it('should import clearStripeDataForAvatar', () => {
    expect(avatarsSource).toContain("import { clearStripeDataForAvatar }");
  });

  it('should call clearStripeDataForAvatar when creatorWallet changes', () => {
    expect(fnBody).toContain('clearStripeDataForAvatar');
  });

  it('should pass avatarId and actor to clearStripeDataForAvatar', () => {
    expect(fnBody).toContain('clearStripeDataForAvatar(avatarId');
  });

  it('should handle clearStripeDataForAvatar errors gracefully (try/catch)', () => {
    // The function should not fail the entire reassignment if Stripe cleanup fails
    expect(fnBody).toContain('clearStripeDataForAvatar');
    // Verify it is inside a try/catch
    const clearCallIndex = fnBody.indexOf('clearStripeDataForAvatar');
    const precedingCode = fnBody.substring(0, clearCallIndex);
    // There should be a try { before the call (within the wallet-change block)
    const lastTryIndex = precedingCode.lastIndexOf('try {');
    expect(lastTryIndex).toBeGreaterThan(-1);
  });

  it('should only clear Stripe data when creatorWallet actually changes', () => {
    // The clearStripeDataForAvatar call should be inside the
    // "if (newCreatorWallet && newCreatorWallet !== oldCreatorWallet)" block
    const walletChangeBlock = fnBody.match(
      /if \(newCreatorWallet && newCreatorWallet !== oldCreatorWallet\)[\s\S]*?(?=\n {2}\/\/ Build the update)/
    );
    expect(walletChangeBlock).not.toBeNull();
    expect(walletChangeBlock![0]).toContain('clearStripeDataForAvatar');
  });
});

describe('clearStripeDataForAvatar function (issue #416)', () => {
  const entitlementsSource = readFileSync(
    resolve(__dirname, '..', 'services', 'billing', 'entitlements.ts'),
    'utf-8',
  );

  it('should be exported', () => {
    expect(entitlementsSource).toContain('export async function clearStripeDataForAvatar');
  });

  // Extract the clearStripeDataForAvatar function body
  const fnMatch = entitlementsSource.match(
    /export async function clearStripeDataForAvatar[\s\S]*?^\}/m
  );
  const fnBody = fnMatch?.[0] ?? '';

  it('should exist', () => {
    expect(fnMatch).not.toBeNull();
  });

  it('should query GSI1 to find all entitlements for the avatar', () => {
    expect(fnBody).toContain("IndexName: 'GSI1'");
    expect(fnBody).toContain(`AVATAR#\${avatarId}`);
    expect(fnBody).toContain("'ENTITLEMENT#'");
  });

  it('should remove stripeCustomerId and stripeSubscriptionId', () => {
    expect(fnBody).toContain('REMOVE stripeCustomerId, stripeSubscriptionId');
  });

  it('should update audit fields (updatedAt, updatedBy)', () => {
    expect(fnBody).toContain('updatedAt');
    expect(fnBody).toContain('updatedBy');
  });

  it('should accept avatarId and actorId parameters', () => {
    expect(fnBody).toContain('avatarId: string');
    expect(fnBody).toContain('actorId: string');
  });

  it('should return the count of cleared entitlements', () => {
    expect(fnBody).toContain('return clearedCount');
  });

  it('should only update entitlements that have Stripe data', () => {
    // Should check for existence of stripeCustomerId or stripeSubscriptionId
    expect(fnBody).toContain('entitlement.stripeCustomerId || entitlement.stripeSubscriptionId');
  });
});

// ============================================================================
// Webhook handler should still work (not affected by the fix)
// ============================================================================

describe('billing webhook handler - unaffected by fix (issue #416)', () => {
  const billingSource = readFileSync(resolve(__dirname, 'billing.ts'), 'utf-8');

  it('should still use findEntitlementByStripeSubscriptionId for webhook events', () => {
    const webhookFn = billingSource.match(/async function handleWebhook[\s\S]*?^}/m);
    expect(webhookFn).not.toBeNull();
    expect(webhookFn![0]).toContain('findEntitlementByStripeSubscriptionId');
  });

  it('should still use resolveEntitlementContext for webhook metadata resolution', () => {
    const webhookFn = billingSource.match(/async function handleWebhook[\s\S]*?^}/m);
    expect(webhookFn).not.toBeNull();
    expect(webhookFn![0]).toContain('resolveEntitlementContext');
  });
});
