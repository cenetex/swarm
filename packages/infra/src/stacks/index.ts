/**
 * Stack exports
 */
// New split stacks for parallel deployment
export { SharedInfraStack, type SharedInfraStackProps } from './shared-infra-stack.js';
export { AdminApiStack, type AdminApiStackProps, apiEndpointParamName } from './admin-api-stack.js';
export { AdminUiStack, type AdminUiStackProps } from './admin-ui-stack.js';
export { ProfilePageStack, type ProfilePageStackProps } from './profile-page-stack.js';
