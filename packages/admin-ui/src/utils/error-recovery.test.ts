/**
 * Tests for error recovery guidance mapping.
 *
 * Validates that common activation-blocking errors are correctly
 * identified and mapped to actionable recovery guidance.
 */
import { describe, it, expect } from 'vitest';
import { getErrorRecovery } from './error-recovery';

describe('getErrorRecovery', () => {
  describe('credit exhaustion (402)', () => {
    it('detects credit exhaustion errors', () => {
      const result = getErrorRecovery(
        "Unable to respond — the AI provider's credit balance has been exhausted."
      );
      expect(result).not.toBeNull();
      expect(result!.title).toBe('AI Credits Exhausted');
      expect(result!.severity).toBe('error');
      expect(result!.actions.length).toBeGreaterThan(0);
    });

    it('detects 402 status code mentions', () => {
      const result = getErrorRecovery('OpenRouter API error: 402');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('AI Credits Exhausted');
    });
  });

  describe('rate limiting (429)', () => {
    it('detects rate limit errors', () => {
      const result = getErrorRecovery('LLM rate limited');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Rate Limited');
      expect(result!.severity).toBe('warning');
    });

    it('detects 429 status code mentions', () => {
      const result = getErrorRecovery('Error: 429 Too many requests');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Rate Limited');
    });
  });

  describe('service unavailable (503)', () => {
    it('detects circuit breaker errors', () => {
      const result = getErrorRecovery('Circuit breaker open');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Temporarily Unavailable');
      expect(result!.severity).toBe('warning');
    });

    it('detects LLM temporarily unavailable', () => {
      const result = getErrorRecovery('LLM temporarily unavailable');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Temporarily Unavailable');
    });
  });

  describe('timeout (504)', () => {
    it('detects timeout errors', () => {
      const result = getErrorRecovery('Request timed out');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Request Timed Out');
      expect(result!.severity).toBe('warning');
    });
  });

  describe('missing API key', () => {
    it('detects missing API key errors', () => {
      const result = getErrorRecovery('API key missing for OpenRouter');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('API Key Not Configured');
      expect(result!.severity).toBe('error');
    });

    it('detects secret not set errors', () => {
      const result = getErrorRecovery('Secret not set: OPENROUTER_API_KEY');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('API Key Not Configured');
    });
  });

  describe('webhook / platform issues', () => {
    it('detects webhook setup failures', () => {
      const result = getErrorRecovery('Webhook not set for this avatar');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Platform Integration Issue');
      expect(result!.severity).toBe('error');
    });

    it('detects Telegram bot token issues', () => {
      const result = getErrorRecovery('Telegram invalid token');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Platform Integration Issue');
    });
  });

  describe('network errors', () => {
    it('detects network errors', () => {
      const result = getErrorRecovery('Failed to fetch');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Network Error');
      expect(result!.severity).toBe('error');
    });
  });

  describe('plan limit errors', () => {
    it('detects daily limit exceeded', () => {
      const result = getErrorRecovery('Daily limit reached for messages');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Daily Limit Reached');
      expect(result!.severity).toBe('warning');
    });

    it('detects entitlement exceeded', () => {
      const result = getErrorRecovery('Entitlement exceeded for media credits');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Daily Limit Reached');
    });
  });

  describe('unknown errors', () => {
    it('returns null for unrecognized errors', () => {
      const result = getErrorRecovery('Some random unrecognized error');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = getErrorRecovery('');
      expect(result).toBeNull();
    });
  });
});
