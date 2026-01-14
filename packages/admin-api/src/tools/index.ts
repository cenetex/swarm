/**
 * Admin Tools Index
 *
 * This module exports utilities for identifying manual/pause tools.
 * Tool definitions have been migrated to @swarm/mcp-server.
 *
 * @deprecated Individual tool definitions - use @swarm/mcp-server registry instead
 */

/**
 * List of tool names that require user interaction (manual tools)
 * These should NOT be auto-executed - they return UI payloads
 */
export const MANUAL_TOOL_NAMES = [
  'request_secret',
  'request_model_selection',
  'request_feature_toggle',
  'request_twitter_connection',
  'request_property_research',
] as const;

/**
 * List of tool names that return upload widgets
 * These pause the conversation for file upload
 */
export const UPLOAD_TOOL_NAMES = [
  'get_profile_upload_url',
  'get_reference_image_upload_url',
  'get_character_reference_upload_url',
] as const;

/**
 * Check if a tool call should pause for user input
 *
 * @param toolName - The name of the tool being called
 * @param args - Optional arguments passed to the tool
 * @returns true if the tool requires user input before continuing
 */
export function isPauseForInputTool(toolName: string, args?: Record<string, unknown>): boolean {
  if (MANUAL_TOOL_NAMES.includes(toolName as typeof MANUAL_TOOL_NAMES[number])) {
    return true;
  }
  if (toolName === 'set_profile_image' && args?.source === 'upload') {
    return true;
  }
  if (toolName === 'set_character_reference' && args?.source === 'upload') {
    return true;
  }
  if (UPLOAD_TOOL_NAMES.includes(toolName as typeof UPLOAD_TOOL_NAMES[number])) {
    return true;
  }
  return false;
}
