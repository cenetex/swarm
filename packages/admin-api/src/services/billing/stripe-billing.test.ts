/**
 * Tests for Stripe billing service.
 *
 * Covers webhook signature verification, price-to-plan mapping, and
 * secret resolution retry behavior after transient Secrets Manager failures.
 *
 * Uses bun:test (project convention).
 *
 * NOTE: env vars must be set BEFORE the stripe-billing module is loaded,
 * because `STRIPE_SECRET_KEY_ARN` / `STRIPE_WEBHOOK_SECRET_ARN` are captured
 * as `const` at module init. We use dynamic import() to guarantee ordering.
 */
import { createHmac } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// ---------------------------------------------------------------------------
// Set env vars BEFORE dynamically loading the module under test
// ---------------------------------------------------------------------------
process.env.STRIPE_SECRET_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe-key';
process.env.STRIPE_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe-webhook';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

// Dynamic import so the module sees the env vars above.
type StripeBillingModule = typeof import('./stripe-billing.js');
let mod: StripeBillingModule;

beforeAll(async () => {
  mod = await import('./stripe-billing.js');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(sendImpl: (...args: unknown[]) => unknown): SecretsManagerClient {
  const client = new SecretsManagerClient({});
  client.send = mock(sendImpl as typeof client.send) as typeof client.send;
  return client;
}

// ---------------------------------------------------------------------------
// Price / plan mapping
// ---------------------------------------------------------------------------

describe('stripe-billing', () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro_123';
    process.env.STRIPE_PRICE_ID_ENTERPRISE = 'price_ent_456';
  });

  it('maps Stripe price IDs to plan types', () => {
    expect(mod.planFromStripePriceId('price_pro_123')).toBe('pro');
    expect(mod.planFromStripePriceId('price_ent_456')).toBe('enterprise');
    expect(mod.planFromStripePriceId('price_unknown')).toBeNull();
  });

  it('verifies Stripe webhook signatures', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_123', type: 'checkout.session.completed' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8')
      .digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const verified = mod.verifyStripeWebhookSignature(payload, header, secret, timestamp * 1000);
    expect(verified).toBe(true);
  });

  it('rejects expired webhook signatures', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_123' });
    const timestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8')
      .digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const verified = mod.verifyStripeWebhookSignature(payload, header, secret, Date.now());
    expect(verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStripeSecretKey — transient failure retry
// ---------------------------------------------------------------------------

describe('getStripeSecretKey', () => {
  beforeEach(() => {
    mod._resetForTesting();
  });

  it('returns the secret on successful fetch', async () => {
    const client = createMockClient(() =>
      Promise.resolve({ SecretString: 'sk_test_abc123' })
    );
    mod._resetForTesting(client);

    const key = await mod.getStripeSecretKey();
    expect(key).toBe('sk_test_abc123');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('caches the secret and does not re-fetch on subsequent calls', async () => {
    const client = createMockClient(() =>
      Promise.resolve({ SecretString: 'sk_test_abc123' })
    );
    mod._resetForTesting(client);

    await mod.getStripeSecretKey();
    await mod.getStripeSecretKey();
    await mod.getStripeSecretKey();

    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('retries after a transient failure (send throws)', async () => {
    let callCount = 0;
    const client = createMockClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Transient network error'));
      }
      return Promise.resolve({ SecretString: 'sk_test_recovered' });
    });
    mod._resetForTesting(client);

    // First call should fail (transient error in getSecretValue returns null, then throws)
    await expect(mod.getStripeSecretKey()).rejects.toThrow(
      'Missing STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_ARN'
    );

    // Second call should retry and succeed
    const key = await mod.getStripeSecretKey();
    expect(key).toBe('sk_test_recovered');
    expect(callCount).toBe(2);
  });

  it('retries after a transient failure (send returns null SecretString)', async () => {
    let callCount = 0;
    const client = createMockClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ SecretString: null });
      }
      return Promise.resolve({ SecretString: 'sk_test_recovered' });
    });
    mod._resetForTesting(client);

    // First call: getSecretValue returns null, so getStripeSecretKey throws
    await expect(mod.getStripeSecretKey()).rejects.toThrow(
      'Missing STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_ARN'
    );

    // Second call should retry and succeed
    const key = await mod.getStripeSecretKey();
    expect(key).toBe('sk_test_recovered');
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getStripeWebhookSecret — transient failure retry
// ---------------------------------------------------------------------------

describe('getStripeWebhookSecret', () => {
  beforeEach(() => {
    mod._resetForTesting();
  });

  it('returns the secret on successful fetch', async () => {
    const client = createMockClient(() =>
      Promise.resolve({ SecretString: 'whsec_test_abc123' })
    );
    mod._resetForTesting(client);

    const secret = await mod.getStripeWebhookSecret();
    expect(secret).toBe('whsec_test_abc123');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('caches the secret and does not re-fetch on subsequent calls', async () => {
    const client = createMockClient(() =>
      Promise.resolve({ SecretString: 'whsec_test_abc123' })
    );
    mod._resetForTesting(client);

    await mod.getStripeWebhookSecret();
    await mod.getStripeWebhookSecret();
    await mod.getStripeWebhookSecret();

    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('retries after a transient failure (send throws)', async () => {
    let callCount = 0;
    const client = createMockClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Transient network error'));
      }
      return Promise.resolve({ SecretString: 'whsec_test_recovered' });
    });
    mod._resetForTesting(client);

    // First call should fail
    await expect(mod.getStripeWebhookSecret()).rejects.toThrow(
      'Missing STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_ARN'
    );

    // Second call should retry and succeed
    const secret = await mod.getStripeWebhookSecret();
    expect(secret).toBe('whsec_test_recovered');
    expect(callCount).toBe(2);
  });

  it('retries after a transient failure (send returns null SecretString)', async () => {
    let callCount = 0;
    const client = createMockClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ SecretString: null });
      }
      return Promise.resolve({ SecretString: 'whsec_test_recovered' });
    });
    mod._resetForTesting(client);

    // First call: getSecretValue returns null, so getStripeWebhookSecret throws
    await expect(mod.getStripeWebhookSecret()).rejects.toThrow(
      'Missing STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_ARN'
    );

    // Second call should retry and succeed
    const secret = await mod.getStripeWebhookSecret();
    expect(secret).toBe('whsec_test_recovered');
    expect(callCount).toBe(2);
  });
});
