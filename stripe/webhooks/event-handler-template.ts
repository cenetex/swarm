/**
 * Stripe Webhook Event Handler — Reference Template
 *
 * Copy to packages/handlers/src/stripe-webhook.ts when implementing M2-011.
 * Shows the pattern for mapping Stripe subscription events to entitlement CRUD.
 *
 * Integration points:
 *   - setEntitlement()         from packages/admin-api/src/services/entitlements.ts
 *   - updateEntitlementPlan()  from packages/admin-api/src/services/entitlements.ts
 *   - suspendEntitlement()     from packages/admin-api/src/services/entitlements.ts
 *   - syncRuntimeLimitsToState() from packages/admin-api/src/services/runtime-limits.ts
 *   - PlanType, EntitlementRecord from packages/admin-api/src/types.ts
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
// import Stripe from 'stripe';
// import { setEntitlement, updateEntitlementPlan, suspendEntitlement } from '../services/entitlements';
// import { syncRuntimeLimitsToState } from '../services/runtime-limits';
// import type { PlanType } from '../types';

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
// const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Lambda handler for POST /api/stripe/webhook
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // --- 1. Verify signature ---
  // const sig = event.headers['stripe-signature'];
  // if (!sig || !event.body) return { statusCode: 400, body: 'Missing signature' };
  //
  // let stripeEvent: Stripe.Event;
  // try {
  //   stripeEvent = stripe.webhooks.constructEvent(event.body, sig, WEBHOOK_SECRET);
  // } catch (err) {
  //   console.error('Webhook signature verification failed', err);
  //   return { statusCode: 400, body: 'Invalid signature' };
  // }

  // --- 2. Route by event type ---
  // switch (stripeEvent.type) {
  //
  //   case 'checkout.session.completed': {
  //     const session = stripeEvent.data.object as Stripe.Checkout.Session;
  //     const { avatarId, accountId } = session.metadata ?? {};
  //     if (!avatarId || !accountId) break;
  //
  //     // Resolve plan from the subscription's product
  //     const subscription = await stripe.subscriptions.retrieve(session.subscription as string, {
  //       expand: ['items.data.price.product'],
  //     });
  //     const product = subscription.items.data[0]?.price.product as Stripe.Product;
  //     const plan = stripePlanType(product.metadata);
  //
  //     await setEntitlement({
  //       accountId,
  //       avatarId,
  //       plan,
  //       stripeCustomerId: session.customer as string,
  //       stripeSubscriptionId: session.subscription as string,
  //       status: 'active',
  //       entitlementSource: 'stripe',
  //       actorId: 'stripe-webhook',
  //     });
  //     break;
  //   }
  //
  //   case 'customer.subscription.updated': {
  //     const subscription = stripeEvent.data.object as Stripe.Subscription;
  //     const product = subscription.items.data[0]?.price.product as Stripe.Product;
  //     const plan = stripePlanType(product.metadata);
  //
  //     // Find entitlement by stripeSubscriptionId, then update plan
  //     // await updateEntitlementPlan(accountId, avatarId, plan, 'stripe-webhook');
  //     break;
  //   }
  //
  //   case 'customer.subscription.deleted': {
  //     const subscription = stripeEvent.data.object as Stripe.Subscription;
  //     // Downgrade to free
  //     // await setEntitlement({ ..., plan: 'free', status: 'cancelled', entitlementSource: 'stripe' });
  //     break;
  //   }
  //
  //   case 'invoice.payment_failed': {
  //     const invoice = stripeEvent.data.object as Stripe.Invoice;
  //     // Suspend entitlement
  //     // await suspendEntitlement(accountId, avatarId, 'Payment failed', 'stripe-webhook');
  //     break;
  //   }
  //
  //   case 'invoice.paid': {
  //     const invoice = stripeEvent.data.object as Stripe.Invoice;
  //     // Reactivate if previously suspended
  //     // if (entitlement.status === 'suspended') {
  //     //   await setEntitlement({ ..., status: 'active' });
  //     // }
  //     break;
  //   }
  // }

  // Always return 200 to acknowledge receipt (Stripe retries on non-2xx)
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}
