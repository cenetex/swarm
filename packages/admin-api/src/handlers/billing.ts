/* eslint-disable no-console -- TODO: migrate to structured logger */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';

import { getSessionFromCookie, getClearSessionCookies } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { getAvatar } from '../services/avatars.js';
import {
  findEntitlementByStripeSubscriptionId,
  getEntitlementByAccount,
  setEntitlement,
  setEntitlementStatus,
  suspendEntitlement,
} from '../services/billing/entitlements.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import {
  createStripeCheckoutSession,
  createStripeCustomerPortalSession,
  extractStripeObjectId,
  getStripeWebhookSecret,
  mapStripeSubscriptionStatus,
  planFromStripeSubscription,
  retrieveStripeSubscription,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
  type StripeWebhookEvent,
  verifyStripeWebhookSignature,
} from '../services/billing/stripe-billing.js';
import { isAdminWallet } from './avatar-routes/shared.js';
import { syncRuntimeContractForAvatar } from './avatar-routes/runtime-sync.js';

const CheckoutSchema = z.object({
  avatarId: z.string().min(1),
  plan: z.enum(['pro', 'enterprise']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const PortalSchema = z.object({
  avatarId: z.string().min(1),
  returnUrl: z.string().url(),
});

function normalizePath(rawPath: string): string {
  if (rawPath === '/api') return '/';
  if (rawPath.startsWith('/api/')) return rawPath.slice('/api'.length);
  return rawPath;
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
  cookies?: string[],
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

function readBody(event: APIGatewayProxyEventV2): string {
  const body = event.body || '';
  if (!body) return '';
  if (event.isBase64Encoded) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}

function safeParseJson(raw: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(raw || '{}') };
  } catch {
    return { ok: false };
  }
}

function parseSignatureHeader(headers: Record<string, string | undefined>): string | null {
  return headers['stripe-signature'] || headers['Stripe-Signature'] || null;
}

async function assertAvatarAccess(
  avatarId: string,
  walletAddress: string,
  effectiveIsAdmin: boolean,
): Promise<{ ok: true } | { ok: false; statusCode: number; error: string }> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) return { ok: false, statusCode: 404, error: 'Avatar not found' };
  if (effectiveIsAdmin) return { ok: true };

  const isOwner = avatar.creatorWallet === walletAddress;
  if (!isOwner) return { ok: false, statusCode: 403, error: 'Forbidden' };
  return { ok: true };
}

async function handleCheckout(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const sessionToken = getSessionFromCookie(event);
  if (!sessionToken) {
    return jsonResponse(401, { error: 'Session expired' }, corsHeaders);
  }

  const walletSession = await getSessionWithUser(sessionToken);
  if (!walletSession) {
    return jsonResponse(401, { error: 'Session expired' }, corsHeaders, getClearSessionCookies());
  }
  if (!walletSession.accountId) {
    return jsonResponse(401, { error: 'Session missing account context' }, corsHeaders);
  }

  const rawBody = readBody(event);
  const jsonResult = safeParseJson(rawBody);
  if (!jsonResult.ok) {
    return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
  }

  const parsed = CheckoutSchema.safeParse(jsonResult.data);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, corsHeaders);
  }

  const effectiveIsAdmin = isAdminWallet(walletSession.walletAddress);
  const access = await assertAvatarAccess(parsed.data.avatarId, walletSession.walletAddress, effectiveIsAdmin);
  if (!access.ok) {
    return jsonResponse(access.statusCode, { error: access.error }, corsHeaders);
  }

  // Use account-scoped lookup to prevent cross-account Stripe customer leakage.
  // getEntitlement(avatarId) returns ANY entitlement for the avatar regardless of
  // account, which after reassignment could belong to the previous owner.
  const existingEntitlement = await getEntitlementByAccount(walletSession.accountId, parsed.data.avatarId);
  const existingCustomerId = existingEntitlement?.stripeCustomerId;

  const checkout = await createStripeCheckoutSession({
    accountId: walletSession.accountId,
    avatarId: parsed.data.avatarId,
    plan: parsed.data.plan,
    successUrl: parsed.data.successUrl,
    cancelUrl: parsed.data.cancelUrl,
    customerId: existingCustomerId,
  });

  return jsonResponse(200, {
    sessionId: checkout.id,
    url: checkout.url,
  }, corsHeaders);
}

