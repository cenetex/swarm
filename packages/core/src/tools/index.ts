/**
 * Shared Tool Definitions and Executors
 * These tools are available to agents on all platforms (Telegram, Twitter, web, etc.)
 * Admin-only tools are defined separately in the admin-api package.
 */
import { z } from 'zod';
import type { ToolDefinition } from '../types/index.js';

/**
 * Standard response tools - basic actions an agent can take
 */
export const responseTools: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a text message response to the user',
    parameters: z.object({
      text: z.string().describe('The message text to send'),
      reply_to: z.string().optional().describe('Message ID to reply to'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'react',
    description: 'React to a message with an emoji',
    parameters: z.object({
      emoji: z.string().describe('The emoji to react with'),
      message_id: z.string().describe('The message ID to react to'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'wait',
    description: 'Wait before responding to simulate thinking or build suspense',
    parameters: z.object({
      seconds: z.number().describe('Number of seconds to wait'),
      reason: z.string().optional().describe('Reason for waiting'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'ignore',
    description: 'Choose not to respond to this message',
    parameters: z.object({
      reason: z.string().describe('Reason for not responding'),
    }),
    execute: async () => ({ success: true }),
  },
];

/**
 * Media generation tools - image/video/sticker generation
 */
export const mediaTools: ToolDefinition[] = [
  {
    name: 'take_selfie',
    description: 'Generate a selfie image of yourself. Describe the scene, pose, and mood.',
    parameters: z.object({
      prompt: z.string().describe('Description of the selfie - include your appearance, pose, setting, and mood'),
      style: z.string().optional().describe('Art style (e.g., "anime", "realistic", "cartoon", "watercolor")'),
    }),
    execute: async () => ({ success: true }), // Executed by platform handler
  },
  {
    name: 'generate_image',
    description: 'Generate an image from a text description',
    parameters: z.object({
      prompt: z.string().describe('Detailed description of the image to generate'),
      style: z.string().optional().describe('Art style (e.g., "anime", "realistic", "3d render")'),
    }),
    execute: async () => ({ success: true }), // Executed by platform handler
  },
  {
    name: 'send_sticker',
    description: 'Send a sticker or animated emoji that matches the mood',
    parameters: z.object({
      emoji: z.string().describe('The emoji that best represents the sticker mood'),
      description: z.string().optional().describe('What the sticker should show'),
    }),
    execute: async () => ({ success: true }),
  },
];

/**
 * Wallet/crypto tools - read-only wallet info
 */
export const walletTools: ToolDefinition[] = [
  {
    name: 'get_my_wallet',
    description: 'Get your Solana wallet address to share with users',
    parameters: z.object({}),
    execute: async () => ({ success: true }), // Executed by platform handler
  },
  {
    name: 'check_wallet_balance',
    description: 'Check the SOL balance in your wallet',
    parameters: z.object({}),
    execute: async () => ({ success: true }), // Executed by platform handler
  },
];

/**
 * Social/engagement tools
 */
export const socialTools: ToolDefinition[] = [
  {
    name: 'remember',
    description: 'Save an important fact about the user or conversation to remember later',
    parameters: z.object({
      fact: z.string().describe('The fact to remember'),
      about: z.string().optional().describe('Who/what this fact is about'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'recall',
    description: 'Try to recall saved facts about a user or topic',
    parameters: z.object({
      query: z.string().describe('What to recall (e.g., username or topic)'),
    }),
    execute: async () => ({ success: true }),
  },
];

/**
 * All public tools available to agents
 */
export const publicTools: ToolDefinition[] = [
  ...responseTools,
  ...mediaTools,
  ...walletTools,
  ...socialTools,
];

/**
 * Get tools by name
 */
export function getToolsByNames(names: string[]): ToolDefinition[] {
  return publicTools.filter(t => names.includes(t.name));
}

/**
 * Tool categories for easy reference
 */
export const toolCategories = {
  response: responseTools.map(t => t.name),
  media: mediaTools.map(t => t.name),
  wallet: walletTools.map(t => t.name),
  social: socialTools.map(t => t.name),
} as const;

/**
 * Default tool set for new agents
 */
export const defaultAgentTools = [
  // Response tools
  'send_message',
  'react',
  'wait',
  'ignore',
  // Media tools
  'take_selfie',
  'generate_image',
  'send_sticker',
  // Wallet tools
  'get_my_wallet',
  'check_wallet_balance',
  // Social tools
  'remember',
  'recall',
];
