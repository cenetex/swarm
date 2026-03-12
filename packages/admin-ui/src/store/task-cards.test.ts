/**
 * Tests for TaskCard store, timeline composition, and integration scenarios.
 *
 * Covers:
 * - Store: registration, status transitions, cancel/dismiss, clear, toggle
 * - composeTimeline: card placement after originating messages, fallback ordering,
 *   serverToolCalls matching, multiple cards, message replacement survival
 * - OAuth scoping: only the most recent pending card is resolved
 * - Cancel/dismiss: header summary reflects actual status, not success text
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskCardStore, composeTimeline, type TaskCard } from './task-cards';
import type { ChatMessage } from '../types';

// Reset store between tests
beforeEach(() => {
  useTaskCardStore.setState({ cards: {} });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeCard(overrides: Partial<TaskCard> & { id: string; avatarId: string }): TaskCard {
  const now = Date.now();
  return {
    toolCallId: overrides.id,
    toolName: 'confirm_action',
    arguments: {},
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    inlineExpanded: true,
    workspaceState: 'hidden',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Store basics                                                        */
/* ------------------------------------------------------------------ */

describe('useTaskCardStore', () => {
  it('registers a task card with defaults', () => {
    useTaskCardStore.getState().registerTaskCard({
      id: 'tc-1',
      avatarId: 'avatar-1',
      toolName: 'request_secret',
      arguments: { secretKey: 'OPENAI_KEY' },
    });

    const card = useTaskCardStore.getState().cards['tc-1'];
    expect(card).toBeDefined();
    expect(card.status).toBe('pending');
    expect(card.toolCallId).toBe('tc-1');
    expect(card.inlineExpanded).toBe(true);
    expect(card.workspaceState).toBe('hidden');
    expect(card.createdAt).toBeGreaterThan(0);
    expect(card.updatedAt).toBe(card.createdAt);
  });

  it('is idempotent — does not overwrite existing card', () => {
    const { registerTaskCard } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'request_secret', arguments: {} });
    const original = useTaskCardStore.getState().cards['tc-1'];

    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'confirm_action', arguments: { action: 'delete' } });
    const after = useTaskCardStore.getState().cards['tc-1'];
    expect(after.toolName).toBe('request_secret');
    expect(after.createdAt).toBe(original.createdAt);
  });

  it('updates status to completed', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'confirm_action', arguments: {} });
    updateStatus('tc-1', 'completed', { confirmed: true });

    const card = useTaskCardStore.getState().cards['tc-1'];
    expect(card.status).toBe('completed');
    expect(card.result).toEqual({ confirmed: true });
    expect(card.inlineExpanded).toBe(false);
  });

  it('updates status to cancelled', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'request_wallet_link', arguments: {} });
    updateStatus('tc-1', 'cancelled', { linked: false, cancelled: true });

    const card = useTaskCardStore.getState().cards['tc-1'];
    expect(card.status).toBe('cancelled');
    expect(card.inlineExpanded).toBe(false);
  });

  it('updates status to failed with error result', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'request_secret', arguments: {} });
    updateStatus('tc-1', 'failed', { error: 'Network error' });

    const card = useTaskCardStore.getState().cards['tc-1'];
    expect(card.status).toBe('failed');
    expect((card.result as Record<string, unknown>)?.error).toBe('Network error');
  });

  it('no-ops for unknown card id', () => {
    useTaskCardStore.getState().updateStatus('nonexistent', 'completed');
    expect(useTaskCardStore.getState().cards['nonexistent']).toBeUndefined();
  });

  it('toggles inlineExpanded', () => {
    const { registerTaskCard, toggleExpanded } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a', toolName: 'confirm_action', arguments: {} });

    expect(useTaskCardStore.getState().cards['tc-1'].inlineExpanded).toBe(true);
    toggleExpanded('tc-1');
    expect(useTaskCardStore.getState().cards['tc-1'].inlineExpanded).toBe(false);
    toggleExpanded('tc-1');
    expect(useTaskCardStore.getState().cards['tc-1'].inlineExpanded).toBe(true);
  });

  it('clears cards for a specific avatar only', () => {
    const { registerTaskCard, clearForAvatar } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a1', toolName: 'x', arguments: {} });
    registerTaskCard({ id: 'tc-2', avatarId: 'a2', toolName: 'x', arguments: {} });
    registerTaskCard({ id: 'tc-3', avatarId: 'a1', toolName: 'y', arguments: {} });

    clearForAvatar('a1');

    const cards = useTaskCardStore.getState().cards;
    expect(cards['tc-1']).toBeUndefined();
    expect(cards['tc-3']).toBeUndefined();
    expect(cards['tc-2']).toBeDefined();
  });

  it('getCardsForAvatar returns only matching cards', () => {
    const { registerTaskCard } = useTaskCardStore.getState();
    registerTaskCard({ id: 'tc-1', avatarId: 'a1', toolName: 'x', arguments: {} });
    registerTaskCard({ id: 'tc-2', avatarId: 'a2', toolName: 'x', arguments: {} });

    const result = useTaskCardStore.getState().getCardsForAvatar('a1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tc-1');
  });
});