async function handlePortal(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const sessionToken = getSessionFromCookie(event);
  if (!sessionToken) {
    return jsonResponse(401, { error: 'Session expired' }, corsHeaders);
  }

  const walletSession = await getSessionWithUser(sessionToken);
  if (!walletSession) {
    return jsonResponse(401, { error: 'Session expired' }, corsHeaders, getClearSessionCookies());
  }

  const rawBody = readBody(event);
  const jsonResult = safeParseJson(rawBody);
  if (!jsonResult.ok) {
    return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
  }

  const parsed = PortalSchema.safeParse(jsonResult.data);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, corsHeaders);
  }

  if (!walletSession.accountId) {
    return jsonResponse(401, { error: 'Session missing account context' }, corsHeaders);
  }

  const effectiveIsAdmin = isAdminWallet(walletSession.walletAddress);
  const access = await assertAvatarAccess(parsed.data.avatarId, walletSession.walletAddress, effectiveIsAdmin);
  if (!access.ok) {
    return jsonResponse(access.statusCode, { error: access.error }, corsHeaders);
  }

  // Use account-scoped lookup to prevent cross-account Stripe customer leakage.
  // getEntitlement(avatarId) returns ANY entitlement for the avatar regardless of
  // account, which after reassignment could belong to the previous owner.
  const entitlement = await getEntitlementByAccount(walletSession.accountId, parsed.data.avatarId);
  if (!entitlement?.stripeCustomerId) {
    return jsonResponse(400, { error: 'No Stripe customer found for this avatar' }, corsHeaders);
  }

  const portal = await createStripeCustomerPortalSession({
    customerId: entitlement.stripeCustomerId,
    returnUrl: parsed.data.returnUrl,
  });

  return jsonResponse(200, {
    sessionId: portal.id,
    url: portal.url,
  }, corsHeaders);
}

async function resolveEntitlementContext(params: {
  metadata?: Record<string, string>;
  subscriptionId?: string | null;
}): Promise<{ accountId: string; avatarId: string } | null> {
  const accountId = params.metadata?.accountId;
  const avatarId = params.metadata?.avatarId;
  if (accountId && avatarId) {
    return { accountId, avatarId };
  }

  if (!params.subscriptionId) return null;
  const bySubscription = await findEntitlementByStripeSubscriptionId(params.subscriptionId);
  if (bySubscription) {
    return {
      accountId: bySubscription.accountId,
      avatarId: bySubscription.avatarId,
    };
  }

  try {
    const subscription = await retrieveStripeSubscription(params.subscriptionId);
    const subscriptionAccountId = subscription.metadata?.accountId;
    const subscriptionAvatarId = subscription.metadata?.avatarId;
    if (subscriptionAccountId && subscriptionAvatarId) {
      return {
        accountId: subscriptionAccountId,
        avatarId: subscriptionAvatarId,
      };
    }
  } catch (error) {
    console.error('[Billing] Failed to resolve subscription metadata:', error instanceof Error ? error.message : String(error));
  }

  return null;
}

async function upsertStripeEntitlement(params: {
  accountId: string;
  avatarId: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'cancelled' | 'trial';
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  trialEndsAt?: number;
}): Promise<void> {
  const existing = await getEntitlementByAccount(params.accountId, params.avatarId);
  await setEntitlement({
    accountId: params.accountId,
    avatarId: params.avatarId,
    plan: params.plan,
    overrides: existing?.overrides,
    status: params.status,
    trialEndsAt: params.trialEndsAt,
    stripeSubscriptionId: params.stripeSubscriptionId ?? existing?.stripeSubscriptionId,
    stripeCustomerId: params.stripeCustomerId ?? existing?.stripeCustomerId,
    actorId: 'stripe-webhook',
    entitlementSource: 'stripe',
  });
  await syncRuntimeContractForAvatar(params.avatarId);
}

