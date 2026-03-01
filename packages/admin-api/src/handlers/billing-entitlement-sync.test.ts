/**
 * Tests for Stripe webhook → entitlement sync (issue #585)
 *
 * Verifies each Stripe event type correctly maps to entitlement operations:
 * 1. checkout.session.completed → assign Pro/Enterprise based on price ID
 * 2. customer.subscription.created/updated → update tier (upgrade/downgrade)
 * 3. customer.subscription.deleted → downgrade to Free with cancelled status
 * 4. invoice.payment_failed → suspend entitlement
 * 5. invoice.paid → reactivate entitlement
 * 6. Audit logging emitted for all tier changes
 * 7. syncRuntimeLimitsToState called for immediate effect
 * 8. Idempotent handling (upsert pattern)
 *
 * Uses source-code inspection (like other billing tests) to verify wiring
 * without needing full DynamoDB/Stripe mocking.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const billingSource = readFileSync(resolve(__dirname, 'billing.ts'), 'utf-8');

// ============================================================================
// Helper: extract case blocks and function bodies
// ============================================================================

function extractCaseBlock(eventType: string): string {
  const escaped = eventType.replace(/\./g, '\\.');
  const match = billingSource.match(
    new RegExp(`case '${escaped}':\\s*\\{[\\s\\S]*?\\n {4}\\}`)
  );
  return match?.[0] ?? '';
}

/**
 * Extract a top-level function body by counting braces.
 * Finds the function declaration, skips to the function body opening brace
 * (not type parameter braces), then counts `{` / `}` to find the matching
 * closing brace.
 *
 * The function body brace is identified by looking for `): ... {` pattern
 * (i.e., the `{` that follows the closing `)` of the parameter list).
 */
function extractFunction(name: string): string {
  const startPattern = new RegExp(`(?:async )?function ${name}\\b`);
  const startMatch = startPattern.exec(billingSource);
  if (!startMatch) return '';

  const startIndex = startMatch.index;

  // Find the function body opening brace by tracking parenthesis depth.
  // We need the `{` that comes after the closing `)` of the parameter list.
  let parenDepth = 0;
  let foundParens = false;
  let bodyBraceIndex = -1;

  for (let i = startIndex + startMatch[0].length; i < billingSource.length; i++) {
    if (billingSource[i] === '(') {
      parenDepth++;
      foundParens = true;
    } else if (billingSource[i] === ')') {
      parenDepth--;
      if (foundParens && parenDepth === 0) {
        // After closing paren, find the next `{` (the function body)
        const nextBrace = billingSource.indexOf('{', i + 1);
        if (nextBrace === -1) return '';
        bodyBraceIndex = nextBrace;
        break;
      }
    }
  }

  if (bodyBraceIndex === -1) return '';

  // The brace we found might be inside a type annotation (e.g. Promise<{ ... }>).
  // If so, skip it. We need the `{` that is NOT inside angle brackets.
  // Walk forward from bodyBraceIndex, tracking angle bracket depth.
  let angleDepth = 0;
  let trueBraceIndex = -1;
  for (let i = startIndex + startMatch[0].length; i < billingSource.length; i++) {
    if (billingSource[i] === '<') angleDepth++;
    else if (billingSource[i] === '>') angleDepth--;
    else if (billingSource[i] === '{' && angleDepth === 0 && i >= bodyBraceIndex) {
      trueBraceIndex = i;
      break;
    }
  }

  if (trueBraceIndex === -1) return '';

  // Now count braces from the function body opening brace
  let depth = 0;
  for (let i = trueBraceIndex; i < billingSource.length; i++) {
    if (billingSource[i] === '{') depth++;
    if (billingSource[i] === '}') depth--;
    if (depth === 0) {
      return billingSource.substring(startIndex, i + 1);
    }
  }
  return '';
}

// ============================================================================
// upsertStripeEntitlement — core sync function
// ============================================================================

