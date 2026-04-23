/**
 * Tool Prompt Components - Main router and exports
 * These render inline with chat messages when the avatar needs user input
 */
import type { ToolPromptProps } from './types';

// Import all tool prompt components
export { SecretPrompt } from './SecretPrompt';
export { ConfirmPrompt } from './ConfirmPrompt';
export { UploadPrompt } from './UploadPrompt';
export { ModelSelectorPrompt } from './ModelSelectorPrompt';
export { PropertyAuthPrompt } from './PropertyAuthPrompt';
export { TwitterConnectPrompt } from './TwitterConnectPrompt';
export { FeatureTogglePrompt } from './FeatureTogglePrompt';
export { IntegrationConfigPrompt } from './IntegrationConfigPrompt';
export { WalletLinkPrompt } from './WalletLinkPrompt';
export { ApiKeyManagementPrompt } from './ApiKeyManagementPrompt';

// Import for use in router
import { SecretPrompt } from './SecretPrompt';
import { ConfirmPrompt } from './ConfirmPrompt';
import { UploadPrompt } from './UploadPrompt';
import { ModelSelectorPrompt } from './ModelSelectorPrompt';
import { PropertyAuthPrompt } from './PropertyAuthPrompt';
import { TwitterConnectPrompt } from './TwitterConnectPrompt';
import { FeatureTogglePrompt } from './FeatureTogglePrompt';
import { IntegrationConfigPrompt } from './IntegrationConfigPrompt';
import { WalletLinkPrompt } from './WalletLinkPrompt';
import { ApiKeyManagementPrompt } from './ApiKeyManagementPrompt';

/**
 * Route tool calls to the appropriate prompt component
 */
export function ToolPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const normalizedToolCall = (() => {
    if (typeof toolCall.arguments === 'string') {
      try {
        return { ...toolCall, arguments: JSON.parse(toolCall.arguments) };
      } catch {
        return toolCall;
      }
    }
    return toolCall;
  })();

  // Check if this is an upload URL response (from get_profile_upload_url or get_reference_image_upload_url)
  const args = normalizedToolCall.arguments as Record<string, unknown>;
  const isUploadUrl = args?.type === 'upload_url' ||
    (args?.uploadUrl && args?.s3Key && args?.publicUrl);

  if (isUploadUrl) {
    return <UploadPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a model selector response
  if (args?.type === 'model_selector') {
    return <ModelSelectorPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a feature toggle response
  if (args?.type === 'feature_toggle') {
    return <FeatureTogglePrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a Twitter connect response
  if (args?.type === 'twitter_connect') {
    return <TwitterConnectPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  switch (toolCall.name) {
    case 'request_secret':
    case 'prompt_secret':
      return <SecretPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'confirm_action':
      return <ConfirmPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_property_research':
      return <PropertyAuthPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_feature_toggle':
      return <FeatureTogglePrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_twitter_connection':
    case 'twitter_request_integration':
      return <TwitterConnectPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'configure_integration':
      return <IntegrationConfigPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_wallet_link':
      return <WalletLinkPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'manage_api_keys':
      return <ApiKeyManagementPrompt toolCall={normalizedToolCall} onSubmit={onSubmit} disabled={disabled} />;
    default:
      // Unknown tool - show debug info
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4">
          <p className="text-[var(--color-text-tertiary)] text-sm">Unknown tool: {toolCall.name}</p>
          <pre className="mt-2 text-xs text-[var(--color-text-muted)] overflow-auto">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </pre>
        </div>
      );
  }
}
