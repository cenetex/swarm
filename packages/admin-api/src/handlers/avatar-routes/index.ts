/**
 * Barrel export for all avatar route domain handlers.
 */
export { handleSystemRoutes } from './system.js';
export { handleCrudRoutes } from './crud.js';
export { handleEntitlementRoutes } from './entitlements.js';
export { handleTelegramRoutes } from './telegram.js';
export { handleSecretsRoutes } from './secrets.js';
export { handleEnergyRoutes } from './energy.js';
export { handleObservabilityRoutes } from './observability.js';
export { handleTwitterRoutes } from './twitter.js';
export { handleApiKeyRoutes } from './api-keys.js';
export { handleOnboardingAvatarRoutes } from './onboarding.js';
export { handleMemoryRoutes } from './memory.js';
export { handleUsageRoutes } from './usage.js';
export type { RouteContext, RouteHandler } from './types.js';
