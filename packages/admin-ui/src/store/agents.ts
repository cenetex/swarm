/**
 * Agent Store - Manages multiple agents and their chats
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Agent, ChatMessage } from '../types';

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
const generateAvatar = (seed: string) => 
  `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;

interface AgentState {
  agents: Agent[];
  chats: Record<string, ChatMessage[]>;
  activeAgentId: string | null;
  isLoading: boolean;
  error: string | null;

  // Agent management
  createAgent: (name?: string) => Agent;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  deleteAgent: (id: string) => void;
  setActiveAgent: (id: string | null) => void;
  
  // Chat management
  addMessage: (agentId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (agentId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  removeMessage: (agentId: string, messageId: string) => void;
  clearChat: (agentId: string) => void;
  
  // UI state
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      agents: [],
      chats: {},
      activeAgentId: null,
      isLoading: false,
      error: null,

      createAgent: (name?: string) => {
        const id = generateId();
        const agentName = name || `Agent ${get().agents.length + 1}`;
        
        const agent: Agent = {
          id,
          name: agentName,
          avatar: generateAvatar(id),
          color: getRandomColor(),
          secrets: [],
          status: 'shell',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        set((state) => ({
          agents: [...state.agents, agent],
          chats: {
            ...state.chats,
            [id]: [{
              id: 'welcome',
              role: 'assistant',
              content: `Hi! I'm **${agentName}**. I'm a new agent shell - configure me with a persona and secrets to give me unique capabilities!`,
              timestamp: Date.now(),
            }],
          },
          activeAgentId: id,
        }));

        return agent;
      },

      updateAgent: (id, updates) => {
        set((state) => ({
          agents: state.agents.map((a) =>
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

      deleteAgent: (id) => {
        set((state) => {
          const newChats = { ...state.chats };
          delete newChats[id];
          
          const newAgents = state.agents.filter((a) => a.id !== id);
          const newActiveId = state.activeAgentId === id 
            ? newAgents[0]?.id || null 
            : state.activeAgentId;

          return {
            agents: newAgents,
            chats: newChats,
            activeAgentId: newActiveId,
          };
        });
      },

      setActiveAgent: (id) => {
        set({ activeAgentId: id });
      },

      addMessage: (agentId, message) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [agentId]: [
              ...(state.chats[agentId] || []),
              {
                ...message,
                id: generateId(),
                timestamp: Date.now(),
              },
            ],
          },
          agents: state.agents.map((a) =>
            a.id === agentId ? { ...a, lastActivity: Date.now() } : a
          ),
        }));
      },

      updateMessage: (agentId, messageId, updates) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [agentId]: (state.chats[agentId] || []).map((m) =>
              m.id === messageId ? { ...m, ...updates } : m
            ),
          },
        }));
      },

      removeMessage: (agentId, messageId) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [agentId]: (state.chats[agentId] || []).filter((m) => m.id !== messageId),
          },
        }));
      },

      clearChat: (agentId) => {
        set((state) => ({
          chats: {
            ...state.chats,
            [agentId]: [{
              id: 'welcome',
              role: 'assistant',
              content: `Chat cleared! How can I help you?`,
              timestamp: Date.now(),
            }],
          },
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),
    }),
    {
      name: 'swarm-agents',
      partialize: (state) => ({
        agents: state.agents,
        chats: state.chats,
        activeAgentId: state.activeAgentId,
      }),
    }
  )
);

// Selectors
export const useActiveAgent = () => {
  const { agents, activeAgentId } = useAgentStore();
  return agents.find((a) => a.id === activeAgentId);
};

export const useActiveChat = () => {
  const { chats, activeAgentId } = useAgentStore();
  return activeAgentId ? chats[activeAgentId] || [] : [];
};
