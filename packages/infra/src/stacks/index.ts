/**
 * Stack exports
 */
// Core, API, and UI stacks (main application)
export { CoreInfraStack, type CoreInfraStackProps } from './core-infra-stack.js';
export { AdminApiStack, type AdminApiStackProps, apiEndpointParamName } from './admin-api-stack.js';
export { FrontendStack, type FrontendStackProps } from './frontend-stack.js';
export { ProfilePageStack, type ProfilePageStackProps } from './profile-page-stack.js';
export { DocsSiteStack, type DocsSiteStackProps } from './docs-site-stack.js';

// Legacy stacks (kept for backwards compatibility, not instantiated in bin/swarm.ts)
export { SharedInfraStack, type SharedInfraStackProps } from './shared-infra-stack.js';
export { MessagingStack, type MessagingStackProps } from './messaging-stack.js';
export { MediaStack, type MediaStackProps } from './media-stack.js';
export { StationStack, type StationStackProps } from './station-stack.js';
export { AdminUiStack, type AdminUiStackProps } from './admin-ui-stack.js';
