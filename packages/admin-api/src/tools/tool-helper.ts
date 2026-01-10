/**
 * Tool helper utilities for creating type-safe tools with Zod
 *
 * Uses standard Zod (not the OpenRouter SDK's Zod v4 internals)
 * Provides similar API but works with any Zod version.
 */
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Tool definition with Zod schema for type-safe input validation
 */
export interface ToolDefinition<TInput extends ZodObject<ZodRawShape>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: ((params: z.infer<TInput>) => Promise<TOutput> | TOutput) | false;
}

/**
 * Create a tool with type-safe input validation
 *
 * @example
 * ```typescript
 * const myTool = defineTool({
 *   name: 'my_tool',
 *   description: 'Does something',
 *   inputSchema: z.object({
 *     param1: z.string(),
 *   }),
 *   execute: async ({ param1 }) => {
 *     return { success: true };
 *   },
 * });
 * ```
 */
export function defineTool<TInput extends ZodObject<ZodRawShape>, TOutput = unknown>(
  config: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return config;
}

/**
 * Convert a tool definition to OpenAI function calling format
 */
export function toOpenAITool<TInput extends ZodObject<ZodRawShape>>(
  tool: ToolDefinition<TInput, unknown>
): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' });

  // Remove the $schema property that zodToJsonSchema adds
  const { $schema, ...parameters } = jsonSchema as Record<string, unknown>;

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}

/**
 * Execute a tool with validated input
 *
 * @param tool - The tool definition
 * @param rawInput - Raw input (usually from LLM JSON)
 * @returns The tool execution result
 * @throws If input validation fails or execute is false
 */
export async function executeTool<TInput extends ZodObject<ZodRawShape>, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  rawInput: unknown
): Promise<TOutput> {
  if (tool.execute === false) {
    throw new Error(`Tool ${tool.name} is manual and cannot be auto-executed`);
  }

  // Validate input with Zod
  const parseResult = tool.inputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new Error(`Invalid input for tool ${tool.name}: ${parseResult.error.message}`);
  }

  return tool.execute(parseResult.data);
}

/**
 * Check if a tool is manual (requires user interaction)
 */
export function isManualTool<TInput extends ZodObject<ZodRawShape>>(
  tool: ToolDefinition<TInput, unknown>
): boolean {
  return tool.execute === false;
}

/**
 * Convert multiple tools to OpenAI format
 */
export function toOpenAITools(
  tools: ToolDefinition<ZodObject<ZodRawShape>, unknown>[]
): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map(toOpenAITool);
}
