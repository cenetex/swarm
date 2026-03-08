/**
 * GitHub API Client
 *
 * Shared read-only client for querying GitHub issues and releases.
 * Used by MCP tools (agent-facing) and potentially by issue-sync Lambda.
 *
 * Features:
 * - 5-minute in-memory response cache
 * - Rate limit header logging
 * - Configurable repo and token source
 */
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  htmlUrl: string;
  body: string | null;
}

export interface GitHubRelease {
  tagName: string;
  name: string | null;
  publishedAt: string;
  htmlUrl: string;
}

export interface GitHubIssueFilters {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  per_page?: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear all cached entries (for testing) */
export function clearGitHubCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GitHubClientConfig {
  token: string;
  repo: string; // "owner/repo"
}

async function githubFetch<T>(
  config: GitHubClientConfig,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(`https://api.github.com/repos/${config.repo}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const cacheKey = url.toString();
  const cached = getCached<T>(cacheKey);
  if (cached !== undefined) return cached;

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // Log rate limit info
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const limit = response.headers.get('X-RateLimit-Limit');
  if (remaining) {
    const remainingNum = parseInt(remaining, 10);
    const logLevel = remainingNum < 100 ? 'warn' : 'debug';
    logger[logLevel](`GitHub API rate limit: ${remaining}/${limit}`, {
      subsystem: 'github-client',
      event: 'rate_limit',
      remaining: remainingNum,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = await response.json() as T;
  setCache(cacheKey, data);
  return data;
}

// ---------------------------------------------------------------------------
// Raw GitHub API response types
// ---------------------------------------------------------------------------

interface GitHubIssueRaw {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string } | string>;
  assignee: { login: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  body: string | null;
}

interface GitHubReleaseRaw {
  tag_name: string;
  name: string | null;
  published_at: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function normalizeIssue(raw: GitHubIssueRaw): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state as 'open' | 'closed',
    labels: raw.labels.map(l => typeof l === 'string' ? l : l.name),
    assignee: raw.assignee?.login ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    htmlUrl: raw.html_url,
    body: raw.body,
  };
}

/**
 * Get a single issue by number.
 */
export async function getIssue(
  config: GitHubClientConfig,
  issueNumber: number,
): Promise<GitHubIssue> {
  const raw = await githubFetch<GitHubIssueRaw>(config, `/issues/${issueNumber}`);
  return normalizeIssue(raw);
}

/**
 * List issues with optional filters.
 */
export async function listIssues(
  config: GitHubClientConfig,
  filters: GitHubIssueFilters = {},
): Promise<GitHubIssue[]> {
  const query: Record<string, string> = {
    state: filters.state || 'open',
    per_page: String(filters.per_page || 20),
    sort: 'updated',
    direction: 'desc',
  };
  if (filters.labels && filters.labels.length > 0) {
    query.labels = filters.labels.join(',');
  }

  const raw = await githubFetch<GitHubIssueRaw[]>(config, '/issues', query);
  return raw.map(normalizeIssue);
}

/**
 * List issues reported by a specific avatar (via auto-issue label).
 */
export async function listAvatarIssues(
  config: GitHubClientConfig,
  avatarId: string,
  state: 'open' | 'closed' | 'all' = 'all',
): Promise<GitHubIssue[]> {
  return listIssues(config, {
    state,
    labels: [`auto-issue:avatar:${avatarId}`],
    per_page: 20,
  });
}

/**
 * Get recent releases (for deployment status enrichment).
 */
export async function getRecentReleases(
  config: GitHubClientConfig,
  perPage = 10,
): Promise<GitHubRelease[]> {
  const raw = await githubFetch<GitHubReleaseRaw[]>(
    config,
    '/releases',
    { per_page: String(perPage) },
  );
  return raw.map(r => ({
    tagName: r.tag_name,
    name: r.name,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
  }));
}

/**
 * Determine deployment status for a closed issue.
 * Returns null if open, "merged" if closed but no release after, or the release tag if deployed.
 */
export async function getDeploymentStatus(
  config: GitHubClientConfig,
  issue: GitHubIssue,
): Promise<{ status: 'open' | 'merged' | 'released'; releaseName?: string } > {
  if (issue.state === 'open') {
    return { status: 'open' };
  }

  if (!issue.closedAt) {
    return { status: 'merged' };
  }

  const closedAt = new Date(issue.closedAt).getTime();
  const releases = await getRecentReleases(config);

  // Find first release published after the issue was closed
  const deployedIn = releases.find(r => {
    const publishedAt = new Date(r.publishedAt).getTime();
    return publishedAt >= closedAt;
  });

  if (deployedIn) {
    return { status: 'released', releaseName: deployedIn.tagName };
  }

  return { status: 'merged' };
}
