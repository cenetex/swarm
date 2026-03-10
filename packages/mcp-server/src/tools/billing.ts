/**
 * Billing Tools
 *
 * MCP tools for Stripe-based billing: subscription checkout, customer portal,
 * billing status, and usage queries.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface BillingEntitlement {
  accountId: string;
  avatarId: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'cancelled' | 'trial';
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  trialEndsAt?: number;
  suspendedAt?: number;
  suspendedReason?: string;
  limits: {
    dailyMessageLimit: number;
    dailyMediaCredits: number;
    dailyVoiceMinutes: number;
    maxToolCallsPerMessage: number;
    maxPlatforms: number;
    maxChannels: number;
    memoryEnabled: boolean;
    memoryRetentionDays: number;
    autonomousPostsEnabled: boolean;
    customModelEnabled: boolean;
    priorityProcessing: boolean;
  };
}

export interface BillingUsage {
  avatarId: string;
  date: string;
  messagesProcessed: number;
  mediaCreditsUsed: number;
  voiceMinutesUsed: number;
  toolCallsMade: number;
  imageGenerations: number;
  videoGenerations: number;
  stickerGenerations: number;
}

export interface BillingServices {
  /** Create a Stripe Checkout session for subscribing to a plan */
  createCheckoutSession: (params: {
    accountId: string;
    avatarId: string;
    plan: 'pro' | 'enterprise';
    successUrl: string;
    cancelUrl: string;
    customerId?: string;
    customerEmail?: string;
  }) => Promise<{ checkoutUrl: string; sessionId: string }>;

  /** Create a Stripe Customer Portal session for managing billing */
  createPortalSession: (params: {
    customerId: string;
    returnUrl: string;
  }) => Promise<{ portalUrl: string }>;

  /** Get the current billing/entitlement status for an avatar */
  getBillingStatus: (avatarId: string) => Promise<BillingEntitlement | null>;

  /** Get today's usage for an avatar */
  getUsage: (avatarId: string, date?: string) => Promise<BillingUsage | null>;
}

// ============================================================================
// Plan metadata for display
// ============================================================================

const PLAN_INFO: Record<string, { name: string; price: string; description: string }> = {
  free: { name: 'Free', price: '$0/mo', description: 'Basic access with limited features' },
  pro: { name: 'Pro', price: '$9/mo', description: 'Full platform access with memory and autonomy' },
  enterprise: { name: 'Enterprise', price: '$29/mo', description: 'High-volume usage with priority processing' },
};

// ============================================================================
// Tool Definitions
// ============================================================================

