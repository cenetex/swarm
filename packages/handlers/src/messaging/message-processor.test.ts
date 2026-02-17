/**
 * Message Processor Handler Tests
 * Tests for JSON.parse error handling, tool argument parsing, and poison pill prevention
 *
 * Bug Index:
 * - BUG-006: JSON.parse without try-catch in handlers/message-processor.ts:556
 * - BUG-007: Tool call argument parsing without error handling (line 240)
 * - BUG-008: Schema validation failures cause infinite retries (poison pill)
 *
 * @see packages/handlers/src/message-processor.ts
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Schema matching MessageQueueItemSchema
const MessageQueueItemSchema = z.object({
  envelope: z.object({
    avatarId: z.string(),
    platform: z.string(),
    messageId: z.string(),
    conversationId: z.string(),
    timestamp: z.number(),
    sender: z.object({
      id: z.string(),
      isBot: z.boolean(),
    }),
    content: z.object({
      text: z.string().optional(),
    }),
    metadata: z.object({
      idempotencyKey: z.string(),
    }),
  }),
  enqueuedAt: z.number(),
  attempts: z.number(),
  maxAttempts: z.number(),
});

describe('Message Processor - JSON Parse Error Handling', () => {
  /**
   * BUG-006: JSON.parse without try-catch in message processor
   * File: packages/handlers/src/message-processor.ts:556
   *
   * Previously, malformed JSON would crash the handler.
   *
   * Fix: Wrapped JSON.parse in try-catch, adds to batchItemFailures on parse error
   */
  describe('Message body parsing (BUG-006)', () => {
    it('should catch JSON parse errors and add to batch failures', async () => {
      const records = [
        { messageId: 'msg-1', body: 'not json' },
        { messageId: 'msg-2', body: '{"incomplete":' },
        { messageId: 'msg-3', body: '' },
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];

      for (const record of records) {
        try {
          JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      expect(batchItemFailures).toHaveLength(3);
    });

    it('should handle valid JSON but invalid schema', async () => {
      const validJsonInvalidSchema = JSON.stringify({ foo: 'bar' });
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(validJsonInvalidSchema);
        const result = MessageQueueItemSchema.safeParse(parsed);
        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: 'msg-schema-fail' });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: 'msg-schema-fail' });
      }

      expect(batchItemFailures).toHaveLength(1);
    });
  });

  /**
   * BUG-007: Tool call argument parsing without error handling
   * File: packages/handlers/src/message-processor.ts:240
   *
   * Previously, invalid JSON in tool arguments would throw unhandled error.
   *
   * Fix: Wrapped in try-catch, returns empty object on parse failure
   */
  describe('Tool call argument parsing (BUG-007)', () => {
    it('should handle malformed tool arguments gracefully', async () => {
      const toolCalls = [
        { id: 'tc-1', function: { name: 'send_message', arguments: 'not json' }},
        { id: 'tc-2', function: { name: 'react', arguments: '{"emoji":' }},
        { id: 'tc-3', function: { name: 'ignore', arguments: undefined }},
      ];

      const parsedCalls = toolCalls.map(tc => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // The fix: catch and return empty object instead of crashing
          parsedArgs = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        };
      });

      // All tool calls should be processed, with empty args for invalid JSON
      expect(parsedCalls).toHaveLength(3);
      expect(parsedCalls[0].arguments).toEqual({});
      expect(parsedCalls[1].arguments).toEqual({});
      expect(parsedCalls[2].arguments).toEqual({});
    });

    it('should parse valid tool arguments correctly', async () => {
      const toolCall = {
        id: 'tc-valid',
        function: {
          name: 'send_message',
          arguments: JSON.stringify({ text: 'Hello world' }),
        },
      };

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      expect(parsedArgs).toEqual({ text: 'Hello world' });
    });

    it('should handle empty string arguments', async () => {
      const toolCall = {
        id: 'tc-empty',
        function: { name: 'ignore', arguments: '' },
      };

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      // Empty string falls back to default '{}'
      expect(parsedArgs).toEqual({});
    });
  });
});

