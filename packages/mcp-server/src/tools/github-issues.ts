/**
 * GitHub Issue Tracking Tools
 *
 * Read-only tool for agents to see issues they've reported
 * and check deployment status.
 */
import { z } from 'zod';
import { defineReadonlyTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface GitHubIssueServices {
  /** List issues auto-reported by a specific avatar */
  getMyIssues: (avatarId: string, state: 'open' | 'closed' | 'all') => Promise<Array<{
    number: number;
    title: string;
    state: 'open' | 'closed';
    labels: string[];
    assignee: string | null;
    updatedAt: string;
    closedAt: string | null;
    deployedIn: string | null;
    url: string;
  }>>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createGitHubIssueTools = (services: GitHubIssueServices) => [
  defineReadonlyTool({
    name: 'get_my_issues',
    description: `List GitHub issues that were automatically reported by you. Shows your open/closed bugs with deployment status — whether the fix has been released. Use this to check if problems you reported have been fixed.`,
    toolset: 'github',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).default('all').describe('Filter by issue state'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const issues = await services.getMyIssues(context.avatarId, input.state);
        return {
          success: true,
          data: {
            count: issues.length,
            issues,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch your reported issues',
        };
      }
    },
  }),
];

export default createGitHubIssueTools;
