/**
 * GitHub Issue Tracking Tools
 *
 * Read-only tools for agents to query GitHub issues they've reported,
 * check issue status, and see deployment progress.
 */
import { z } from 'zod';
import { defineReadonlyTool, type ToolResult } from '../registry.js';
import type {
  GitHubIssue,
  GitHubIssueFilters,
} from '@swarm/core';

// ============================================================================
// Service Interface
// ============================================================================

export interface GitHubIssueServices {
  getIssue: (issueNumber: number) => Promise<GitHubIssue>;
  listIssues: (filters?: GitHubIssueFilters) => Promise<GitHubIssue[]>;
  listAvatarIssues: (avatarId: string, state?: 'open' | 'closed' | 'all') => Promise<GitHubIssue[]>;
  getDeploymentStatus: (issue: GitHubIssue) => Promise<{ status: 'open' | 'merged' | 'released'; releaseName?: string }>;
}

// ============================================================================
// Helpers
// ============================================================================

function formatIssueForAgent(issue: GitHubIssue, deployment?: { status: string; releaseName?: string }) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    assignee: issue.assignee,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    deployedTo: deployment?.status === 'released'
      ? deployment.releaseName
      : deployment?.status ?? null,
    url: issue.htmlUrl,
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createGitHubIssueTools = (services: GitHubIssueServices) => [
  defineReadonlyTool({
    name: 'get_github_issue',
    description: `Look up a GitHub issue by number. Returns status, labels, assignee, and whether the fix has been deployed. Use this to check on a specific issue you reported or were told about.`,
    toolset: 'github',
    inputSchema: z.object({
      issue_number: z.number().int().positive().describe('The GitHub issue number (e.g., 42)'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const issue = await services.getIssue(input.issue_number);
        const deployment = await services.getDeploymentStatus(issue);
        return {
          success: true,
          data: formatIssueForAgent(issue, deployment),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issue',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'list_github_issues',
    description: `List GitHub issues with optional filters. Use this to see open bugs, check what's being worked on, or find issues by label.`,
    toolset: 'github',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).default('open').describe('Filter by issue state'),
      labels: z.array(z.string()).optional().describe('Filter by labels (e.g., ["type:bug", "priority:high"])'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const issues = await services.listIssues({
          state: input.state,
          labels: input.labels,
          per_page: 20,
        });
        return {
          success: true,
          data: {
            count: issues.length,
            issues: issues.map(issue => formatIssueForAgent(issue)),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list issues',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_my_reported_issues',
    description: `List GitHub issues that were automatically reported by you (this avatar). Shows open and closed issues with deployment status. Use this to check if bugs you reported have been fixed and deployed.`,
    toolset: 'github',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).default('all').describe('Filter by issue state'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const issues = await services.listAvatarIssues(context.avatarId, input.state);

        // Enrich closed issues with deployment status
        const enriched = await Promise.all(
          issues.map(async (issue) => {
            if (issue.state === 'closed') {
              const deployment = await services.getDeploymentStatus(issue);
              return formatIssueForAgent(issue, deployment);
            }
            return formatIssueForAgent(issue);
          })
        );

        return {
          success: true,
          data: {
            count: enriched.length,
            issues: enriched,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list your reported issues',
        };
      }
    },
  }),
];

export default createGitHubIssueTools;