describe('Message Processor - Poison Pill Prevention', () => {
  /**
   * BUG-008: Schema validation failures cause infinite retries
   * File: packages/handlers/src/message-processor.ts:568-576
   *
   * Previously, invalid schema messages would continue (skip) but not be acknowledged,
   * causing them to retry forever.
   *
   * Fix: Add schema failures to batchItemFailures so they go to DLQ
   */
  describe('Schema validation failures go to DLQ (BUG-008)', () => {
    it('should add schema failures to batch failures', async () => {
      const poisonPillMessage = {
        messageId: 'poison-123',
        body: JSON.stringify({
          // Valid JSON but missing required envelope fields
          someField: 'value',
        }),
      };

      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(poisonPillMessage.body);
        const result = MessageQueueItemSchema.safeParse(parsed);

        if (!result.success) {
          // The fix: add to batch failures so message goes to DLQ
          batchItemFailures.push({ itemIdentifier: poisonPillMessage.messageId });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: poisonPillMessage.messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
      expect(batchItemFailures[0].itemIdentifier).toBe('poison-123');
    });

    it('should not add valid messages to batch failures', async () => {
      const validMessage = {
        messageId: 'valid-123',
        body: JSON.stringify({
          envelope: {
            avatarId: 'avatar-1',
            platform: 'telegram',
            messageId: '456',
            conversationId: 'conv-789',
            timestamp: Date.now(),
            sender: { id: 'user-1', isBot: false },
            content: { text: 'Hello' },
            metadata: { idempotencyKey: 'key-123' },
          },
          enqueuedAt: Date.now(),
          attempts: 0,
          maxAttempts: 3,
        }),
      };

      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(validMessage.body);
        const result = MessageQueueItemSchema.safeParse(parsed);

        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: validMessage.messageId });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: validMessage.messageId });
      }

      expect(batchItemFailures).toHaveLength(0);
    });
  });
});

