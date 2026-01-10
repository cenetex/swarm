/**
 * Agent Store - Manages multiple agents and their chats
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Agent, ChatMessage } from '../types';
import * as api from '../api/agents';

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
  createAgent: (name?: string) => Promise<Agent>;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  deleteAgent: (id: string) => Promise<void>;
  setActiveAgent: (id: string | null) => void;
  fetchAgents: () => Promise<void>;

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

      createAgent: async (name?: string) => {
        const agentName = name || `Agent ${get().agents.length + 1}`;
        set({ isLoading: true, error: null });

        try {
          // Create agent on backend first
          const response = await api.createAgent(agentName);

          const agent: Agent = {
            id: response.agentId,
            name: response.name,
            description: response.description,
            persona: response.persona,
            avatar: generateAvatar(response.agentId),
            color: getRandomColor(),
            secrets: [],
            status: response.status,
            createdAt: response.createdAt,
            updatedAt: response.updatedAt,
          };

          set((state) => ({
            agents: [...state.agents, agent],
            chats: {
              ...state.chats,
              [agent.id]: [{
                id: 'welcome',
                role: 'assistant',
                content: `Hi! I'm **${agentName}**. I'm a new agent - talk to me to configure my integrations and capabilities!`,
                timestamp: Date.now(),
              }],
            },
            activeAgentId: agent.id,
            isLoading: false,
          }));

          return agent;
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to create agent',
          });
          throw error;
        }
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

      deleteAgent: async (id) => {
        set({ isLoading: true, error: null });

        try {
          // Delete from backend first
          await api.deleteAgent(id);

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
              isLoading: false,
            };
          });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to delete agent',
          });
          throw error;
        }
      },

      setActiveAgent: (id) => {
        set({ activeAgentId: id });
      },

      fetchAgents: async () => {
        set({ isLoading: true, error: null });

        try {
          const response = await api.listAgents();

          const agents: Agent[] = response.map((r) => ({
            id: r.agentId,
            name: r.name,
            description: r.description,
            persona: r.persona,
            avatar: generateAvatar(r.agentId),
            color: getRandomColor(),
            secrets: [],
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }));

          set((state) => ({
            agents,
            // Initialize chats for new agents
            chats: agents.reduce((acc, agent) => {
              acc[agent.id] = state.chats[agent.id] || [{
                id: 'welcome',
                role: 'assistant',
                content: `Hi! I'm **${agent.name}**. Talk to me to configure my integrations!`,
                timestamp: Date.now(),
              }];
              return acc;
            }, {} as Record<string, ChatMessage[]>),
            activeAgentId: state.activeAgentId || agents[0]?.id || null,
            isLoading: false,
          }));
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to fetch agents',
          });
        }
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
