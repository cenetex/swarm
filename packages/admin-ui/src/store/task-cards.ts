/**
 * Task Card Store — ephemeral session store for transcript task artifacts.
 *
 * Task cards are first-class transcript items keyed by `toolCall.id` (not
 * message ID, which is unstable across syncChatHistory/setChat). They
 * survive message-array replacement and chat-history sync because they
 * live in a separate store.
 *
 * Session-scoped: survives in-session state churn but not full page reload.
 */
import { create } from 'zustand';

export interface TaskCard {
  id: string;                    // = toolCall.id (stable join key)
  avatarId: string;
  toolCallId: string;            // same as id — explicit for clarity
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  result?: unknown;
  summary?: string;
  createdAt: number;
  updatedAt: number;
  inlineExpanded: boolean;
  workspaceState: 'hidden' | 'available' | 'open';
}

interface TaskCardState {
  cards: Record<string, TaskCard>; // keyed by toolCall.id

  registerTaskCard: (card: Pick<TaskCard, 'id' | 'avatarId' | 'toolName' | 'arguments'> & { toolCallId?: string }) => void;
  updateStatus: (id: string, status: TaskCard['status'], result?: unknown) => void;
  setSummary: (id: string, summary: string) => void;
  toggleExpanded: (id: string) => void;
  clearForAvatar: (avatarId: string) => void;
  getCard: (id: string) => TaskCard | undefined;
  getCardsForAvatar: (avatarId: string) => TaskCard[];
}

export const useTaskCardStore = create<TaskCardState>((set, get) => ({
  cards: {},

  registerTaskCard: (card) => {
    // Don't overwrite if already registered (idempotent)
    if (get().cards[card.id]) return;
    const now = Date.now();
    set((state) => ({
      cards: {
        ...state.cards,
        [card.id]: {
          ...card,
          toolCallId: card.toolCallId ?? card.id,
          createdAt: now,
          updatedAt: now,
          status: 'pending',
          inlineExpanded: true,
          workspaceState: 'hidden',
        },
      },
    }));
  },

  updateStatus: (id, status, result) => {
    set((state) => {
      const existing = state.cards[id];
      if (!existing) return state;
      return {
        cards: {
          ...state.cards,
          [id]: {
            ...existing,
            status,
            result: result ?? existing.result,
            updatedAt: Date.now(),
            inlineExpanded: status === 'pending',
          },
        },
      };
    });
  },

  setSummary: (id, summary) => {
    set((state) => {
      const existing = state.cards[id];
      if (!existing) return state;
      return {
        cards: {
          ...state.cards,
          [id]: { ...existing, summary, updatedAt: Date.now() },
        },
      };
    });
  },

  toggleExpanded: (id) => {
    set((state) => {
      const existing = state.cards[id];
      if (!existing) return state;
      return {
        cards: {
          ...state.cards,
          [id]: { ...existing, inlineExpanded: !existing.inlineExpanded },
        },
      };
    });
  },

  clearForAvatar: (avatarId) => {
    set((state) => {
      const next: Record<string, TaskCard> = {};
      for (const [key, card] of Object.entries(state.cards)) {
        if (card.avatarId !== avatarId) next[key] = card;
      }
      return { cards: next };
    });
  },

  getCard: (id) => get().cards[id],

  getCardsForAvatar: (avatarId) =>
    Object.values(get().cards).filter((c) => c.avatarId === avatarId),
}));

/* ------------------------------------------------------------------ */
/* Transcript timeline composition                                     */
/* ------------------------------------------------------------------ */

import { useMemo } from 'react';
import type { ChatMessage } from '../types';

export type TimelineItem =
  | { type: 'message'; message: ChatMessage }
  | { type: 'task-card'; card: TaskCard };

/**
 * Pure composition function (testable without React).
 *
 * Strategy: for each task card, try to insert it immediately after the
 * assistant message whose `serverToolCalls` or `toolCalls` contain the
 * matching `toolCall.id`. If no match is found (e.g., after
 * syncChatHistory regenerated IDs), fall back to `createdAt` ordering.
 */
export function composeTimeline(
  messages: ChatMessage[],
  avatarCards: TaskCard[],
): TimelineItem[] {
  if (avatarCards.length === 0) {
    return messages.map((m) => ({ type: 'message' as const, message: m }));
  }

  // Build a set of toolCall IDs that have task cards
  const cardByToolCallId = new Map<string, TaskCard>();
  for (const card of avatarCards) {
    cardByToolCallId.set(card.toolCallId, card);
  }

  // Track which cards have been placed
  const placed = new Set<string>();
  const timeline: TimelineItem[] = [];

  for (const message of messages) {
    // Add the message itself
    timeline.push({ type: 'message', message });

    // Check if this message introduced any tool calls that have task cards
    // Match against both serverToolCalls (backend format) and toolCalls (frontend format)
    const toolCallIds: string[] = [];
    if (message.serverToolCalls) {
      for (const stc of message.serverToolCalls) {
        toolCallIds.push(stc.id);
      }
    }
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        if (!toolCallIds.includes(tc.id)) {
          toolCallIds.push(tc.id);
        }
      }
    }

    for (const tcId of toolCallIds) {
      const card = cardByToolCallId.get(tcId);
      if (card && !placed.has(card.id)) {
        timeline.push({ type: 'task-card', card });
        placed.add(card.id);
      }
    }
  }

  // Fallback: append any unplaced cards ordered by createdAt
  const unplaced = avatarCards
    .filter((c) => !placed.has(c.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const card of unplaced) {
    timeline.push({ type: 'task-card', card });
  }

  return timeline;
}

/**
 * React hook wrapper around composeTimeline.
 */
export function useTranscriptTimeline(
  messages: ChatMessage[],
  avatarId: string | undefined,
): TimelineItem[] {
  const cards = useTaskCardStore((s) => s.cards);

  return useMemo(() => {
    if (!avatarId) return messages.map((m) => ({ type: 'message' as const, message: m }));
    const avatarCards = Object.values(cards).filter((c) => c.avatarId === avatarId);
    return composeTimeline(messages, avatarCards);
  }, [messages, avatarId, cards]);
}
