/**
 * Discord Webhook Manager
 *
 * Manages per-channel webhooks for the global bot mode.
 * One webhook per channel (named "Swarm Avatar Relay") is reused across all
 * avatars — each message varies `username` and `avatar_url` to set identity.
 *
 * This avoids Discord's 15-webhook-per-channel limit while letting many
 * avatars post with distinct appearances through a single bot token.
 */
import { logger } from '../utils/logger.js';

export interface WebhookInfo {
  id: string;
  token: string;
  channelId: string;
  cachedAt: number;
}

export interface WebhookSendOptions {
  content: string;
  username: string;
  avatar_url?: string;
  embeds?: Array<{
    image?: { url: string };
    [key: string]: unknown;
  }>;
}

export interface WebhookCacheStats {
  size: number;
  hits: number;
  misses: number;
  creates: number;
  invalidations: number;
}

const WEBHOOK_NAME = 'Swarm Avatar Relay';
const DEFAULT_CACHE_TTL_MS = 30 * 60_000; // 30 minutes
const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class DiscordWebhookManager {
  private cache = new Map<string, WebhookInfo>();
  private cacheTtlMs: number;
  private botToken: string;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private stats: WebhookCacheStats = {
    size: 0,
    hits: 0,
    misses: 0,
    creates: 0,
    invalidations: 0,
  };

  constructor(botToken: string, cacheTtlMs?: number) {
    this.botToken = botToken;
    this.cacheTtlMs = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Get or create a webhook for the given channel.
   * Returns cached webhook if available and not expired.
   */
  async getOrCreateWebhook(channelId: string): Promise<WebhookInfo> {
    const cached = this.cache.get(channelId);
    if (cached && (Date.now() - cached.cachedAt) < this.cacheTtlMs) {
      this.stats.hits++;
      return cached;
    }
    this.stats.misses++;

    // List existing webhooks on the channel
    const existing = await this.listChannelWebhooks(channelId);
    const ours = existing.find(
      (w: { name: string; user?: { id: string } }) => w.name === WEBHOOK_NAME
    );

    if (ours) {
      const info: WebhookInfo = {
        id: ours.id,
        token: ours.token,
        channelId,
        cachedAt: Date.now(),
      };
      this.cache.set(channelId, info);
      this.stats.size = this.cache.size;
      return info;
    }

    // Create a new webhook
    const created = await this.createWebhook(channelId);
    const info: WebhookInfo = {
      id: created.id,
      token: created.token,
      channelId,
      cachedAt: Date.now(),
    };
    this.cache.set(channelId, info);
    this.stats.creates++;
    this.stats.size = this.cache.size;
    return info;
  }

  /**
   * Send a message via webhook with the given avatar identity.
   * On 404 (webhook deleted), invalidates cache and retries once.
   */
  async send(channelId: string, options: WebhookSendOptions): Promise<void> {
    let webhook = await this.getOrCreateWebhook(channelId);

    const payload: Record<string, unknown> = {
      content: options.content,
      username: options.username,
      avatar_url: options.avatar_url,
    };

    if (options.embeds && options.embeds.length > 0) {
      payload.embeds = options.embeds;
    }

    let response = await fetch(
      `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    // Retry once on 404 (webhook was deleted externally)
    if (response.status === 404) {
      logger.warn('Webhook 404, invalidating cache and retrying', {
        subsystem: 'discord',
        channelId,
        webhookId: webhook.id,
      });
      this.invalidate(channelId);
      webhook = await this.getOrCreateWebhook(channelId);

      response = await fetch(
        `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook send failed (${response.status}): ${errorText}`);
    }
  }

  /** Invalidate cache for a specific channel */
  invalidate(channelId: string): void {
    this.cache.delete(channelId);
    this.stats.invalidations++;
    this.stats.size = this.cache.size;
  }

  /** Clear the entire webhook cache */
  clearCache(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  /** Remove cache entries that have expired past TTL */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [channelId, info] of this.cache) {
      if ((now - info.cachedAt) >= this.cacheTtlMs) {
        this.cache.delete(channelId);
        pruned++;
      }
    }
    this.stats.size = this.cache.size;
    return pruned;
  }

  /** Start a periodic cleanup interval */
  startCleanupInterval(intervalMs = 10 * 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const pruned = this.pruneExpired();
      if (pruned > 0) {
        logger.info('Webhook cache pruned', {
          subsystem: 'discord',
          pruned,
          remaining: this.cache.size,
        });
      }
    }, intervalMs);
  }

  /** Stop the periodic cleanup interval */
  stopCleanupInterval(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Delete a webhook from Discord API and remove from cache */
  async deleteWebhook(channelId: string): Promise<void> {
    const cached = this.cache.get(channelId);
    if (!cached) return;

    try {
      await fetch(
        `${DISCORD_API_BASE}/webhooks/${cached.id}/${cached.token}`,
        {
          method: 'DELETE',
        }
      );
    } catch (err) {
      logger.warn('Failed to delete webhook', {
        subsystem: 'discord',
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.cache.delete(channelId);
    this.stats.size = this.cache.size;
  }

  /** Get cache statistics */
  getCacheStats(): WebhookCacheStats {
    return { ...this.stats };
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private async listChannelWebhooks(channelId: string): Promise<Array<{ id: string; name: string; token: string; user?: { id: string } }>> {
    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/webhooks`,
      {
        headers: { 'Authorization': `Bot ${this.botToken}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list webhooks for channel ${channelId}: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<Array<{ id: string; name: string; token: string; user?: { id: string } }>>;
  }

  private async createWebhook(channelId: string): Promise<{ id: string; token: string }> {
    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/webhooks`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: WEBHOOK_NAME }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create webhook in channel ${channelId}: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<{ id: string; token: string }>;
  }
}
