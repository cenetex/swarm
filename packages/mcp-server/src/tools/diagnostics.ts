/**
 * Diagnostics Tools
 * 
 * Tools for avatars to report issues and help debug problems.
 * 
 * These tools write to CloudWatch logs (always) and optionally to
 * DynamoDB via an injected service (for fast queries in the admin UI).
 */
import { z } from 'zod';
import { defineTool, withTaskAction, type ToolResult } from '../registry.js';

// ============================================================================
// Schemas
// ============================================================================

const IssueSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
const IssueCategorySchema = z.enum([
  'ui_glitch',           // Visual/display issues
  'missing_data',        // Expected data not present
  'timing_issue',        // Race conditions, delays
  'tool_failure',        // Tool didn't work as expected
  'user_experience',     // UX problems
  'unexpected_behavior', // Something weird happened
  'performance',         // Slow responses
  'other',
]);

export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

// ============================================================================
// Service Interface (optional, for DynamoDB persistence)
// ============================================================================

export interface DiagnosticsServices {
  recordIssue?: (params: {
    avatarId: string;
    platform: string;
    severity: IssueSeverity;
    category: IssueCategory;
    title: string;
    description: string;
    userMessage?: string;
    context?: {
      toolName?: string;
      expectedBehavior?: string;
      actualBehavior?: string;
      reproSteps?: string[];
    };
  }) => Promise<{ id: string }>;

  recordFeedback?: (params: {
    avatarId: string;
    platform: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    feature: string;
    feedback: string;
  }) => Promise<{ id: string }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createDiagnosticsTools = (services?: DiagnosticsServices) => [
  defineTool({
    name: 'report_issue',
    description: `Report a technical issue or bug you've detected. Use this when:
- Something didn't work as expected (image not showing, tool failed, etc.)
- You notice symptoms the user described that indicate a bug
- There's a UI glitch or missing data
- A user is experiencing repeated problems
This helps developers debug and fix issues faster.`,
    category: 'diagnostics',
    platforms: ['admin-ui', 'telegram', 'api', 'mcp'],
    inputSchema: z.object({
      category: IssueCategorySchema.describe('The type of issue'),
      severity: IssueSeveritySchema.describe('How severe is the issue (low=minor annoyance, critical=blocking functionality)'),
      title: z.string().max(100).describe('Brief title describing the issue'),
      description: z.string().max(1000).describe('Detailed description of what went wrong, including any error messages or symptoms'),
      userMessage: z.string().optional().describe('The user message that triggered or revealed this issue'),
      context: z.object({
        toolName: z.string().optional().describe('If a tool failed, which tool'),
        expectedBehavior: z.string().optional().describe('What should have happened'),
        actualBehavior: z.string().optional().describe('What actually happened'),
        reproSteps: z.array(z.string()).optional().describe('Steps to reproduce'),
      }).optional().describe('Additional context about the issue'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const now = Date.now();
      let issueId = `issue-${now}`;

      // Always log to CloudWatch for audit trail
      console.log(JSON.stringify({
        level: input.severity === 'critical' ? 'ERROR' : input.severity === 'high' ? 'WARN' : 'INFO',
        subsystem: 'diagnostics',
        event: 'avatar_reported_issue',
        avatarId: context.avatarId,
        platform: context.platform,
        issue: {
          category: input.category,
          severity: input.severity,
          title: input.title,
          description: input.description,
          userMessage: input.userMessage,
          context: input.context,
        },
        timestamp: new Date().toISOString(),
      }));

      // Persist to DynamoDB if service is available
      if (services?.recordIssue) {
        try {
          const result = await services.recordIssue({
            avatarId: context.avatarId,
            platform: context.platform,
            severity: input.severity,
            category: input.category,
            title: input.title,
            description: input.description,
            userMessage: input.userMessage,
            context: input.context,
          });
          issueId = result.id;
        } catch (err) {
          console.error('[diagnostics] Failed to persist issue:', err);
        }
      }

      return withTaskAction(
        {
          success: true,
          data: {
            message: 'Issue reported successfully. The development team will investigate.',
            issueId,
            category: input.category,
            severity: input.severity,
          },
        },
        {
          task: {
            type: 'diagnostics',
            title: `Issue: ${input.title}`,
            summary: `${input.severity} ${input.category} issue reported`,
            props: {
              issueId,
              category: input.category,
              severity: input.severity,
              description: input.description,
            },
          },
          workspace: {
            focus: input.severity === 'critical' || input.severity === 'high',
          },
        },
      );
    },
  }),

  defineTool({
    name: 'report_user_feedback',
    description: 'Log positive or negative user feedback about a feature or interaction.',
    category: 'diagnostics',
    platforms: ['admin-ui', 'telegram', 'api', 'mcp'],
    inputSchema: z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Overall sentiment'),
      feature: z.string().describe('Which feature the feedback is about (e.g., "image_generation", "profile_upload", "chat")'),
      feedback: z.string().max(500).describe('The feedback or observation'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const now = Date.now();
      let feedbackId = `feedback-${now}`;

      // Always log to CloudWatch
      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'diagnostics',
        event: 'avatar_reported_feedback',
        avatarId: context.avatarId,
        platform: context.platform,
        feedback: {
          sentiment: input.sentiment,
          feature: input.feature,
          content: input.feedback,
        },
        timestamp: new Date().toISOString(),
      }));

      // Persist to DynamoDB if service is available
      if (services?.recordFeedback) {
        try {
          const result = await services.recordFeedback({
            avatarId: context.avatarId,
            platform: context.platform,
            sentiment: input.sentiment,
            feature: input.feature,
            feedback: input.feedback,
          });
          feedbackId = result.id;
        } catch (err) {
          console.error('[diagnostics] Failed to persist feedback:', err);
        }
      }

      return {
        success: true,
        data: {
          message: 'Feedback logged. Thanks for helping improve the system!',
          feedbackId,
        },
      };
    },
  }),
];

export default createDiagnosticsTools;
