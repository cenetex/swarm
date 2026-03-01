/**
 * Tests for unknown Stripe price ID handling in customer.subscription.updated (issue #417)
 *
 * Verifies:
 * 1. Known price IDs correctly map to plans
 * 2. Unknown price IDs do NOT default to pro
 * 3. A warning is logged for unmapped prices (handler breaks early)
 * 4. Cancelled subscriptions still downgrade to free regardless of price ID
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const billingSource = readFileSync(resolve(__dirname, 'billing.ts'), 'utf-8');

// Extract the customer.subscription.updated case block.
// The block contains multiple `break;` statements (one in the else branch,
// one at the end), so we match up to the closing `    }` at case-indent level.
const subscriptionUpdatedMatch = billingSource.match(
  /case 'customer\.subscription\.updated':\s*\{[\s\S]*?\n {4}\}/
);
const subscriptionUpdatedBody = subscriptionUpdatedMatch?.[0] ?? '';

describe('customer.subscription.updated — unknown price ID handling (issue #417)', () => {
  it('should have the subscription.updated case block', () => {
    expect(subscriptionUpdatedMatch).not.toBeNull();
    expect(subscriptionUpdatedBody.length).toBeGreaterThan(0);
  });

  it('should NOT fall back to pro when inferredPlan is null/falsy', () => {
    // The old code was: `const plan = status === 'cancelled' ? 'free' : (inferredPlan || 'pro');`
    // This should no longer exist.
    expect(subscriptionUpdatedBody).not.toContain("inferredPlan || 'pro'");
    expect(subscriptionUpdatedBody).not.toContain('inferredPlan || "pro"');
  });

  it('should only accept pro or enterprise from inferredPlan', () => {
    // The fix explicitly checks for 'pro' or 'enterprise'
    expect(subscriptionUpdatedBody).toContain("inferredPlan === 'pro'");
    expect(subscriptionUpdatedBody).toContain("inferredPlan === 'enterprise'");
  });

  it('should log a warning when the price ID is unmapped', () => {
    expect(subscriptionUpdatedBody).toContain('console.warn');
    expect(subscriptionUpdatedBody).toContain('Unknown Stripe price ID');
  });

  it('should include the price ID in the warning message', () => {
    // The warning should reference the actual price ID for debugging
    expect(subscriptionUpdatedBody).toContain('priceId');
  });

  it('should include the subscription ID in the warning message', () => {
    expect(subscriptionUpdatedBody).toContain('subscriptionId');
  });

  it('should include the avatar ID in the warning message', () => {
    expect(subscriptionUpdatedBody).toContain('context.avatarId');
  });

  it('should break (skip upsert) when the price ID is unknown', () => {
    // After the console.warn for unknown price, the handler should break
    // before calling upsertStripeEntitlement
    const warnIndex = subscriptionUpdatedBody.indexOf('Unknown Stripe price ID');
    const breakAfterWarn = subscriptionUpdatedBody.indexOf('break;', warnIndex);
    const upsertAfterWarn = subscriptionUpdatedBody.indexOf('upsertStripeEntitlement', warnIndex);

    expect(warnIndex).toBeGreaterThan(-1);
    expect(breakAfterWarn).toBeGreaterThan(-1);

    // The break should come before the upsert call (or the upsert shouldn't
    // appear after the warn at all in the same branch)
    if (upsertAfterWarn > -1) {
      expect(breakAfterWarn).toBeLessThan(upsertAfterWarn);
    }
  });

  it('should still set plan to free when status is cancelled', () => {
    expect(subscriptionUpdatedBody).toContain("plan = 'free'");
    expect(subscriptionUpdatedBody).toContain("status === 'cancelled'");
  });

  it('should still call upsertStripeEntitlement for known price IDs', () => {
    expect(subscriptionUpdatedBody).toContain('upsertStripeEntitlement');
  });
});

describe('checkout.session.completed — does not default unknown prices (issue #417)', () => {
  // The checkout handler already had correct behavior — it requires an explicit
  // plan match and breaks if not found. Verify it stays correct.
  const checkoutMatch = billingSource.match(
    /case 'checkout\.session\.completed':\s*\{([\s\S]*?)break;\s*\}\s*\n/
  );
  const checkoutBody = checkoutMatch?.[0] ?? '';

  it('should have the checkout.session.completed case block', () => {
    expect(checkoutMatch).not.toBeNull();
  });

  it('should NOT use a fallback to pro for unknown price IDs', () => {
    expect(checkoutBody).not.toContain("inferredPlan || 'pro'");
    expect(checkoutBody).not.toContain('inferredPlan || "pro"');
  });

  it('should explicitly check for pro or enterprise before assigning', () => {
    expect(checkoutBody).toContain("=== 'pro'");
    expect(checkoutBody).toContain("=== 'enterprise'");
  });

  it('should break when no valid plan is resolved', () => {
    // `if (!plan) break;` ensures no upsert happens for unknown plans
    expect(checkoutBody).toContain('if (!plan) break');
  });
});

describe('planFromStripeSubscription — returns null for unknown price IDs', () => {
  // Verify the service layer correctly returns null for unknown prices.
  const stripeServiceSource = readFileSync(
    resolve(__dirname, '..', 'services', 'billing', 'stripe-billing.ts'),
    'utf-8',
  );

  const planFromPriceIdFn = stripeServiceSource.match(
    /export function planFromStripePriceId[\s\S]*?^}/m
  );
  const fnBody = planFromPriceIdFn?.[0] ?? '';

  it('should exist', () => {
    expect(planFromPriceIdFn).not.toBeNull();
  });

  it('should return null for unrecognized price IDs', () => {
    expect(fnBody).toContain('return null');
  });

  it('should check env-based price ID mappings', () => {
    expect(fnBody).toContain('priceIds.pro');
    expect(fnBody).toContain('priceIds.enterprise');
  });
});
