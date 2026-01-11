/**
 * Memory Tools
 * 
 * Tools for remembering and recalling facts about users and conversations.
 * This enables agents to build persistent memory across interactions.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Fact stored in memory
 */
export interface MemoryFact {
  fact: string;
  about?: string;
  userId?: string;
  timestamp: number;
}

/**
 * Memory services required by these tools
 */
export interface MemoryServices {
  /**
   * Save a fact to memory
   */
  remember: (fact: string, about?: string, userId?: string) => Promise<{ saved: boolean }>;

  /**
   * Recall facts from memory
   */
  recall: (query: string, userId?: string) => Promise<{ facts: MemoryFact[] }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMemoryTools = (memory: MemoryServices) => [
  defineTool({
    name: 'remember',
    description: 'Save an important fact about a user or topic to remember for future conversations. Use this to build persistent memory about users, their preferences, and important details.',
    category: 'readonly',
    inputSchema: z.object({
      fact: z.string().min(1).describe('The fact to remember (e.g., "User prefers dark themes" or "Alice\'s birthday is March 15")'),
      about: z.string().optional().describe('Who or what this fact is about (e.g., username, topic, or "general")'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await memory.remember(input.fact, input.about, context.userId);
        return {
          success: true,
          data: {
            saved: result.saved,
            message: 'Fact saved to memory',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save fact',
        };
      }
    },
  }),

  defineTool({
    name: 'recall',
    description: 'Search your memory for previously saved facts about a user or topic. Use this to remember things about users before responding.',
    category: 'readonly',
    inputSchema: z.object({
      query: z.string().min(1).describe('What to search for (e.g., a username, topic, or keyword)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await memory.recall(input.query, context.userId);
        
        if (result.facts.length === 0) {
          return {
            success: true,
            data: {
              found: false,
              message: `No facts found about "${input.query}"`,
              facts: [],
            },
          };
        }

        return {
          success: true,
          data: {
            found: true,
            count: result.facts.length,
            facts: result.facts.map(f => ({
              fact: f.fact,
              about: f.about,
              savedAt: new Date(f.timestamp).toISOString(),
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recall facts',
        };
      }
    },
  }),
];