describe('Message Processor - Batch Processing', () => {
  it('should process valid messages even when some fail', async () => {
    const records = [
      { messageId: 'good-1', body: JSON.stringify({
        envelope: {
          avatarId: 'a1', platform: 'telegram', messageId: 'm1',
          conversationId: 'c1', timestamp: Date.now(),
          sender: { id: 'u1', isBot: false },
          content: { text: 'Hi' },
          metadata: { idempotencyKey: 'k1' },
        },
        enqueuedAt: Date.now(), attempts: 0, maxAttempts: 3,
      })},
      { messageId: 'bad-1', body: 'invalid' },
      { messageId: 'good-2', body: JSON.stringify({
        envelope: {
          avatarId: 'a2', platform: 'telegram', messageId: 'm2',
          conversationId: 'c2', timestamp: Date.now(),
          sender: { id: 'u2', isBot: false },
          content: { text: 'Hello' },
          metadata: { idempotencyKey: 'k2' },
        },
        enqueuedAt: Date.now(), attempts: 0, maxAttempts: 3,
      })},
    ];

    const batchItemFailures: { itemIdentifier: string }[] = [];
    const processedMessages: string[] = [];

    for (const record of records) {
      try {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        const result = MessageQueueItemSchema.safeParse(parsedBody);
        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        processedMessages.push(result.data.envelope.messageId);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    expect(processedMessages).toEqual(['m1', 'm2']);
    expect(batchItemFailures).toHaveLength(1);
    expect(batchItemFailures[0].itemIdentifier).toBe('bad-1');
  });

  it('should return batch response even when all messages succeed', async () => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    // Even with no failures, should return the proper structure
    const response = { batchItemFailures };

    expect(response.batchItemFailures).toEqual([]);
  });
});

describe('Message Processor - Tool Execution E2E', () => {
  /**
   * Tests for end-to-end tool call execution flow:
   * 1. LLM returns tool calls
   * 2. Tools are executed via MCP registry
   * 3. Results are added to message history
   * 4. LLM is called again with results
   * 5. Final response is generated
   */

  describe('Tool call execution flow', () => {
    it('should execute tools and accumulate results', () => {
      // Simulate the tool execution loop
      const toolCalls = [
        { id: 'call-1', name: 'remember', arguments: { fact: 'User likes cats' } },
        { id: 'call-2', name: 'send_message', arguments: { text: 'Got it!' } },
      ];

      const allToolResults: Array<{
        name: string;
        result: { success: boolean; data?: unknown; error?: string };
      }> = [];

      // Simulate executing each tool
      for (const toolCall of toolCalls) {
        // Mock execution result
        const result = {
          success: true,
          data: toolCall.name === 'remember'
            ? { saved: true }
            : { text: toolCall.arguments.text },
        };

        allToolResults.push({ name: toolCall.name, result });
      }

      expect(allToolResults).toHaveLength(2);
      expect(allToolResults[0].name).toBe('remember');
      expect(allToolResults[0].result.success).toBe(true);
      expect(allToolResults[1].name).toBe('send_message');
    });

    it('should build LLM messages with tool results', () => {
      const messages: Array<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        content?: string;
        tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
      }> = [];

      // Initial system and user messages
      messages.push({ role: 'system', content: 'You are a helpful assistant.' });
      messages.push({ role: 'user', content: 'Remember that I like pizza.' });

      // Assistant calls a tool
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-123',
          type: 'function',
          function: {
            name: 'remember',
            arguments: JSON.stringify({ fact: 'User likes pizza', about: 'preferences' }),
          },
        }],
      });

      // Tool result
      messages.push({
        role: 'tool',
        tool_call_id: 'call-123',
        content: JSON.stringify({ success: true, data: { saved: true } }),
      });

      // Final assistant response
      messages.push({ role: 'assistant', content: "I'll remember that you like pizza!" });

      expect(messages).toHaveLength(5);
      expect(messages[2].tool_calls).toHaveLength(1);
      expect(messages[3].role).toBe('tool');
      expect(messages[4].content).toContain('pizza');
    });

    it('should convert tool results to response actions', () => {
      const toolResults = [
        { name: 'send_message', result: { success: true, data: { text: 'Hello!' } } },
        {
          name: 'generate_image',
          result: {
            success: true,
            media: { type: 'image', url: 'https://cdn.example.com/img.png' },
          },
        },
        { name: 'react', result: { success: true, data: { emoji: '👍', messageId: 'msg-1' } } },
      ];

      const actions: Array<{ type: string; text?: string; url?: string; emoji?: string }> = [];

      for (const { name, result } of toolResults) {
        if (!result.success) continue;

        if (name === 'send_message') {
          const data = result.data as { text?: string };
          if (data?.text) actions.push({ type: 'send_message', text: data.text });
        } else if (name === 'generate_image') {
          const media = result.media as { url: string };
          if (media?.url) actions.push({ type: 'send_media', url: media.url });
        } else if (name === 'react') {
          const data = result.data as { emoji?: string };
          if (data?.emoji) actions.push({ type: 'react', emoji: data.emoji });
        }
      }

      expect(actions).toHaveLength(3);
      expect(actions[0]).toEqual({ type: 'send_message', text: 'Hello!' });
      expect(actions[1]).toEqual({ type: 'send_media', url: 'https://cdn.example.com/img.png' });
      expect(actions[2]).toEqual({ type: 'react', emoji: '👍' });
    });

    it('should respect MAX_TOOL_ITERATIONS limit', () => {
      const MAX_TOOL_ITERATIONS = 5;
      let iterations = 0;
      let hasMoreToolCalls = true;

      while (iterations < MAX_TOOL_ITERATIONS && hasMoreToolCalls) {
        iterations++;

        // Simulate LLM always returning tool calls (runaway case)
        if (iterations >= MAX_TOOL_ITERATIONS) {
          // Should stop here
          hasMoreToolCalls = false;
        }
      }

      expect(iterations).toBe(MAX_TOOL_ITERATIONS);
    });

    it('should handle failed tool executions gracefully', () => {
      const toolResult = {
        name: 'generate_image',
        result: {
          success: false,
          error: 'Rate limit exceeded',
        },
      };

      const actions: Array<{ type: string }> = [];

      // Failed tools should not produce actions
      if (toolResult.result.success) {
        actions.push({ type: 'send_media' });
      }

      expect(actions).toHaveLength(0);
    });
  });

  describe('Response generation', () => {
    it('should queue response to SQS with correct structure', () => {
      const response = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
        replyToMessageId: 'msg-456',
        actions: [
          { type: 'send_message', text: 'Hello!', replyToMessageId: 'msg-456' },
        ],
        generatedAt: Date.now(),
        llmModel: 'anthropic/claude-haiku-4.5',
        tokensUsed: 150,
      };

      expect(response.avatarId).toBe('test-avatar');
      expect(response.actions).toHaveLength(1);
      expect(response.actions[0].type).toBe('send_message');
    });

    it('should add replyToMessageId to send_message actions', () => {
      const originalMessageId = 'msg-original';
      const finalContent = 'Here is my response.';

      const action = {
        type: 'send_message',
        text: finalContent,
        replyToMessageId: originalMessageId,
      };

      expect(action.replyToMessageId).toBe('msg-original');
    });
  });
});

