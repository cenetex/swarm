/**
 * Billing Domain
 *
 * Credits, entitlements, energy system, Stripe billing,
 * runtime limits, burn stats, and active user limits.
 */
export * from '../credits.js';
export * from '../entitlements.js';
export * from '../energy-burn.js';
export * from '../stripe-billing.js';
export * from '../runtime-limits.js';
export * from '../orb-slots.js';
export * from '../active-user-limit.js';

// Namespaced re-exports to avoid conflicts
export * as burnStats from '../burn-stats.js';

// Energy service types that don't conflict with credits.js wrappers
export type {
  EnergyStatus,
  EnergyConfig,
  ConsumeEnergyResult,
  EnergyEvent,
  EnergyCostType,
  EnergyServiceDeps,
} from '../energy.js';
