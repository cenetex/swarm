/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Stripe Billing Service
 *
 * Thin Stripe API wrapper used by billing endpoints and webhook handling.
 * Keeps payment provider concerns out of route handlers.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHmac, timingSafeEqual } from 'crypto';
import type { EntitlementRecord, PlanType } from '../types.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const WEBHOOK_TOLERANCE_SECONDS = 300;

let secretsClient: SecretsManagerClient = new SecretsManagerClient({});

let stripeSecretKey: string | null = process.env.STRIPE_SECRET_KEY || null;
let stripeSecretKeyFetched = false;

let stripeWebhookSecret: string | null = process.env.STRIPE_WEBHOOK_SECRET || null;
let stripeWebhookSecretFetched = false;

type StripeEntitlementStatus = EntitlementRecord['status'];

export interface StripeCheckoutSession {
  id: string;
  url?: string;
  customer?: string | { id?: string };
  subscription?: string | { id?: string };
  metadata?: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  status?: string;
  customer?: string | { id?: string };
  metadata?: Record<string, string>;
  trial_end?: number | null;
  items?: {
    data?: Array<{
      price?: {
        id?: string;
      };
    }>;
  };
}

export interface StripeInvoice {
  id: string;
  customer?: string | { id?: string };
  subscription?: string | { id?: string };
}

export interface StripeWebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

function getPriceIdMap(): Record<'pro' | 'enterprise', string | undefined> {
  return {
    pro: process.env.STRIPE_PRICE_ID_PRO,
    enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE,
  };
}

async function getSecretValue(secretArn: string): Promise<string | null> {
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
      })
    );
    return response.SecretString || null;
  } catch (error) {
    console.error('[StripeBilling] Failed to fetch secret from Secrets Manager:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function getStripeSecretKey(): Promise<string> {
  if (stripeSecretKey) return stripeSecretKey;
  const arn = process.env.STRIPE_SECRET_KEY_ARN;
  if (!stripeSecretKeyFetched && arn) {
    stripeSecretKey = await getSecretValue(arn);
    if (stripeSecretKey) {
      stripeSecretKeyFetched = true;
    }
  }
  if (!stripeSecretKey) {
    throw new Error('Missing STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_ARN');
  }
  return stripeSecretKey;
}

export async function getStripeWebhookSecret(): Promise<string> {
  if (stripeWebhookSecret) return stripeWebhookSecret;
  const arn = process.env.STRIPE_WEBHOOK_SECRET_ARN;
  if (!stripeWebhookSecretFetched && arn) {
    stripeWebhookSecret = await getSecretValue(arn);
    if (stripeWebhookSecret) {
      stripeWebhookSecretFetched = true;
    }
  }
  if (!stripeWebhookSecret) {
    throw new Error('Missing STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_ARN');
  }
  return stripeWebhookSecret;
}

function parseStripeErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const err = (data as { error?: { message?: string } }).error;
  return err?.message || fallback;
}

async function stripeRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  params?: URLSearchParams,
): Promise<T> {
  const secretKey = await getStripeSecretKey();
  const url = new URL(`${STRIPE_API_BASE}${path}`);
  const requestInit: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  };

  if (method === 'GET') {
    if (params) {
      for (const [key, value] of params.entries()) {
        url.searchParams.append(key, value);
      }
    }
  } else if (params) {
    requestInit.headers = {
      ...requestInit.headers,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    requestInit.body = params.toString();
  }

  const response = await fetch(url.toString(), requestInit);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = parseStripeErrorMessage(data, `Stripe API error (${response.status})`);
    throw new Error(message);
  }

  return data as T;
}

export function extractStripeObjectId(value: string | { id?: string } | undefined | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.id === 'string' && value.id) return value.id;
  return null;
}

export function getStripePriceIdForPlan(plan: 'pro' | 'enterprise'): string {
  const priceId = getPriceIdMap()[plan];
  if (!priceId) {
    throw new Error(`Missing Stripe price ID for plan: ${plan}`);
  }
  return priceId;
}

export function planFromStripePriceId(priceId: string): PlanType | null {
  if (!priceId) return null;
  const priceIds = getPriceIdMap();
  if (priceIds.pro && priceId === priceIds.pro) return 'pro';
  if (priceIds.enterprise && priceId === priceIds.enterprise) return 'enterprise';
  return null;
}

export function planFromStripeSubscription(subscription: StripeSubscription): PlanType | null {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  return planFromStripePriceId(priceId);
}

export function mapStripeSubscriptionStatus(status: string | undefined): StripeEntitlementStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trial';
    case 'canceled':
      return 'cancelled';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'suspended';
    default:
      return 'suspended';
  }
}

export async function createStripeCheckoutSession(params: {
  accountId: string;
  avatarId: string;
  plan: 'pro' | 'enterprise';
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
  customerEmail?: string;
}): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('line_items[0][price]', getStripePriceIdForPlan(params.plan));
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', params.successUrl);
  body.set('cancel_url', params.cancelUrl);
  body.set('allow_promotion_codes', 'true');
  body.set('metadata[accountId]', params.accountId);
  body.set('metadata[avatarId]', params.avatarId);
  body.set('metadata[plan]', params.plan);
  body.set('subscription_data[metadata][accountId]', params.accountId);
  body.set('subscription_data[metadata][avatarId]', params.avatarId);
  body.set('subscription_data[metadata][plan]', params.plan);

  if (params.customerId) {
    body.set('customer', params.customerId);
  } else if (params.customerEmail) {
    body.set('customer_email', params.customerEmail);
  }

  return stripeRequest<StripeCheckoutSession>('POST', '/checkout/sessions', body);
}

export async function createStripeCustomerPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<{ id: string; url?: string }> {
  const body = new URLSearchParams();
  body.set('customer', params.customerId);
  body.set('return_url', params.returnUrl);
  return stripeRequest<{ id: string; url?: string }>('POST', '/billing_portal/sessions', body);
}

export async function retrieveStripeSubscription(subscriptionId: string): Promise<StripeSubscription> {
  const query = new URLSearchParams();
  query.set('expand[]', 'items.data.price');
  return stripeRequest<StripeSubscription>('GET', `/subscriptions/${subscriptionId}`, query);
}

function parseStripeSignature(signatureHeader: string): {
  timestamp: number;
  signatures: string[];
} | null {
  const parts = signatureHeader
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function secureHexEquals(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowMs = Date.now(),
): boolean {
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed) return false;

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac('sha256', webhookSecret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return parsed.signatures.some((sig) => secureHexEquals(sig, expected));
}

/**
 * Reset module-level secret cache and optionally inject a mock SecretsManager client. Test-only.
 */
export function _resetForTesting(mockClient?: SecretsManagerClient): void {
  stripeSecretKey = null;
  stripeSecretKeyFetched = false;
  stripeWebhookSecret = null;
  stripeWebhookSecretFetched = false;
  if (mockClient) {
    secretsClient = mockClient;
  }
}