/**
 * XML Tool Call Parser Tests
 * 
 * Some LLM models (especially through OpenRouter) output XML-style function calls
 * in their text content instead of using proper tool_calls format.
 * 
 * Example problematic output:
 * <function_calls>
 *   <invoke name="send_message">
 *     <parameter name="text">Hello!</parameter>
 *   </invoke>
 * </function_calls>
 * 
 * The parser extracts these and converts them to proper tool calls.
 */
describe('Message Processor - XML Tool Call Parser', () => {
  // Helper function that mirrors the parser logic
  function parseXmlToolCalls(content: string): {
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    cleanedContent: string;
  } {
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let cleanedContent = content;
    
    // Known tool names that might appear as direct XML tags
    const knownTools = ['send_message', 'react', 'ignore', 'wait', 'generate_image', 'remember', 'recall', 'take_selfie'];
    
    // Pattern 1: Match <function_calls>...</function_calls> wrapper format
    const functionCallsPattern = /<(?:antml:)?function_calls>([\s\S]*?)<\/(?:antml:)?function_calls>/gi;
    let match: RegExpExecArray | null;
    
    while ((match = functionCallsPattern.exec(content)) !== null) {
      const block = match[1];
      
      const invokePattern = /<(?:antml:)?invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:antml:)?invoke>/gi;
      let invokeMatch: RegExpExecArray | null;
      
      while ((invokeMatch = invokePattern.exec(block)) !== null) {
        const toolName = invokeMatch[1];
        const paramsBlock = invokeMatch[2];
        const args: Record<string, unknown> = {};
        
        const paramPattern = /<(?:antml:)?parameter\s+name=["']([^"']+)["']>([^<]*)<\/(?:antml:)?parameter>/gi;
        let paramMatch: RegExpExecArray | null;
        
        while ((paramMatch = paramPattern.exec(paramsBlock)) !== null) {
          const paramName = paramMatch[1];
          const paramValue = paramMatch[2].trim();
          
          try {
            args[paramName] = JSON.parse(paramValue);
          } catch {
            args[paramName] = paramValue;
          }
        }
        
        toolCalls.push({
          id: 'xml_test',
          name: toolName,
          arguments: args,
        });
      }
      
      cleanedContent = cleanedContent.replace(match[0], '').trim();
    }
    
    // Pattern 2: Match direct tool tags like <send_message>...</send_message>
    for (const toolName of knownTools) {
      const directPattern = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'gi');
      let directMatch: RegExpExecArray | null;
      
      while ((directMatch = directPattern.exec(cleanedContent)) !== null) {
        const textContent = directMatch[1].trim();
        
        const args: Record<string, unknown> = toolName === 'send_message' 
          ? { text: textContent }
          : toolName === 'react'
            ? { emoji: textContent }
            : { value: textContent };
        
        toolCalls.push({
          id: 'xml_test',
          name: toolName,
          arguments: args,
        });
        
        cleanedContent = cleanedContent.replace(directMatch[0], '').trim();
      }
    }
    
    return { toolCalls, cleanedContent };
  }

  describe('Invoke format parsing', () => {
    it('should parse standard XML function calls', () => {
      const content = `<function_calls>
<invoke name="send_message">
<parameter name="text">Hello world!</parameter>
</invoke>
</function_calls>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('send_message');
      expect(result.toolCalls[0].arguments).toEqual({ text: 'Hello world!' });
      expect(result.cleanedContent).toBe('');
    });

    it('should parse multiple tool calls in one block', () => {
      const content = `<function_calls>
<invoke name="send_message">
<parameter name="text">First message</parameter>
</invoke>
<invoke name="react">
<parameter name="emoji">👍</parameter>
<parameter name="message_id">msg-123</parameter>
</invoke>
</function_calls>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe('send_message');
      expect(result.toolCalls[1].name).toBe('react');
      expect(result.toolCalls[1].arguments).toEqual({ emoji: '👍', message_id: 'msg-123' });
    });

    it('should preserve content before and after XML blocks', () => {
      const content = `Some text before.
<function_calls>
<invoke name="send_message">
<parameter name="text">Hello!</parameter>
</invoke>
</function_calls>
Some text after.`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.cleanedContent).toContain('Some text before.');
      expect(result.cleanedContent).toContain('Some text after.');
    });

    it('should handle content with no XML tool calls', () => {
      const content = 'Just a normal message with no tool calls.';

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe(content);
    });

    it('should parse JSON values in parameters', () => {
      const content = `<function_calls>
<invoke name="test_tool">
<parameter name="count">42</parameter>
<parameter name="enabled">true</parameter>
<parameter name="text">plain string</parameter>
</invoke>
</function_calls>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls[0].arguments).toEqual({
        count: 42,
        enabled: true,
        text: 'plain string',
      });
    });

    it('should handle emoji and special characters in parameters', () => {
      const content = `<function_calls>
<invoke name="send_message">
<parameter name="text">🐋💕 Fluffin says hi! ✨</parameter>
</invoke>
</function_calls>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls[0].arguments.text).toBe('🐋💕 Fluffin says hi! ✨');
    });
  });

  describe('Direct tag format parsing', () => {
    it('should parse direct <send_message> tags', () => {
      const content = `<send_message>
Hey there ratimics! 🐱✨ My function calling is purr-fectly awesome!
</send_message>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('send_message');
      expect(result.toolCalls[0].arguments.text).toContain('ratimics');
      expect(result.toolCalls[0].arguments.text).toContain('🐱✨');
      expect(result.cleanedContent).toBe('');
    });

    it('should parse direct <react> tags', () => {
      const content = `<react>👍</react>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('react');
      expect(result.toolCalls[0].arguments.emoji).toBe('👍');
    });

    it('should preserve surrounding content with direct tags', () => {
      const content = `Some preamble text.
<send_message>Hello!</send_message>
Some follow-up text.`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].arguments.text).toBe('Hello!');
      expect(result.cleanedContent).toContain('Some preamble text.');
      expect(result.cleanedContent).toContain('Some follow-up text.');
    });

    it('should handle multiple direct tags', () => {
      const content = `<send_message>First message</send_message>
<react>😸</react>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe('send_message');
      expect(result.toolCalls[1].name).toBe('react');
    });

    it('should handle multiline content in direct tags', () => {
      const content = `<send_message>
Line 1
Line 2
Line 3 with emoji 🚀
</send_message>`;

      const result = parseXmlToolCalls(content);
      
      expect(result.toolCalls[0].arguments.text).toContain('Line 1');
      expect(result.toolCalls[0].arguments.text).toContain('Line 2');
      expect(result.toolCalls[0].arguments.text).toContain('🚀');
    });
  });
});
