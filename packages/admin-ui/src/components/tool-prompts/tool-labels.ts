/**
 * Human-readable labels for tool calls. Shared between the inline TaskCard
 * and the workspace pending-list / auto-open hook.
 */
import type { TaskCard } from '../../store/task-cards';

const TOOL_LABELS: Record<string, string> = {
  request_secret: 'Secret Input',
  prompt_secret: 'Secret Input',
  confirm_action: 'Confirmation',
  request_wallet_link: 'Wallet Link',
  request_twitter_connection: 'Twitter Connect',
  twitter_request_integration: 'Twitter Connect',
  request_feature_toggle: 'Feature Toggle',
  request_property_research: 'Property Auth',
  configure_integration: 'Integration Setup',
  set_profile_image: 'Profile Upload',
  get_profile_upload_url: 'Image Upload',
  get_reference_image_upload_url: 'Reference Upload',
  set_character_reference: 'Character Reference',
  get_my_gallery: 'Media Gallery',
  search_gallery: 'Gallery Search',
  get_my_wallets: 'Wallet Overview',
  report_issue: 'Issue Report',
  report_user_feedback: 'User Feedback',
};

export function getToolLabel(card: Pick<TaskCard, 'toolName' | 'arguments'>): string {
  const args = card.arguments;
  if (args?.type === 'model_selector') return 'Model Selection';
  if (args?.type === 'feature_toggle') return 'Feature Toggle';
  if (args?.type === 'upload_url') return 'File Upload';
  if (args?.type === 'twitter_connect') return 'Twitter Connect';
  return TOOL_LABELS[card.toolName] || 'Action Required';
}

/**
 * Tool calls that are small enough to render inline in the chat transcript
 * without auto-opening the workspace. Anything not in this set defaults to
 * workspace-first rendering (#1637).
 */
export const INLINE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'confirm_action',
]);

export function isInlineOnly(toolName: string): boolean {
  return INLINE_ONLY_TOOLS.has(toolName);
}