/* ------------------------------------------------------------------ */
/* composeTimeline — pure function tests                               */
/* ------------------------------------------------------------------ */

describe('composeTimeline', () => {
  it('returns only messages when no task cards exist', () => {
    const messages = [msg({ id: 'm1', content: 'hello' }), msg({ id: 'm2', content: 'world' })];
    const timeline = composeTimeline(messages, []);
    expect(timeline).toHaveLength(2);
    expect(timeline.every((t) => t.type === 'message')).toBe(true);
  });

  it('inserts card after the message whose toolCalls contain the matching id', () => {
    const card = makeCard({ id: 'tc-1', avatarId: 'a1' });
    const messages = [
      msg({ id: 'm1', content: 'hi' }),
      msg({ id: 'm2', toolCalls: [{ id: 'tc-1', name: 'confirm_action', arguments: {}, status: 'pending' }] }),
      msg({ id: 'm3', content: 'follow-up' }),
    ];

    const timeline = composeTimeline(messages, [card]);
    expect(timeline).toHaveLength(4); // 3 messages + 1 card
    expect(timeline[0].type).toBe('message');
    expect(timeline[1].type).toBe('message'); // m2
    expect(timeline[2].type).toBe('task-card'); // card inserted after m2
    expect(timeline[3].type).toBe('message'); // m3
    expect((timeline[2] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-1');
  });

  it('inserts card after message matched via serverToolCalls', () => {
    const card = makeCard({ id: 'tc-srv-1', avatarId: 'a1' });
    const messages = [
      msg({
        id: 'm1',
        serverToolCalls: [{ id: 'tc-srv-1', type: 'function', function: { name: 'confirm_action', arguments: '{}' } }],
      }),
    ];

    const timeline = composeTimeline(messages, [card]);
    expect(timeline).toHaveLength(2);
    expect(timeline[1].type).toBe('task-card');
  });

  it('falls back to createdAt ordering for unmatched cards', () => {
    // Simulate syncChatHistory regenerating message IDs so no toolCall ID matches
    const earlyCard = makeCard({ id: 'tc-old', avatarId: 'a1', createdAt: 1000, updatedAt: 1000 });
    const lateCard = makeCard({ id: 'tc-new', avatarId: 'a1', createdAt: 2000, updatedAt: 2000 });
    const messages = [
      msg({ id: 'synced-0', content: 'hello' }),
      msg({ id: 'synced-1', content: 'world' }),
    ];

    const timeline = composeTimeline(messages, [lateCard, earlyCard]);
    expect(timeline).toHaveLength(4); // 2 messages + 2 unplaced cards
    // Unplaced cards appended in createdAt order
    expect(timeline[2].type).toBe('task-card');
    expect((timeline[2] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-old');
    expect(timeline[3].type).toBe('task-card');
    expect((timeline[3] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-new');
  });

  it('does not duplicate a card if both toolCalls and serverToolCalls match', () => {
    const card = makeCard({ id: 'tc-1', avatarId: 'a1' });
    const messages = [
      msg({
        id: 'm1',
        toolCalls: [{ id: 'tc-1', name: 'confirm_action', arguments: {}, status: 'pending' }],
        serverToolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'confirm_action', arguments: '{}' } }],
      }),
    ];

    const timeline = composeTimeline(messages, [card]);
    expect(timeline).toHaveLength(2); // 1 message + 1 card, not 1 + 2
  });

  it('handles multiple cards on different messages', () => {
    const card1 = makeCard({ id: 'tc-1', avatarId: 'a1' });
    const card2 = makeCard({ id: 'tc-2', avatarId: 'a1' });
    const messages = [
      msg({ id: 'm1', toolCalls: [{ id: 'tc-1', name: 'request_secret', arguments: {}, status: 'pending' }] }),
      msg({ id: 'm2', content: 'ok got the secret' }),
      msg({ id: 'm3', toolCalls: [{ id: 'tc-2', name: 'confirm_action', arguments: {}, status: 'pending' }] }),
    ];

    const timeline = composeTimeline(messages, [card1, card2]);
    expect(timeline).toHaveLength(5); // 3 messages + 2 cards
    // card1 after m1
    expect(timeline[1].type).toBe('task-card');
    expect((timeline[1] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-1');
    // card2 after m3
    expect(timeline[4].type).toBe('task-card');
    expect((timeline[4] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-2');
  });

  it('mixes placed and unplaced cards correctly', () => {
    const placed = makeCard({ id: 'tc-placed', avatarId: 'a1' });
    const orphan = makeCard({ id: 'tc-orphan', avatarId: 'a1', createdAt: 5000, updatedAt: 5000 });
    const messages = [
      msg({ id: 'm1', toolCalls: [{ id: 'tc-placed', name: 'x', arguments: {}, status: 'pending' }] }),
      msg({ id: 'm2', content: 'after' }),
    ];

    const timeline = composeTimeline(messages, [placed, orphan]);
    // m1, tc-placed, m2, tc-orphan (fallback)
    expect(timeline).toHaveLength(4);
    expect(timeline[1].type).toBe('task-card');
    expect((timeline[1] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-placed');
    expect(timeline[3].type).toBe('task-card');
    expect((timeline[3] as { type: 'task-card'; card: TaskCard }).card.id).toBe('tc-orphan');
  });
});

/* ------------------------------------------------------------------ */
/* OAuth scoping: store-based resolution                               */
/* ------------------------------------------------------------------ */

// Replicate the resolveOAuthTaskCard helper from App.tsx so tests
// exercise the same logic that runs in production.
function isTwitterCard(c: { toolName: string; arguments: Record<string, unknown> }) {
  if (c.toolName === 'request_twitter_connection' || c.toolName === 'twitter_request_integration') return true;
  if (c.toolName === 'configure_integration') return c.arguments.integration === 'twitter';
  return false;
}

function resolveOAuthTaskCard(
  avatarId: string,
  status: 'completed' | 'failed',
  resultData: unknown,
): string | undefined {
  const cards = useTaskCardStore.getState().getCardsForAvatar(avatarId);
  const pending = cards
    .filter((c) => c.status === 'pending' && isTwitterCard(c))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (pending.length === 0) return undefined;
  const target = pending[0];
  useTaskCardStore.getState().updateStatus(target.id, status, resultData);
  return target.id;
}

describe('OAuth task card scoping (store-based resolver)', () => {
  it('resolves only the pending card, not historical ones', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();

    // First attempt — already failed from an earlier OAuth flow
    registerTaskCard({
      id: 'tc-twitter-old',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: { type: 'twitter_connect' },
    });
    updateStatus('tc-twitter-old', 'failed', { error: 'Expired token' });

    // Second attempt — this is the one pending when OAuth returns
    registerTaskCard({
      id: 'tc-twitter-new',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: { type: 'twitter_connect' },
    });

    const resolved = resolveOAuthTaskCard('a1', 'completed', { connected: true });

    expect(resolved).toBe('tc-twitter-new');
    expect(useTaskCardStore.getState().cards['tc-twitter-old'].status).toBe('failed');
    expect(useTaskCardStore.getState().cards['tc-twitter-new'].status).toBe('completed');
  });

  it('OAuth error does not rewrite already-completed historical cards', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();

    registerTaskCard({
      id: 'tc-old-success',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: {},
    });
    updateStatus('tc-old-success', 'completed', { connected: true });

    registerTaskCard({
      id: 'tc-current',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: {},
    });

    const resolved = resolveOAuthTaskCard('a1', 'failed', { error: 'OAuth denied' });

    expect(resolved).toBe('tc-current');
    expect(useTaskCardStore.getState().cards['tc-old-success'].status).toBe('completed');
    expect(useTaskCardStore.getState().cards['tc-current'].status).toBe('failed');
  });

  it('resolves correctly even after syncChatHistory clobbers message.toolCalls to completed', () => {
    // This is the real production scenario:
    // 1. User triggers twitter connect → task card registered as pending
    // 2. OAuth redirect → page reloads or sync fires
    // 3. syncChatHistory reconstructs all message.toolCalls with status: 'completed'
    // 4. handleTwitterOAuthResult runs — message.toolCalls say 'completed' but
    //    the task card store still says 'pending'

    const { registerTaskCard } = useTaskCardStore.getState();

    registerTaskCard({
      id: 'tc-twitter-sync',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: { type: 'twitter_connect' },
    });

    // Simulate syncChatHistory clobbering messages — task card store is unaffected
    // (messages are irrelevant to the resolver; it only reads the card store)
    const syncedMessages = [
      msg({
        id: 'synced-0',
        content: '',
        toolCalls: [{
          id: 'tc-twitter-sync',
          name: 'request_twitter_connection',
          arguments: { type: 'twitter_connect' },
          status: 'completed', // sync clobbered this to 'completed'
        }],
      }),
    ];

    // Verify the card store still has 'pending' despite the sync
    expect(useTaskCardStore.getState().cards['tc-twitter-sync'].status).toBe('pending');

    // The resolver uses the card store, not message.toolCalls
    const resolved = resolveOAuthTaskCard('a1', 'completed', { connected: true });

    expect(resolved).toBe('tc-twitter-sync');
    expect(useTaskCardStore.getState().cards['tc-twitter-sync'].status).toBe('completed');

    // The synced message is irrelevant — used for timeline composition only
    expect(syncedMessages[0].toolCalls?.[0].status).toBe('completed');
  });

  it('returns undefined when no pending OAuth card exists', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();

    registerTaskCard({
      id: 'tc-already-done',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: {},
    });
    updateStatus('tc-already-done', 'completed', { connected: true });

    const resolved = resolveOAuthTaskCard('a1', 'completed', { connected: true });
    expect(resolved).toBeUndefined();
    // Existing card unchanged
    expect(useTaskCardStore.getState().cards['tc-already-done'].status).toBe('completed');
  });

  it('resolves only the Twitter card when a non-Twitter configure_integration card is also pending', () => {
    const { registerTaskCard } = useTaskCardStore.getState();

    // Pending configure_integration for telegram — should NOT be touched
    registerTaskCard({
      id: 'tc-telegram',
      avatarId: 'a1',
      toolName: 'configure_integration',
      arguments: { integration: 'telegram', type: 'configure_integration' },
    });

    // Pending configure_integration for twitter — should be resolved
    registerTaskCard({
      id: 'tc-twitter-cfg',
      avatarId: 'a1',
      toolName: 'configure_integration',
      arguments: { integration: 'twitter', type: 'configure_integration' },
    });

    const resolved = resolveOAuthTaskCard('a1', 'completed', { connected: true });

    expect(resolved).toBe('tc-twitter-cfg');
    expect(useTaskCardStore.getState().cards['tc-twitter-cfg'].status).toBe('completed');
    // Telegram card remains pending
    expect(useTaskCardStore.getState().cards['tc-telegram'].status).toBe('pending');
  });

  it('resolves request_twitter_connection over non-Twitter configure_integration', () => {
    const { registerTaskCard } = useTaskCardStore.getState();

    // Pending configure_integration for discord
    registerTaskCard({
      id: 'tc-discord',
      avatarId: 'a1',
      toolName: 'configure_integration',
      arguments: { integration: 'discord' },
    });

    // Pending request_twitter_connection
    registerTaskCard({
      id: 'tc-twitter-req',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: { type: 'twitter_connect' },
    });

    // Pending configure_integration for openai
    registerTaskCard({
      id: 'tc-openai',
      avatarId: 'a1',
      toolName: 'configure_integration',
      arguments: { integration: 'openai' },
    });

    const resolved = resolveOAuthTaskCard('a1', 'completed', { connected: true });

    expect(resolved).toBe('tc-twitter-req');
    expect(useTaskCardStore.getState().cards['tc-twitter-req'].status).toBe('completed');
    // Non-Twitter cards untouched
    expect(useTaskCardStore.getState().cards['tc-discord'].status).toBe('pending');
    expect(useTaskCardStore.getState().cards['tc-openai'].status).toBe('pending');
  });
});

/* ------------------------------------------------------------------ */
/* Cancel status correctness                                           */
/* ------------------------------------------------------------------ */

describe('Task card cancel status', () => {
  it('cancelled wallet-link card reports "cancelled" not "Wallet linked"', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();
    registerTaskCard({
      id: 'tc-wallet',
      avatarId: 'a1',
      toolName: 'request_wallet_link',
      arguments: {},
    });
    updateStatus('tc-wallet', 'cancelled', { linked: false, cancelled: true });

    const card = useTaskCardStore.getState().cards['tc-wallet'];
    // The card status itself is 'cancelled', NOT 'completed'
    expect(card.status).toBe('cancelled');
    // Verify the store doesn't carry a success result
    expect((card.result as Record<string, unknown>)?.linked).toBe(false);
  });

  it('cancelled twitter card has cancelled status', () => {
    const { registerTaskCard, updateStatus } = useTaskCardStore.getState();
    registerTaskCard({
      id: 'tc-tw',
      avatarId: 'a1',
      toolName: 'request_twitter_connection',
      arguments: { type: 'twitter_connect' },
    });
    updateStatus('tc-tw', 'cancelled');

    expect(useTaskCardStore.getState().cards['tc-tw'].status).toBe('cancelled');
  });

});