export const createBillingTools = (services: BillingServices) => [
  // --------------------------------------------------------------------------
  // Subscribe — create a Stripe Checkout session
  // --------------------------------------------------------------------------
  defineTool({
    name: 'subscribe',
    description:
      'Create a checkout session for subscribing to a paid plan (Pro or Enterprise). ' +
      'Returns a Stripe Checkout URL the user should open to complete payment. ' +
      'Requires the avatar to have an associated account.',
    category: 'config',
    inputSchema: z.object({
      plan: z.enum(['pro', 'enterprise']).describe('The plan to subscribe to'),
      success_url: z.string().url().optional().describe('URL to redirect after successful checkout'),
      cancel_url: z.string().url().optional().describe('URL to redirect if checkout is cancelled'),
    }),
    platforms: ['admin-ui', 'api', 'mcp'],
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Check current status first
        const current = await services.getBillingStatus(context.avatarId);
        if (!current) {
          return {
            success: false,
            error: 'No billing account found for this avatar. Please set up an account first.',
          };
        }

        // Already on the requested plan?
        if (current.plan === input.plan && current.status === 'active') {
          return {
            success: true,
            data: {
              message: `Already on the ${PLAN_INFO[input.plan].name} plan.`,
              currentPlan: current.plan,
              status: current.status,
            },
          };
        }

        // If already subscribed via Stripe, direct to portal for plan changes
        if (current.stripeCustomerId && current.plan !== 'free') {
          const portal = await services.createPortalSession({
            customerId: current.stripeCustomerId,
            returnUrl: input.success_url || 'https://swarm.rati.chat/billing',
          });
          return {
            success: true,
            data: {
              message: `You already have an active subscription. Use the billing portal to change plans.`,
              portalUrl: portal.portalUrl,
              currentPlan: current.plan,
            },
          };
        }

        const defaultBaseUrl = 'https://swarm.rati.chat';
        const result = await services.createCheckoutSession({
          accountId: current.accountId,
          avatarId: context.avatarId,
          plan: input.plan,
          successUrl: input.success_url || `${defaultBaseUrl}/billing?success=true`,
          cancelUrl: input.cancel_url || `${defaultBaseUrl}/billing?cancelled=true`,
          customerId: current.stripeCustomerId,
        });

        return {
          success: true,
          data: {
            message: `Checkout session created for ${PLAN_INFO[input.plan].name} (${PLAN_INFO[input.plan].price}). Open the URL to complete payment.`,
            checkoutUrl: result.checkoutUrl,
            sessionId: result.sessionId,
            plan: input.plan,
            price: PLAN_INFO[input.plan].price,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to create checkout session: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),

  // --------------------------------------------------------------------------
  // Manage Billing — open Stripe Customer Portal
  // --------------------------------------------------------------------------
  defineTool({
    name: 'manage_billing',
    description:
      'Open the Stripe Customer Portal where the user can manage their subscription, ' +
      'update payment methods, view invoices, or cancel. Returns a portal URL.',
    category: 'config',
    inputSchema: z.object({
      return_url: z.string().url().optional().describe('URL to return to after portal session'),
    }),
    platforms: ['admin-ui', 'api', 'mcp'],
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const entitlement = await services.getBillingStatus(context.avatarId);
        if (!entitlement) {
          return {
            success: false,
            error: 'No billing record found for this avatar.',
          };
        }

        if (!entitlement.stripeCustomerId) {
          return {
            success: false,
            error: 'No Stripe customer associated with this avatar. Subscribe to a plan first.',
          };
        }

        const portal = await services.createPortalSession({
          customerId: entitlement.stripeCustomerId,
          returnUrl: input.return_url || 'https://swarm.rati.chat/billing',
        });

        return {
          success: true,
          data: {
            message: 'Billing portal session created. Open the URL to manage your subscription.',
            portalUrl: portal.portalUrl,
            currentPlan: entitlement.plan,
            status: entitlement.status,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to create portal session: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),

  // --------------------------------------------------------------------------
  // Billing Status — show current subscription info
  // --------------------------------------------------------------------------
  defineTool({
    name: 'billing_status',
    description:
      'Get the current billing status for this avatar, including plan, subscription state, ' +
      'feature limits, and plan details. Use this to check what plan the avatar is on.',
    category: 'readonly',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const entitlement = await services.getBillingStatus(context.avatarId);

        if (!entitlement) {
          const info = PLAN_INFO.free;
          return {
            success: true,
            data: {
              plan: 'free',
              planName: info.name,
              price: info.price,
              description: info.description,
              status: 'active',
              message: 'No paid subscription. Running on the Free tier.',
              limits: {
                dailyMessages: 50,
                dailyMediaCredits: 5,
                dailyVoiceMinutes: 2,
                maxToolCallsPerMessage: 3,
                maxPlatforms: 1,
                maxChannels: 2,
                memoryEnabled: false,
                autonomousPostsEnabled: false,
              },
              upgradePlans: [
                { plan: 'pro', ...PLAN_INFO.pro },
                { plan: 'enterprise', ...PLAN_INFO.enterprise },
              ],
            },
          };
        }

        const info = PLAN_INFO[entitlement.plan] || PLAN_INFO.free;
        const l = entitlement.limits;

        return {
          success: true,
          data: {
            plan: entitlement.plan,
            planName: info.name,
            price: info.price,
            description: info.description,
            status: entitlement.status,
            ...(entitlement.trialEndsAt && {
              trialEndsAt: new Date(entitlement.trialEndsAt).toISOString(),
            }),
            ...(entitlement.suspendedReason && {
              suspendedReason: entitlement.suspendedReason,
            }),
            hasStripeSubscription: !!entitlement.stripeSubscriptionId,
            limits: {
              dailyMessages: l.dailyMessageLimit === -1 ? 'unlimited' : l.dailyMessageLimit,
              dailyMediaCredits: l.dailyMediaCredits === -1 ? 'unlimited' : l.dailyMediaCredits,
              dailyVoiceMinutes: l.dailyVoiceMinutes === -1 ? 'unlimited' : l.dailyVoiceMinutes,
              maxToolCallsPerMessage: l.maxToolCallsPerMessage,
              maxPlatforms: l.maxPlatforms === -1 ? 'unlimited' : l.maxPlatforms,
              maxChannels: l.maxChannels === -1 ? 'unlimited' : l.maxChannels,
              memoryEnabled: l.memoryEnabled,
              memoryRetentionDays: l.memoryRetentionDays,
              autonomousPostsEnabled: l.autonomousPostsEnabled,
              customModelEnabled: l.customModelEnabled,
              priorityProcessing: l.priorityProcessing,
            },
            ...(entitlement.plan === 'free' && {
              upgradePlans: [
                { plan: 'pro', ...PLAN_INFO.pro },
                { plan: 'enterprise', ...PLAN_INFO.enterprise },
              ],
            }),
            ...(entitlement.plan === 'pro' && {
              upgradePlans: [{ plan: 'enterprise', ...PLAN_INFO.enterprise }],
            }),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to fetch billing status: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),

  // --------------------------------------------------------------------------
  // Check Usage — show daily usage vs limits
  // --------------------------------------------------------------------------
  defineTool({
    name: 'check_usage',
    description:
      'Check daily usage for this avatar including messages, media credits, voice minutes, ' +
      'and tool calls. Shows current consumption vs plan limits with remaining allowances.',
    category: 'readonly',
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Date to check (YYYY-MM-DD). Defaults to today.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const entitlement = await services.getBillingStatus(context.avatarId);
        const limits = entitlement?.limits || {
          dailyMessageLimit: 50,
          dailyMediaCredits: 5,
          dailyVoiceMinutes: 2,
          maxToolCallsPerMessage: 3,
          maxPlatforms: 1,
          maxChannels: 2,
          memoryEnabled: false,
          memoryRetentionDays: 0,
          autonomousPostsEnabled: false,
          customModelEnabled: false,
          priorityProcessing: false,
        };
        const plan = entitlement?.plan || 'free';
        const usage = await services.getUsage(context.avatarId, input.date);

        const today = input.date || new Date().toISOString().split('T')[0];
        const msgs = usage?.messagesProcessed || 0;
        const mediaCr = usage?.mediaCreditsUsed || 0;
        const voiceMins = usage?.voiceMinutesUsed || 0;
        const toolCalls = usage?.toolCallsMade || 0;

        const fmt = (used: number, limit: number) => {
          if (limit === -1) return { used, limit: 'unlimited', remaining: 'unlimited' };
          return { used, limit, remaining: Math.max(0, limit - used) };
        };

        return {
          success: true,
          data: {
            avatarId: context.avatarId,
            date: today,
            plan,
            planName: PLAN_INFO[plan]?.name || plan,
            messages: fmt(msgs, limits.dailyMessageLimit),
            mediaCredits: fmt(mediaCr, limits.dailyMediaCredits),
            voiceMinutes: fmt(voiceMins, limits.dailyVoiceMinutes),
            toolCalls: { used: toolCalls, perMessage: limits.maxToolCallsPerMessage },
            breakdown: {
              imageGenerations: usage?.imageGenerations || 0,
              videoGenerations: usage?.videoGenerations || 0,
              stickerGenerations: usage?.stickerGenerations || 0,
            },
          },
        };
      } catch (err) {
        // Note: err.message may contain raw AWS ARNs/account IDs.
        // sanitizeToolError() in chat-tool-helpers.ts strips these before user display.
        return {
          success: false,
          error: `Failed to fetch usage: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),
];