describe('upsertStripeEntitlement — entitlement sync core (issue #585)', () => {
  const fnBody = extractFunction('upsertStripeEntitlement');

  it('should exist', () => {
    expect(fnBody.length).toBeGreaterThan(0);
  });

  it('should read existing entitlement before upserting', () => {
    expect(fnBody).toContain('getEntitlementByAccount(params.accountId, params.avatarId)');
  });

  it('should capture previousPlan and previousStatus for audit', () => {
    expect(fnBody).toContain("existing?.plan ?? 'free'");
    expect(fnBody).toContain("existing?.status ?? 'active'");
  });

  it('should preserve existing overrides during upsert', () => {
    expect(fnBody).toContain('overrides: existing?.overrides');
  });

  it('should preserve existing Stripe IDs when not provided', () => {
    expect(fnBody).toContain('stripeSubscriptionId: params.stripeSubscriptionId ?? existing?.stripeSubscriptionId');
    expect(fnBody).toContain('stripeCustomerId: params.stripeCustomerId ?? existing?.stripeCustomerId');
  });

  it('should set entitlementSource to stripe', () => {
    expect(fnBody).toContain("entitlementSource: 'stripe'");
  });

  it('should set actorId to stripe-webhook', () => {
    expect(fnBody).toContain("actorId: 'stripe-webhook'");
  });

  it('should call syncRuntimeContractForAvatar after upserting', () => {
    const setIndex = fnBody.indexOf('setEntitlement(');
    const syncIndex = fnBody.indexOf('syncRuntimeContractForAvatar(');
    expect(setIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(setIndex);
  });

  it('should record an audit event after sync', () => {
    expect(fnBody).toContain('recordAuditEvent');
  });

  it('should include previousPlan and newPlan in audit details', () => {
    expect(fnBody).toContain('previousPlan');
    expect(fnBody).toContain('newPlan: params.plan');
  });

  it('should include previousStatus and newStatus in audit details', () => {
    expect(fnBody).toContain('previousStatus');
    expect(fnBody).toContain('newStatus: params.status');
  });

  it('should include source: stripe in audit details', () => {
    expect(fnBody).toContain("source: 'stripe'");
  });

  it('should wrap audit logging in try/catch to not fail the sync', () => {
    const auditIndex = fnBody.indexOf('recordAuditEvent');
    const precedingCode = fnBody.substring(0, auditIndex);
    expect(precedingCode).toContain('try {');
  });

  it('should accept plan, status, stripeSubscriptionId, stripeCustomerId, trialEndsAt', () => {
    expect(fnBody).toContain("plan: 'free' | 'pro' | 'enterprise'");
    expect(fnBody).toContain("status: 'active' | 'suspended' | 'cancelled' | 'trial'");
    expect(fnBody).toContain('stripeSubscriptionId?: string');
    expect(fnBody).toContain('stripeCustomerId?: string');
    expect(fnBody).toContain('trialEndsAt?: number');
  });
});

// ============================================================================
// checkout.session.completed → assign entitlement
// ============================================================================

describe('checkout.session.completed — entitlement assignment (issue #585)', () => {
  const caseBody = extractCaseBlock('checkout.session.completed');

  it('should have the case block', () => {
    expect(caseBody.length).toBeGreaterThan(0);
  });

  it('should extract subscription ID from the session object', () => {
    expect(caseBody).toContain('extractStripeObjectId(session.subscription)');
  });

  it('should extract customer ID from the session object', () => {
    expect(caseBody).toContain('extractStripeObjectId(session.customer)');
  });

  it('should resolve entitlement context from metadata or subscription', () => {
    expect(caseBody).toContain('resolveEntitlementContext');
  });

  it('should retrieve the Stripe subscription to infer plan', () => {
    expect(caseBody).toContain('retrieveStripeSubscription(subscriptionId)');
  });

  it('should use planFromStripeSubscription to map price to plan', () => {
    expect(caseBody).toContain('planFromStripeSubscription(subscription)');
  });

  it('should fall back to session metadata plan if subscription plan is unknown', () => {
    expect(caseBody).toContain('session.metadata?.plan');
  });

  it('should only accept pro or enterprise plans', () => {
    expect(caseBody).toContain("=== 'pro'");
    expect(caseBody).toContain("=== 'enterprise'");
  });

  it('should break if no valid plan is resolved', () => {
    expect(caseBody).toContain('if (!plan) break');
  });

  it('should call upsertStripeEntitlement with active status', () => {
    expect(caseBody).toContain('upsertStripeEntitlement');
    expect(caseBody).toContain("status: 'active'");
  });

  it('should pass customerId and subscriptionId to upsert', () => {
    expect(caseBody).toContain('stripeCustomerId: customerId');
    expect(caseBody).toContain('stripeSubscriptionId: subscriptionId');
  });

  it('should handle trial_end from the subscription', () => {
    expect(caseBody).toContain('subscription.trial_end');
    expect(caseBody).toContain('trialEndsAt');
  });
});

// ============================================================================
// customer.subscription.created / updated → update entitlement
// ============================================================================

describe('customer.subscription.created/updated — entitlement update (issue #585)', () => {
  // This case handles both created and updated events
  const caseBody = extractCaseBlock('customer.subscription.updated');

  it('should handle both created and updated events in the same case', () => {
    expect(billingSource).toContain("case 'customer.subscription.created':");
    expect(billingSource).toContain("case 'customer.subscription.updated':");
    // They should be fall-through (no break between them)
    const createdIndex = billingSource.indexOf("case 'customer.subscription.created':");
    const updatedIndex = billingSource.indexOf("case 'customer.subscription.updated':");
    const betweenCases = billingSource.substring(createdIndex, updatedIndex);
    // Should NOT have a break; between the two cases
    expect(betweenCases).not.toContain('break;');
  });

  it('should resolve entitlement context', () => {
    expect(caseBody).toContain('resolveEntitlementContext');
  });

  it('should infer plan from subscription price ID', () => {
    expect(caseBody).toContain('planFromStripeSubscription(subscription)');
  });

  it('should map Stripe subscription status to entitlement status', () => {
    expect(caseBody).toContain('mapStripeSubscriptionStatus(subscription.status)');
  });

  it('should downgrade to free when subscription is cancelled', () => {
    expect(caseBody).toContain("status === 'cancelled'");
    expect(caseBody).toContain("plan = 'free'");
  });

  it('should skip plan update for unknown price IDs (preserve current entitlement)', () => {
    expect(caseBody).toContain('Unknown Stripe price ID');
    // After warning, should break before upsert
    const warnIndex = caseBody.indexOf('Unknown Stripe price ID');
    const breakAfterWarn = caseBody.indexOf('break;', warnIndex);
    expect(breakAfterWarn).toBeGreaterThan(warnIndex);
  });

  it('should pass subscription ID to upsert', () => {
    expect(caseBody).toContain('stripeSubscriptionId: subscriptionId');
  });

  it('should extract customer ID from subscription object', () => {
    expect(caseBody).toContain('extractStripeObjectId(subscription.customer)');
  });

  it('should handle trial_end timestamp conversion', () => {
    expect(caseBody).toContain('subscription.trial_end');
    expect(caseBody).toContain('* 1000');
  });

  it('should call upsertStripeEntitlement with inferred plan and status', () => {
    expect(caseBody).toContain('upsertStripeEntitlement');
  });
});

// ============================================================================
// customer.subscription.deleted → downgrade to Free
// ============================================================================

describe('customer.subscription.deleted — downgrade to Free (issue #585)', () => {
  const caseBody = extractCaseBlock('customer.subscription.deleted');

  it('should have the case block', () => {
    expect(caseBody.length).toBeGreaterThan(0);
  });

  it('should resolve entitlement context', () => {
    expect(caseBody).toContain('resolveEntitlementContext');
  });

  it('should call upsertStripeEntitlement with plan: free', () => {
    expect(caseBody).toContain("plan: 'free'");
  });

  it('should set status to cancelled', () => {
    expect(caseBody).toContain("status: 'cancelled'");
  });

  it('should pass customerId and subscriptionId', () => {
    expect(caseBody).toContain('stripeCustomerId: customerId');
    expect(caseBody).toContain('stripeSubscriptionId: subscriptionId');
  });
});

// ============================================================================
// invoice.payment_failed → suspend entitlement
// ============================================================================

describe('invoice.payment_failed — suspend entitlement (issue #585)', () => {
  const caseBody = extractCaseBlock('invoice.payment_failed');

  it('should have the case block', () => {
    expect(caseBody.length).toBeGreaterThan(0);
  });

  it('should extract subscription ID from invoice', () => {
    expect(caseBody).toContain('extractStripeObjectId(invoice.subscription)');
  });

  it('should break if no subscription ID', () => {
    expect(caseBody).toContain('if (!subscriptionId) break');
  });

  it('should look up entitlement by subscription ID', () => {
    expect(caseBody).toContain('findEntitlementByStripeSubscriptionId(subscriptionId)');
  });

  it('should break if no entitlement found', () => {
    expect(caseBody).toContain('if (!entitlement) break');
  });

  it('should call suspendEntitlement with Payment failed reason', () => {
    expect(caseBody).toContain('suspendEntitlement(');
    expect(caseBody).toContain("'Payment failed'");
  });

  it('should call syncRuntimeContractForAvatar after suspension', () => {
    const suspendIndex = caseBody.indexOf('suspendEntitlement(');
    const syncIndex = caseBody.indexOf('syncRuntimeContractForAvatar(');
    expect(syncIndex).toBeGreaterThan(suspendIndex);
  });

  it('should record an audit event for payment failure', () => {
    expect(caseBody).toContain('recordAuditEvent');
    expect(caseBody).toContain("reason: 'invoice.payment_failed'");
    expect(caseBody).toContain("newStatus: 'suspended'");
  });

  it('should wrap audit logging in try/catch', () => {
    const auditIndex = caseBody.indexOf('recordAuditEvent');
    const precedingCode = caseBody.substring(0, auditIndex);
    expect(precedingCode).toContain('try {');
  });
});

// ============================================================================
// invoice.paid → reactivate entitlement
// ============================================================================

describe('invoice.paid — reactivate entitlement (issue #585)', () => {
  const caseBody = extractCaseBlock('invoice.paid');

  it('should have the case block', () => {
    expect(caseBody.length).toBeGreaterThan(0);
  });

  it('should extract subscription ID from invoice', () => {
    expect(caseBody).toContain('extractStripeObjectId(invoice.subscription)');
  });

  it('should break if no subscription ID', () => {
    expect(caseBody).toContain('if (!subscriptionId) break');
  });

  it('should look up entitlement by subscription ID', () => {
    expect(caseBody).toContain('findEntitlementByStripeSubscriptionId(subscriptionId)');
  });

  it('should call setEntitlementStatus to active', () => {
    expect(caseBody).toContain('setEntitlementStatus(');
    expect(caseBody).toContain("'active'");
  });

  it('should call syncRuntimeContractForAvatar after reactivation', () => {
    const statusIndex = caseBody.indexOf('setEntitlementStatus(');
    const syncIndex = caseBody.indexOf('syncRuntimeContractForAvatar(');
    expect(syncIndex).toBeGreaterThan(statusIndex);
  });

  it('should record an audit event for invoice payment', () => {
    expect(caseBody).toContain('recordAuditEvent');
    expect(caseBody).toContain("reason: 'invoice.paid'");
    expect(caseBody).toContain("newStatus: 'active'");
  });

  it('should wrap audit logging in try/catch', () => {
    const auditIndex = caseBody.indexOf('recordAuditEvent');
    const precedingCode = caseBody.substring(0, auditIndex);
    expect(precedingCode).toContain('try {');
  });
});

// ============================================================================
// Idempotent handling — upsert pattern
// ============================================================================

describe('webhook idempotency — upsert pattern (issue #585)', () => {
  const upsertBody = extractFunction('upsertStripeEntitlement');

  it('should use setEntitlement (PutCommand) which is idempotent', () => {
    expect(upsertBody).toContain('setEntitlement(');
  });

  it('should not use conditional writes that would fail on duplicate delivery', () => {
    // The function should use setEntitlement (unconditional put), not
    // conditional writes that would reject duplicate webhook deliveries
    expect(upsertBody).not.toContain('ConditionExpression');
  });

  it('should always return 200 to Stripe (even for unknown event types)', () => {
    const webhookBody = extractFunction('handleWebhook');
    // The function should return 200 at the end regardless of event type
    expect(webhookBody).toContain("return jsonResponse(200, { received: true }, corsHeaders)");
  });
});

// ============================================================================
// resolveEntitlementContext — multi-strategy resolution
// ============================================================================

describe('resolveEntitlementContext — context resolution (issue #585)', () => {
  const fnBody = extractFunction('resolveEntitlementContext');

  it('should exist', () => {
    expect(fnBody.length).toBeGreaterThan(0);
  });

  it('should first try metadata accountId and avatarId', () => {
    expect(fnBody).toContain('params.metadata?.accountId');
    expect(fnBody).toContain('params.metadata?.avatarId');
  });

  it('should fall back to subscription ID lookup via entitlement table', () => {
    expect(fnBody).toContain('findEntitlementByStripeSubscriptionId');
  });

  it('should fall back to retrieving subscription from Stripe for metadata', () => {
    expect(fnBody).toContain('retrieveStripeSubscription(params.subscriptionId)');
  });

  it('should return null if all resolution strategies fail', () => {
    expect(fnBody).toContain('return null');
  });

  it('should handle Stripe API errors gracefully', () => {
    expect(fnBody).toContain('catch (error)');
    expect(fnBody).toContain('Failed to resolve subscription metadata');
  });
});

// ============================================================================
// Stripe status mapping
// ============================================================================

describe('mapStripeSubscriptionStatus coverage (issue #585)', () => {
  const stripeServiceSource = readFileSync(
    resolve(__dirname, '..', 'services', 'billing', 'stripe-billing.ts'),
    'utf-8',
  );

  const fnMatch = stripeServiceSource.match(
    /export function mapStripeSubscriptionStatus[\s\S]*?^}/m
  );
  const fnBody = fnMatch?.[0] ?? '';

  it('should exist', () => {
    expect(fnMatch).not.toBeNull();
  });

  it('should map active to active', () => {
    expect(fnBody).toContain("case 'active':");
    expect(fnBody).toContain("return 'active'");
  });

  it('should map trialing to trial', () => {
    expect(fnBody).toContain("case 'trialing':");
    expect(fnBody).toContain("return 'trial'");
  });

  it('should map canceled to cancelled', () => {
    expect(fnBody).toContain("case 'canceled':");
    expect(fnBody).toContain("return 'cancelled'");
  });

  it('should map past_due to suspended', () => {
    expect(fnBody).toContain("case 'past_due':");
    expect(fnBody).toContain("return 'suspended'");
  });

  it('should map unpaid to suspended', () => {
    expect(fnBody).toContain("case 'unpaid':");
  });

  it('should map incomplete to suspended', () => {
    expect(fnBody).toContain("case 'incomplete':");
  });

  it('should default unknown statuses to suspended', () => {
    // The default case should return suspended
    expect(fnBody).toMatch(/default:\s*\n\s*return 'suspended'/);
  });
});

