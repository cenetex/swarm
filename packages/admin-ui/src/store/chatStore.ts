import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isLoading?: boolean;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  
  // Actions
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content: `# Welcome to Swarm Admin! 🐝

I'm here to help you set up and manage your social media agents. Here's what I can do:

**Create & Configure Agents**
- Create new agents with custom names and personas
- Configure platform integrations (Telegram, Twitter/X, Discord)
- Set up LLM providers and models

**Manage Secrets (Securely)**
- Store API keys for platforms (Telegram, Twitter, Discord)
- Configure AI provider keys (OpenRouter, Anthropic, OpenAI, Replicate)
- Set global keys or per-agent keys for cost tracking
- Note: I can *set* secrets but never *read* them back - this is by design!

**Generate Crypto Wallets**
- Create Solana or Ethereum wallets
- Private keys are stored securely and never exposed

**Deploy to AWS**
- Deploy your configured agents to production

Try something like:
- "Create a new agent called CryptoBot"
- "Set up Telegram for my agent"
- "Generate a Solana wallet for trading"`,
      timestamp: Date.now(),
    },
  ],
  isLoading: false,
  error: null,

  addMessage: (message) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          ...message,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        },
      ],
    })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, ...updates } : msg
      ),
    })),

  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((msg) => msg.id !== id),
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  
  setError: (error) => set({ error }),
  
  clearMessages: () =>
    set({
      messages: [
        {
          id: 'welcome',
          role: 'assistant',
          content: "Chat cleared! How can I help you with your swarm?",
          timestamp: Date.now(),
        },
      ],
    }),
}));
