/**
 * Platform Heartbeat Handler Tests
 *
 * Tests for adapter registration, the moltbook adapter's isEnabled logic,
 * and the adapter interface contract.
 *
 * @see packages/handlers/src/social/platform-heartbeat.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  moltbookAdapter,
  registerAdapter,
  getAdapters,
  _resetAdapters,
  type HeartbeatPlatformAdapter,
  type ActivityItem,
  type HeartbeatAction,
} from './platform-heartbeat.js';

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  beforeEach(() => {
    _resetAdapters();
  });

  it('starts with moltbook adapter registered', () => {
    const adapters = getAdapters();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].platform).toBe('moltbook');
  });

  it('registerAdapter adds a new adapter', () => {
    const testAdapter: HeartbeatPlatformAdapter = {
      platform: 'twitter',
      defaultIntervalMs: 60_000,
      isEnabled: () => true,
      fetchActivity: async () => [],
      executeAction: async () => {},
    };

    registerAdapter(testAdapter);
    const adapters = getAdapters();
    expect(adapters).toHaveLength(2);
    expect(adapters[1].platform).toBe('twitter');
  });

  it('registerAdapter replaces existing adapter with same platform', () => {
    const replacementAdapter: HeartbeatPlatformAdapter = {
      platform: 'moltbook',
      defaultIntervalMs: 10_000,
      isEnabled: () => false,
      fetchActivity: async () => [],
      executeAction: async () => {},
    };

    registerAdapter(replacementAdapter);
    const adapters = getAdapters();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].defaultIntervalMs).toBe(10_000);
  });

  it('_resetAdapters restores default adapters', () => {
    registerAdapter({
      platform: 'twitter',
      defaultIntervalMs: 60_000,
      isEnabled: () => true,
      fetchActivity: async () => [],
      executeAction: async () => {},
    });
    expect(getAdapters()).toHaveLength(2);

    _resetAdapters();
    expect(getAdapters()).toHaveLength(1);
    expect(getAdapters()[0].platform).toBe('moltbook');
  });
});

// ---------------------------------------------------------------------------
// Moltbook adapter - isEnabled
// ---------------------------------------------------------------------------

describe('moltbookAdapter.isEnabled', () => {
  it('returns true when mcpConfig.enabledToolsets contains moltbook', () => {
    const config = {
      mcpConfig: { enabledToolsets: ['moltbook', 'twitter'] },
    };
    expect(moltbookAdapter.isEnabled(config)).toBe(true);
  });

  it('returns false when mcpConfig.enabledToolsets does not contain moltbook', () => {
    const config = {
      mcpConfig: { enabledToolsets: ['twitter'] },
    };
    expect(moltbookAdapter.isEnabled(config)).toBe(false);
  });

  it('returns false when mcpConfig is missing', () => {
    expect(moltbookAdapter.isEnabled({})).toBe(false);
  });

  it('returns false when enabledToolsets is not an array', () => {
    const config = {
      mcpConfig: { enabledToolsets: 'moltbook' },
    };
    expect(moltbookAdapter.isEnabled(config)).toBe(false);
  });

  it('returns false when enabledToolsets is empty', () => {
    const config = {
      mcpConfig: { enabledToolsets: [] },
    };
    expect(moltbookAdapter.isEnabled(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moltbook adapter - properties
// ---------------------------------------------------------------------------

describe('moltbookAdapter properties', () => {
  it('has platform set to moltbook', () => {
    expect(moltbookAdapter.platform).toBe('moltbook');
  });

  it('has default interval of 33 minutes', () => {
    expect(moltbookAdapter.defaultIntervalMs).toBe(33 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatPlatformAdapter contract
// ---------------------------------------------------------------------------

describe('HeartbeatPlatformAdapter contract', () => {
  it('adapter with fetchActivity returning empty does not trigger actions', async () => {
    const actions: HeartbeatAction[] = [];
    const adapter: HeartbeatPlatformAdapter = {
      platform: 'test-platform',
      defaultIntervalMs: 1000,
      isEnabled: () => true,
      fetchActivity: async () => [],
      executeAction: async (action) => { actions.push(action); },
    };

    const activities = await adapter.fetchActivity('avatar-1', {});
    expect(activities).toEqual([]);
    expect(actions).toHaveLength(0);
  });

  it('adapter executeAction receives correct action data', async () => {
    const executedActions: HeartbeatAction[] = [];
    const adapter: HeartbeatPlatformAdapter = {
      platform: 'test-platform',
      defaultIntervalMs: 1000,
      isEnabled: () => true,
      fetchActivity: async (): Promise<ActivityItem[]> => [{
        id: 'post-1',
        platform: 'test-platform',
        title: 'Test Post',
        author: 'user1',
        createdAt: '2024-01-01T00:00:00Z',
      }],
      executeAction: async (action) => { executedActions.push(action); },
    };

    const action: HeartbeatAction = {
      type: 'upvote',
      targetId: 'post-1',
      reason: 'interesting content',
    };

    await adapter.executeAction(action, 'avatar-1', { API_KEY: 'test' });
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]).toEqual(action);
  });

  it('one failing platform adapter does not affect others', async () => {
    const results: string[] = [];

    const failingAdapter: HeartbeatPlatformAdapter = {
      platform: 'failing-platform',
      defaultIntervalMs: 1000,
      isEnabled: () => true,
      fetchActivity: async () => { throw new Error('Network error'); },
      executeAction: async () => {},
    };

    const successAdapter: HeartbeatPlatformAdapter = {
      platform: 'success-platform',
      defaultIntervalMs: 1000,
      isEnabled: () => true,
      fetchActivity: async (): Promise<ActivityItem[]> => {
        results.push('success-fetched');
        return [];
      },
      executeAction: async () => {},
    };

    // Simulate the handler pattern: iterate adapters, catch errors per-platform
    const adapters = [failingAdapter, successAdapter];
    for (const adapter of adapters) {
      try {
        const activities = await adapter.fetchActivity('avatar-1', {});
        results.push(`${adapter.platform}:${activities.length}`);
      } catch {
        results.push(`${adapter.platform}:error`);
      }
    }

    expect(results).toContain('failing-platform:error');
    expect(results).toContain('success-fetched');
    expect(results).toContain('success-platform:0');
  });

  it('only enabled platforms are processed', () => {
    const adapters: HeartbeatPlatformAdapter[] = [
      {
        platform: 'enabled',
        defaultIntervalMs: 1000,
        isEnabled: () => true,
        fetchActivity: async () => [],
        executeAction: async () => {},
      },
      {
        platform: 'disabled',
        defaultIntervalMs: 1000,
        isEnabled: () => false,
        fetchActivity: async () => [],
        executeAction: async () => {},
      },
    ];

    const avatarConfig = {};
    const enabledAdapters = adapters.filter((a) => a.isEnabled(avatarConfig));
    expect(enabledAdapters).toHaveLength(1);
    expect(enabledAdapters[0].platform).toBe('enabled');
  });
});
