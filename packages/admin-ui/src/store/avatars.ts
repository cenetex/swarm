/**
 * Avatar Store - Manages multiple avatars and their chats
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Avatar, ChatMessage } from '../types';
import * as api from '../api/avatars';
import { fetchChatHistory as apiFetchChatHistory, clearChatHistory as apiClearChatHistory } from '../api/chat';

// Generate a unique ID
const generateId = () => crypto.randomUUID();

// Default avatar colors
const AVATAR_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
];

const getRandomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

// Generate avatar URL (using DiceBear API)
const generateAvatarImage = (seed: string) =>
  `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;

interface AvatarState {
  avatars: Avatar[];
  chats: Record<string, ChatMessage[]>;
  activeAvatarId: string | null;
  isLoading: boolean;
  error: string | null;

  // Avatar management
  createAvatar: (name?: string) => Promise<Avatar>;
  updateAvatar: (id: string, updates: Partial<Avatar>) => void;
  deleteAvatar: (id: string) => Promise<void>;
  setActiveAvatar: (id: string | null) => void;
  fetchAvatars: () => Promise<void>;

  // Chat management
  addMessage: (avatarId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (avatarId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  removeMessage: (avatarId: string, messageId: string) => void;
  clearChat: (avatarId: string) => void;
  syncChatHistory: (avatarId: string) => Promise<void>;
  setChat: (avatarId: string, messages: ChatMessage[]) => void;

  // UI state
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAvatarStore = create<AvatarState>()(
  persist(
    (set, get) => ({
      avatars: [],
      chats: {},
      activeAvatarId: null,
      isLoading: false,
      error: null,

      createAvatar: async (name?: string) => {
        const avatarName = name || `Avatar ${get().avatars.length + 1}`;
        set({ isLoading: true, error: null });

        try {
          // Create avatar on backend first
          const response = await api.createAvatar(avatarName);

          const avatar: Avatar = {
            id: response.avatarId,
            name: response.name,
            description: response.description,
            persona: response.persona,
            avatar: response.profileImage?.url || generateAvatarImage(response.avatarId),
            color: getRandomColor(),
            secrets: [],
            status: response.status,
            creatorWallet: response.creatorWallet,
            slotType: response.slotType,
            orbMint: response.orbMint,
            orbWallet: response.orbWallet,
            orbSlottedAt: response.orbSlottedAt,
            platforms: response.platforms,
            createdAt: response.createdAt,
            updatedAt: response.updatedAt,
          };

          set((state) => ({
            avatars: [...state.avatars, avatar],
            chats: {
              ...state.chats,
              [avatar.id]: [{
                id: 'welcome',
                role: 'assistant',
                content: `Hi! I'm **${avatarName}**. I'm a new avatar ready to be configured!\n\nAsk me to change my name, set my personality, generate a profile picture, or connect integrations like Telegram and Twitter.`,
                timestamp: Date.now(),
              }],
            },
            activeAvatarId: avatar.id,
            isLoading: false,
          }));

          return avatar;
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to create avatar',
          });
          throw error;
        }
      },

      updateAvatar: (id, updates) => {
        set((state) => ({
          avatars: state.avatars.map((a) =>
            a.id === id
              ? {
                  ...a,
                  ...updates,
                  updatedAt: Date.now(),
                  // Auto-update status based on secrets
                  status: updates.secrets?.some(s => s.isSet) || a.secrets?.some(s => s.isSet)
                    ? 'configured'
                    : a.status === 'shell' ? 'shell' : a.status,
                }
              : a
          ),
        }));
      },

      deleteAvatar: async (id) => {
        set({ isLoading: true, error: null });

        try {
          // Delete from backend first
          await api.deleteAvatar(id);

          set((state) => {
            const newChats = { ...state.chats };
            delete newChats[id];

            const newAvatars = state.avatars.filter((a) => a.id !== id);
            const newActiveId = state.activeAvatarId === id
              ? newAvatars[0]?.id || null
              : state.activeAvatarId;

            return {
              avatars: newAvatars,
              chats: newChats,
              activeAvatarId: newActiveId,
              isLoading: false,
            };
          });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to delete avatar',
          });
          throw error;
        }
      },

      setActiveAvatar: (id) => {
        set({ activeAvatarId: id });
      },

      fetchAvatars: async () => {
        set({ isLoading: true, error: null });

        try {
          const response = await api.listAvatars();

          const avatars: Avatar[] = response.map((r) => ({
            id: r.avatarId,
            name: r.name,
            description: r.description,
            persona: r.persona,
            avatar: r.profileImage?.url || generateAvatarImage(r.avatarId),
            color: getRandomColor(),
            secrets: [],
            status: r.status,
            creatorWallet: r.creatorWallet,
            slotType: r.slotType,
            orbMint: r.orbMint,
            orbWallet: r.orbWallet,
            orbSlottedAt: r.orbSlottedAt,
            platforms: r.platforms,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }));

          set((state) => ({
            avatars,
            // Initialize chats for new avatars
            chats: avatars.reduce((acc, avatar) => {
              acc[avatar.id] = state.chats[avatar.id] || [{
                id: 'welcome',
                role: 'assistant',
                content: `Hi! I'm **${avatar.name}**. Talk to me to configure my integrations!`,
                timestamp: Date.now(),
              }];
              return acc;
            }, {} as Record<string, ChatMessage[]>),
            activeAvatarId: state.activeAvatarId || avatars[0]?.id || null,
            isLoading: false,
          }));
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to fetch avatars',
          });
        }
      },

      addMessage: (avatarId, message) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [avatarId]: [
              ...(state.chats[avatarId] || []),
              {
                ...message,
                id: generateId(),
                timestamp: Date.now(),
              },
            ],
          },
        }));
      },

      updateMessage: (avatarId, messageId, updates) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [avatarId]: (state.chats[avatarId] || []).map((m) =>
              m.id === messageId ? { ...m, ...updates } : m
            ),
          },
        }));
      },

      removeMessage: (avatarId, messageId) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [avatarId]: (state.chats[avatarId] || []).filter((m) => m.id !== messageId),
          },
        }));
      },

      clearChat: async (avatarId) => {
        // Clear on backend too
        try {
          await apiClearChatHistory(avatarId);
        } catch (error) {
          console.error('Failed to clear chat on backend:', error instanceof Error ? error.message : String(error));
        }

        set((state) => ({
          chats: {
            ...state.chats,
            [avatarId]: [{
              id: 'welcome',
              role: 'assistant',
              content: `Chat cleared! How can I help you?`,
              timestamp: Date.now(),
            }],
          },
        }));
      },

      syncChatHistory: async (avatarId) => {
        try {
          const history = await apiFetchChatHistory(avatarId);

          if (history.length > 0) {
            // Convert backend history to ChatMessage format
            const messages: ChatMessage[] = history.map((msg, index) => {
              // Convert backend tool_calls to frontend toolCalls format
              // Backend stores arguments as JSON string, frontend expects parsed object
              const toolCalls = (msg as unknown as { tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }).tool_calls?.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: (() => {
                  try {
                    return JSON.parse(tc.function.arguments);
                  } catch {
                    return {};
                  }
                })(),
                // Restored tool calls from history are already completed (user interacted with them)
                status: 'completed' as const,
              }));

              return {
                id: `synced-${index}`,
                role: (msg.role === 'tool' ? 'assistant' : msg.role) as 'user' | 'assistant',
                content: msg.content,
                thinking: (msg as unknown as { thinking?: string[] }).thinking,
                isToolResult: msg.role === 'tool',
                timestamp: Date.now() - (history.length - index) * 1000,
                // Include media if present (for images to persist across refresh)
                media: msg.media,
                // Include tool calls if present (for interactive prompts to show in history)
                toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
              };
            });

            set((state) => ({
              chats: {
                ...state.chats,
                [avatarId]: messages,
              },
            }));
          }
        } catch (error) {
          console.error('Failed to sync chat history:', error instanceof Error ? error.message : String(error));
        }
      },

      setChat: (avatarId, messages) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [avatarId]: messages,
          },
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),
    }),
    {
      name: 'swarm-avatars',
      version: 3,
      // Only persist avatar metadata and active selection
      // Chat history is synced from backend (source of truth for cross-device)
      partialize: (state) => ({
        avatars: state.avatars,
        // Don't persist chats - always sync from backend
        activeAvatarId: state.activeAvatarId,
      }),
    }
  )
);

// Stable empty array to avoid new references when there is no chat
const EMPTY_MESSAGES: ChatMessage[] = [];

// Selectors — use targeted zustand subscriptions to avoid
// re-rendering consumers on unrelated store changes.
export const useActiveAvatar = () =>
  useAvatarStore((state) =>
    state.activeAvatarId
      ? state.avatars.find((a) => a.id === state.activeAvatarId)
      : undefined
  );

export const useActiveChat = () =>
  useAvatarStore((state) =>
    state.activeAvatarId
      ? state.chats[state.activeAvatarId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES
  );
