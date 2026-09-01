import { describe, expect, it } from 'bun:test';
import { hostedBillingLabel, hostedRuntimeLabel } from './HostingModePanel';

describe('hosted lifecycle labels', () => {
  it('does not describe pending checkout as paid', () => {
    expect(hostedBillingLabel('checkout-pending')).toBe('Checkout pending confirmation');
    expect(hostedBillingLabel('paid')).toBe('Payment confirmed');
  });

  it('keeps provisioning, health, failure, and cancellation distinct', () => {
    expect(hostedRuntimeLabel('provisioning')).toBe('Provisioning');
    expect(hostedRuntimeLabel('health-checking')).toBe('Checking health');
    expect(hostedRuntimeLabel('failed')).toBe('Failed');
    expect(hostedRuntimeLabel('cancelled')).toBe('Cancelled');
  });
});