// ============================================================================
// Audit logging — import and wiring
// ============================================================================

describe('billing handler — audit logging wiring (issue #585)', () => {
  it('should import recordAuditEvent from audit-log service', () => {
    expect(billingSource).toContain("import { recordAuditEvent } from '../services/audit-log.js'");
  });

  it('should emit audit events with actorId stripe-webhook', () => {
    // All audit calls in the webhook handler should use stripe-webhook as actor
    const auditCalls = billingSource.match(/recordAuditEvent\(\{[\s\S]*?\}\)/g) ?? [];
    expect(auditCalls.length).toBeGreaterThan(0);
    for (const call of auditCalls) {
      expect(call).toContain("actorId: 'stripe-webhook'");
    }
  });

  it('should emit audit events with eventType entitlement_changed', () => {
    const auditCalls = billingSource.match(/recordAuditEvent\(\{[\s\S]*?\}\)/g) ?? [];
    for (const call of auditCalls) {
      expect(call).toContain("eventType: 'entitlement_changed'");
    }
  });

  it('should emit audit events with actorType admin', () => {
    const auditCalls = billingSource.match(/recordAuditEvent\(\{[\s\S]*?\}\)/g) ?? [];
    for (const call of auditCalls) {
      expect(call).toContain("actorType: 'admin'");
    }
  });
});

// ============================================================================
// Web3 augmentation — not broken by Stripe sync
// ============================================================================

describe('Web3 augmentation preserved (issue #585)', () => {
  it('should call syncRuntimeContractForAvatar which applies Web3 augmentations', () => {
    // The runtime sync module handles Web3 augmentations on top of entitlement tier
    const webhookBody = extractFunction('handleWebhook');
    expect(webhookBody).toContain('syncRuntimeContractForAvatar');
  });

  it('should import syncRuntimeContractForAvatar', () => {
    expect(billingSource).toContain(
      "import { syncRuntimeContractForAvatar } from './avatar-routes/runtime-sync.js'"
    );
  });

  // Verify the runtime-sync module builds augmentations on top
  it('should build runtime augmentations in the sync module', () => {
    const runtimeSyncSource = readFileSync(
      resolve(__dirname, 'avatar-routes', 'runtime-sync.ts'),
      'utf-8',
    );
    expect(runtimeSyncSource).toContain('buildRuntimeAugmentations');
    expect(runtimeSyncSource).toContain('syncRuntimeLimitsToState');
    // Verify augmentations are passed to syncRuntimeLimitsToState
    expect(runtimeSyncSource).toContain('augmentations');
  });
});
