/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Moltbook Service
 * 
 * Client for interacting with Moltbook - the social network for AI agents.
 * API Docs: https://www.moltbook.com/skill.md
 * 
 * Rate Limits:
 * - 100 requests/minute
 * - 1 post per 30 minutes
 * - 50 comments/hour
 */

import type {
  MoltbookServices,
  MoltbookConnectionStatus,
  MoltbookAgent,
  MoltbookPost,
  MoltbookComment,
  MoltbookSubmolt,
  MoltbookSearchResult,
} from '@swarm/mcp-server';
import * as secrets from './secrets.js';
import type { UserSession } from '../types.js';

const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';
const API_TIMEOUT_MS = 15_000;

type MoltbookRegisterResponse = {
  agent: {
    api_key: string;
    claim_url: string;
    verification_code: string;
  };
  important?: string;
};

/**
 * Make an authenticated request to the Moltbook API
 */
async function moltbookFetch<T>(
  endpoint: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${MOLTBOOK_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Moltbook API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an unauthenticated request to the Moltbook API.
 * Used for registration.
 */
async function moltbookFetchUnauthed<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${MOLTBOOK_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Moltbook API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create Moltbook services for an avatar
 */
export function createMoltbookServices(avatarId: string, session: UserSession): MoltbookServices {
  // Helper to get API key
  const getApiKey = async (): Promise<string | null> => {
    try {
      const apiKey = await secrets._getSecretValueInternal(avatarId, 'moltbook_api_key', 'default');
      return apiKey;
    } catch {
      return null;
    }
  };

  return {
    getConnectionStatus: async (): Promise<MoltbookConnectionStatus> => {
      const apiKey = await getApiKey();

      if (!apiKey) {
        return {
          connected: false,
          status: 'unclaimed',
        };
      }

      try {
        // Get the current agent profile
        const profile = await moltbookFetch<{
          name: string;
          karma: number;
          follower_count: number;
          following_count: number;
          is_claimed: boolean;
          claim_url?: string;
        }>('/me', apiKey);

        return {
          connected: profile.is_claimed,
          status: profile.is_claimed ? 'claimed' : 'pending_claim',
          agentName: profile.name,
          claimUrl: profile.claim_url,
          karma: profile.karma,
          followerCount: profile.follower_count,
          followingCount: profile.following_count,
        };
      } catch (error) {
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'moltbook',
          event: 'moltbook_status_error',
          avatarId,
          error: error instanceof Error ? error.message : String(error),
        }));
        return {
          connected: false,
          status: 'unclaimed',
        };
      }
    },

    register: async (name: string, description: string) => {
      const existingApiKey = await getApiKey();
      if (existingApiKey) {
        throw new Error('Already registered on Moltbook (API key already stored)');
      }

      const response = await moltbookFetchUnauthed<MoltbookRegisterResponse>('/agents/register', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      });

      if (!response?.agent?.api_key || !response.agent.claim_url || !response.agent.verification_code) {
        throw new Error('Unexpected Moltbook registration response');
      }

      await secrets.storeSecret(
        avatarId,
        'moltbook_api_key',
        'default',
        response.agent.api_key,
        session,
        `Moltbook API key for ${avatarId}`
      );

      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'moltbook',
        event: 'moltbook_registered',
        avatarId,
        agentName: name,
      }));

      return {
        apiKey: response.agent.api_key,
        claimUrl: response.agent.claim_url,
        verificationCode: response.agent.verification_code,
      };
    },

    getProfile: async (): Promise<MoltbookAgent> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const profile = await moltbookFetch<{
        name: string;
        description?: string;
        karma: number;
        follower_count: number;
        following_count: number;
        is_claimed: boolean;
        is_active: boolean;
        created_at: string;
        last_active?: string;
        avatar_url?: string;
      }>('/me', apiKey);

      return {
        name: profile.name,
        description: profile.description,
        karma: profile.karma,
        followerCount: profile.follower_count,
        followingCount: profile.following_count,
        isClaimed: profile.is_claimed,
        isActive: profile.is_active,
        createdAt: profile.created_at,
        lastActive: profile.last_active,
        avatarUrl: profile.avatar_url,
      };
    },

    updateProfile: async (description: string): Promise<void> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      await moltbookFetch('/me', apiKey, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      });
    },

    createPost: async (submolt: string, title: string, content?: string, url?: string): Promise<MoltbookPost> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const body: Record<string, string> = { title };
      if (content) body.body = content;
      if (url) body.url = url;

      const response = await moltbookFetch<{
        id: string;
        title: string;
        body?: string;
        url?: string;
        upvotes: number;
        downvotes: number;
        comment_count: number;
        created_at: string;
        author: { name: string };
        submolt: { name: string; display_name: string };
      }>(`/submolts/${encodeURIComponent(submolt)}/posts`, apiKey, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'moltbook',
        event: 'moltbook_post_created',
        avatarId,
        postId: response.id,
        submolt,
      }));

      return {
        id: response.id,
        title: response.title,
        content: response.body,
        url: response.url,
        upvotes: response.upvotes,
        downvotes: response.downvotes,
        commentCount: response.comment_count,
        createdAt: response.created_at,
        author: response.author,
        submolt: { name: response.submolt.name, displayName: response.submolt.display_name },
      };
    },

    getFeed: async (options = {}): Promise<MoltbookPost[]> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const params = new URLSearchParams();
      if (options.sort) params.set('sort', options.sort);
      if (options.limit) params.set('limit', options.limit.toString());

      let endpoint = '/feed';
      if (options.submolt) {
        endpoint = `/submolts/${encodeURIComponent(options.submolt)}/posts`;
      } else if (options.personalized) {
        endpoint = '/feed/personalized';
      }

      const query = params.toString();
      const fullEndpoint = query ? `${endpoint}?${query}` : endpoint;

      const response = await moltbookFetch<{
        posts: Array<{
          id: string;
          title: string;
          body?: string;
          url?: string;
          upvotes: number;
          downvotes: number;
          comment_count: number;
          created_at: string;
          author: { name: string };
          submolt: { name: string; display_name: string };
        }>;
      }>(fullEndpoint, apiKey);

      return response.posts.map(post => ({
        id: post.id,
        title: post.title,
        content: post.body,
        url: post.url,
        upvotes: post.upvotes,
        downvotes: post.downvotes,
        commentCount: post.comment_count,
        createdAt: post.created_at,
        author: post.author,
        submolt: { name: post.submolt.name, displayName: post.submolt.display_name },
      }));
    },

    getPost: async (postId: string): Promise<MoltbookPost & { comments: MoltbookComment[] }> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const response = await moltbookFetch<{
        id: string;
        title: string;
        body?: string;
        url?: string;
        upvotes: number;
        downvotes: number;
        comment_count: number;
        created_at: string;
        author: { name: string };
        submolt: { name: string; display_name: string };
        comments: Array<{
          id: string;
          body: string;
          upvotes: number;
          downvotes: number;
          created_at: string;
          author: { name: string };
          parent_id?: string;
        }>;
      }>(`/posts/${postId}`, apiKey);

      return {
        id: response.id,
        title: response.title,
        content: response.body,
        url: response.url,
        upvotes: response.upvotes,
        downvotes: response.downvotes,
        commentCount: response.comment_count,
        createdAt: response.created_at,
        author: response.author,
        submolt: { name: response.submolt.name, displayName: response.submolt.display_name },
        comments: response.comments.map(c => ({
          id: c.id,
          content: c.body,
          upvotes: c.upvotes,
          downvotes: c.downvotes,
          createdAt: c.created_at,
          author: c.author,
          parentId: c.parent_id,
        })),
      };
    },

    addComment: async (postId: string, content: string, parentId?: string): Promise<MoltbookComment> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const body: Record<string, string> = { body: content };
      if (parentId) body.parent_id = parentId;

      const response = await moltbookFetch<{
        id: string;
        body: string;
        upvotes: number;
        downvotes: number;
        created_at: string;
        author: { name: string };
        parent_id?: string;
      }>(`/posts/${postId}/comments`, apiKey, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'moltbook',
        event: 'moltbook_comment_created',
        avatarId,
        postId,
        commentId: response.id,
      }));

      return {
        id: response.id,
        content: response.body,
        upvotes: response.upvotes,
        downvotes: response.downvotes,
        createdAt: response.created_at,
        author: response.author,
        parentId: response.parent_id,
      };
    },

    upvotePost: async (postId: string): Promise<{ success: boolean; suggestion?: string }> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const response = await moltbookFetch<{
        success: boolean;
        suggestion?: string;
      }>(`/posts/${postId}/vote`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ direction: 1 }),
      });

      return response;
    },

    downvotePost: async (postId: string): Promise<{ success: boolean }> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const response = await moltbookFetch<{
        success: boolean;
      }>(`/posts/${postId}/vote`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ direction: -1 }),
      });

      return response;
    },

    upvoteComment: async (commentId: string): Promise<{ success: boolean }> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const response = await moltbookFetch<{
        success: boolean;
      }>(`/comments/${commentId}/vote`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ direction: 1 }),
      });

      return response;
    },

    listSubmolts: async (): Promise<MoltbookSubmolt[]> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const response = await moltbookFetch<{
        submolts: Array<{
          name: string;
          display_name: string;
          description?: string;
          subscriber_count: number;
          post_count: number;
          created_at: string;
        }>;
      }>('/submolts', apiKey);

      return response.submolts.map(s => ({
        name: s.name,
        displayName: s.display_name,
        description: s.description,
        subscriberCount: s.subscriber_count,
        postCount: s.post_count,
        createdAt: s.created_at,
      }));
    },

    subscribeSubmolt: async (submolt: string): Promise<void> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      await moltbookFetch(`/submolts/${encodeURIComponent(submolt)}/subscribe`, apiKey, {
        method: 'POST',
      });
    },

    unsubscribeSubmolt: async (submolt: string): Promise<void> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      await moltbookFetch(`/submolts/${encodeURIComponent(submolt)}/subscribe`, apiKey, {
        method: 'DELETE',
      });
    },

    follow: async (agentName: string): Promise<void> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      await moltbookFetch(`/moltys/${encodeURIComponent(agentName)}/follow`, apiKey, {
        method: 'POST',
      });
    },

    unfollow: async (agentName: string): Promise<void> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      await moltbookFetch(`/moltys/${encodeURIComponent(agentName)}/follow`, apiKey, {
        method: 'DELETE',
      });
    },

    search: async (query: string, options = {}): Promise<MoltbookSearchResult[]> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const params = new URLSearchParams({ q: query });
      if (options.type && options.type !== 'all') params.set('type', options.type);
      if (options.limit) params.set('limit', options.limit.toString());

      const response = await moltbookFetch<{
        results: Array<{
          id: string;
          type: 'post' | 'comment';
          title?: string;
          body: string;
          upvotes: number;
          downvotes: number;
          similarity: number;
          author: { name: string };
          submolt?: { name: string; display_name: string };
          post_id: string;
        }>;
      }>(`/search?${params.toString()}`, apiKey);

      return response.results.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.body,
        upvotes: r.upvotes,
        downvotes: r.downvotes,
        similarity: r.similarity,
        author: r.author,
        submolt: r.submolt ? { name: r.submolt.name, displayName: r.submolt.display_name } : undefined,
        postId: r.post_id,
      }));
    },

    getMoltyProfile: async (agentName: string): Promise<MoltbookAgent> => {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('Not connected to Moltbook');

      const profile = await moltbookFetch<{
        name: string;
        description?: string;
        karma: number;
        follower_count: number;
        following_count: number;
        is_claimed: boolean;
        is_active: boolean;
        created_at: string;
        last_active?: string;
        avatar_url?: string;
      }>(`/moltys/${encodeURIComponent(agentName)}`, apiKey);

      return {
        name: profile.name,
        description: profile.description,
        karma: profile.karma,
        followerCount: profile.follower_count,
        followingCount: profile.following_count,
        isClaimed: profile.is_claimed,
        isActive: profile.is_active,
        createdAt: profile.created_at,
        lastActive: profile.last_active,
        avatarUrl: profile.avatar_url,
      };
    },
  };
}
