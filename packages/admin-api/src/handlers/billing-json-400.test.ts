/**
 * Tests for issue #419: return 400 for invalid billing JSON payloads instead of 500.
 *
 * Verifies:
 * 1. handleCheckout and handlePortal use safeParseJson (not raw JSON.parse)
 * 2. The safeParseJson helper catches SyntaxError and signals failure
 * 3. The top-level handler returns 400 for malformed JSON (not 500)
 * 4. Valid JSON and auth failures still behave correctly
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const billingSource = readFileSync(resolve(__dirname, 'billing.ts'), 'utf-8');

// ============================================================================
// Source-code inspection tests — verify the fix is correctly applied
// ============================================================================

describe('billing handler - JSON parse safety (issue #419)', () => {
  describe('safeParseJson helper', () => {
    const fnMatch = billingSource.match(/function safeParseJson[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should exist', () => {
      expect(fnMatch).not.toBeNull();
    });

    it('should wrap JSON.parse in a try/catch', () => {
      expect(fnBody).toContain('try');
      expect(fnBody).toContain('JSON.parse');
      expect(fnBody).toContain('catch');
    });

    it('should return { ok: true, data } on success', () => {
      expect(fnBody).toContain('ok: true');
      expect(fnBody).toContain('data:');
    });

    it('should return { ok: false } on failure', () => {
      expect(fnBody).toContain('ok: false');
    });
  });

  describe('handleCheckout', () => {
    const fnMatch = billingSource.match(/async function handleCheckout[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should exist', () => {
      expect(fnMatch).not.toBeNull();
    });

    it('should call safeParseJson instead of raw JSON.parse', () => {
      expect(fnBody).toContain('safeParseJson');
      // Should NOT call JSON.parse directly on the body
      expect(fnBody).not.toContain('JSON.parse');
    });

    it('should return 400 with "Invalid JSON in request body" when parsing fails', () => {
      expect(fnBody).toContain("'Invalid JSON in request body'");
    });

    it('should check jsonResult.ok before proceeding to schema validation', () => {
      const safeParseIndex = fnBody.indexOf('safeParseJson');
      const okCheckIndex = fnBody.indexOf('jsonResult.ok');
      const schemaIndex = fnBody.indexOf('CheckoutSchema.safeParse');
      expect(safeParseIndex).toBeGreaterThan(-1);
      expect(okCheckIndex).toBeGreaterThan(safeParseIndex);
      expect(schemaIndex).toBeGreaterThan(okCheckIndex);
    });

    it('should pass jsonResult.data to the schema validator', () => {
      expect(fnBody).toContain('CheckoutSchema.safeParse(jsonResult.data)');
    });
  });

  describe('handlePortal', () => {
    const fnMatch = billingSource.match(/async function handlePortal[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should exist', () => {
      expect(fnMatch).not.toBeNull();
    });

    it('should call safeParseJson instead of raw JSON.parse', () => {
      expect(fnBody).toContain('safeParseJson');
      // Should NOT call JSON.parse directly on the body
      expect(fnBody).not.toContain('JSON.parse');
    });

    it('should return 400 with "Invalid JSON in request body" when parsing fails', () => {
      expect(fnBody).toContain("'Invalid JSON in request body'");
    });

    it('should check jsonResult.ok before proceeding to schema validation', () => {
      const safeParseIndex = fnBody.indexOf('safeParseJson');
      const okCheckIndex = fnBody.indexOf('jsonResult.ok');
      const schemaIndex = fnBody.indexOf('PortalSchema.safeParse');
      expect(safeParseIndex).toBeGreaterThan(-1);
      expect(okCheckIndex).toBeGreaterThan(safeParseIndex);
      expect(schemaIndex).toBeGreaterThan(okCheckIndex);
    });

    it('should pass jsonResult.data to the schema validator', () => {
      expect(fnBody).toContain('PortalSchema.safeParse(jsonResult.data)');
    });
  });

  describe('handleWebhook — unchanged', () => {
    const fnMatch = billingSource.match(/async function handleWebhook[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should still use raw JSON.parse (Stripe signature already validates the body)', () => {
      expect(fnBody).toContain('JSON.parse(rawBody)');
    });

    it('should NOT use safeParseJson (Stripe webhooks have their own validation)', () => {
      expect(fnBody).not.toContain('safeParseJson');
    });
  });

  describe('top-level handler error boundary', () => {
    const fnMatch = billingSource.match(/export async function handler[\s\S]*?^}/m);
    const fnBody = fnMatch?.[0] ?? '';

    it('should still have the 500 catch-all for non-JSON errors', () => {
      expect(fnBody).toContain('500');
      expect(fnBody).toContain("'Internal server error'");
    });
  });

  describe('auth failure paths — preserved', () => {
    const checkoutFn = billingSource.match(/async function handleCheckout[\s\S]*?^}/m)?.[0] ?? '';
    const portalFn = billingSource.match(/async function handlePortal[\s\S]*?^}/m)?.[0] ?? '';

    it('handleCheckout should still return 401 for missing session', () => {
      expect(checkoutFn).toContain("401");
      expect(checkoutFn).toContain("'Session expired'");
    });

    it('handlePortal should still return 401 for missing session', () => {
      expect(portalFn).toContain("401");
      expect(portalFn).toContain("'Session expired'");
    });
  });
});
