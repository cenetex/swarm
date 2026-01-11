/**
 * Diagnostics Tools
 * 
 * Tools for agents to report issues and help debug problems.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

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
// Tool Definitions
// ============================================================================

export const createDiagnosticsTools = () => [
  defineTool({
    name: 'report_issue',
    description: `Report a technical issue or bug you've detected. Use this when:
- Something didn't work as expected (image not showing, tool failed, etc.)
- You notice symptoms the user described that indicate a bug
- There's a UI glitch or missing data
- A user is experiencing repeated problems
This helps developers debug and fix issues faster.`,
    category: 'diagnostics',
    platforms: ['admin-ui', 'telegram', 'api'],
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
      // Log the issue in a structured format that can be queried
      console.log(JSON.stringify({
        level: input.severity === 'critical' ? 'ERROR' : input.severity === 'high' ? 'WARN' : 'INFO',
        subsystem: 'diagnostics',
        event: 'agent_reported_issue',
        agentId: context.agentId,
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

      return {
        success: true,
        data: {
          message: 'Issue reported successfully. The development team will investigate.',
          issueId: `issue-${Date.now()}`,
          category: input.category,
          severity: input.severity,
        },
      };
    },
  }),

  defineTool({
    name: 'report_user_feedback',
    description: 'Log positive or negative user feedback about a feature or interaction.',
    category: 'diagnostics',
    platforms: ['admin-ui', 'telegram', 'api'],
    inputSchema: z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Overall sentiment'),
      feature: z.string().describe('Which feature the feedback is about (e.g., "image_generation", "profile_upload", "chat")'),
      feedback: z.string().max(500).describe('The feedback or observation'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'diagnostics',
        event: 'agent_reported_feedback',
        agentId: context.agentId,
        platform: context.platform,
        feedback: {
          sentiment: input.sentiment,
          feature: input.feature,
          content: input.feedback,
        },
        timestamp: new Date().toISOString(),
      }));

      return {
        success: true,
        data: {
          message: 'Feedback logged. Thanks for helping improve the system!',
        },
      };
    },
  }),
];

export default createDiagnosticsTools;