async function handleWebhook(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const signatureHeader = parseSignatureHeader(event.headers);
  if (!signatureHeader) {
    return jsonResponse(400, { error: 'Missing Stripe signature header' }, corsHeaders);
  }

  const rawBody = readBody(event);
  if (!rawBody) {
    return jsonResponse(400, { error: 'Missing request body' }, corsHeaders);
  }

  const webhookSecret = await getStripeWebhookSecret();
  const signatureOk = verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret);
  if (!signatureOk) {
    return jsonResponse(400, { error: 'Invalid Stripe signature' }, corsHeaders);
  }

  const stripeEvent = JSON.parse(rawBody) as StripeWebhookEvent;

  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object as StripeCheckoutSession;
      const subscriptionId = extractStripeObjectId(session.subscription);
      const customerId = extractStripeObjectId(session.customer);

      const context = await resolveEntitlementContext({
        metadata: session.metadata,
        subscriptionId,
      });
      if (!context) break;

      let plan: 'pro' | 'enterprise' | null = null;
      let trialEndsAt: number | undefined;
      if (subscriptionId) {
        const subscription = await retrieveStripeSubscription(subscriptionId);
        const inferredPlan = planFromStripeSubscription(subscription);
        if (inferredPlan === 'pro' || inferredPlan === 'enterprise') {
          plan = inferredPlan;
        }
        if (typeof subscription.trial_end === 'number') {
          trialEndsAt = subscription.trial_end * 1000;
        }
      }
      if (!plan) {
        const metadataPlan = session.metadata?.plan;
        if (metadataPlan === 'pro' || metadataPlan === 'enterprise') {
          plan = metadataPlan;
        }
      }
      if (!plan) break;

      await upsertStripeEntitlement({
        accountId: context.accountId,
        avatarId: context.avatarId,
        plan,
        status: 'active',
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId ?? undefined,
        trialEndsAt,
      });
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = stripeEvent.data.object as StripeSubscription;
      const subscriptionId = subscription.id;
      const customerId = extractStripeObjectId(subscription.customer);
      const context = await resolveEntitlementContext({
        metadata: subscription.metadata,
        subscriptionId,
      });
      if (!context) break;

      const inferredPlan = planFromStripeSubscription(subscription);
      const status = mapStripeSubscriptionStatus(subscription.status);
      let plan: 'free' | 'pro' | 'enterprise';
      if (status === 'cancelled') {
        plan = 'free';
      } else if (inferredPlan === 'pro' || inferredPlan === 'enterprise') {
        plan = inferredPlan;
      } else {
        const priceId = subscription.items?.data?.[0]?.price?.id ?? 'undefined';
        console.warn(
          `[Billing] Unknown Stripe price ID "${priceId}" on subscription ${subscriptionId} ` +
          `for avatar ${context.avatarId} — skipping plan update to preserve current entitlement`,
        );
        break;
      }
      const trialEndsAt = typeof subscription.trial_end === 'number'
        ? subscription.trial_end * 1000
        : undefined;

      await upsertStripeEntitlement({
        accountId: context.accountId,
        avatarId: context.avatarId,
        plan,
        status,
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId,
        trialEndsAt,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = stripeEvent.data.object as StripeSubscription;
      const subscriptionId = subscription.id;
      const customerId = extractStripeObjectId(subscription.customer);
      const context = await resolveEntitlementContext({
        metadata: subscription.metadata,
        subscriptionId,
      });
      if (!context) break;

      await upsertStripeEntitlement({
        accountId: context.accountId,
        avatarId: context.avatarId,
        plan: 'free',
        status: 'cancelled',
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId,
      });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = stripeEvent.data.object as StripeInvoice;
      const subscriptionId = extractStripeObjectId(invoice.subscription);
      if (!subscriptionId) break;
      const entitlement = await findEntitlementByStripeSubscriptionId(subscriptionId);
      if (!entitlement) break;
      await suspendEntitlement(
        entitlement.accountId,
        entitlement.avatarId,
        'Payment failed',
        'stripe-webhook',
      );
      await syncRuntimeContractForAvatar(entitlement.avatarId);
      break;
    }

    case 'invoice.paid': {
      const invoice = stripeEvent.data.object as StripeInvoice;
      const subscriptionId = extractStripeObjectId(invoice.subscription);
      if (!subscriptionId) break;
      const entitlement = await findEntitlementByStripeSubscriptionId(subscriptionId);
      if (!entitlement) break;
      await setEntitlementStatus(
        entitlement.accountId,
        entitlement.avatarId,
        'active',
        'stripe-webhook',
      );
      await syncRuntimeContractForAvatar(entitlement.avatarId);
      break;
    }

    default:
      // Ignore unsupported Stripe events.
      break;
  }

  return jsonResponse(200, { received: true }, corsHeaders);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
  const method = event.requestContext.http.method;
  const path = normalizePath(event.rawPath);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    if (path === '/billing/checkout' && method === 'POST') {
      return handleCheckout(event, corsHeaders);
    }

    if (path === '/billing/portal' && method === 'POST') {
      return handlePortal(event, corsHeaders);
    }

    if (path === '/webhook/stripe' && method === 'POST') {
      return handleWebhook(event, corsHeaders);
    }

    return jsonResponse(404, { error: 'Not found' }, corsHeaders);
  } catch (error) {
    console.error('[Billing] Handler error:', error instanceof Error ? error.message : String(error));
    return jsonResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    }, corsHeaders);
  }
}
