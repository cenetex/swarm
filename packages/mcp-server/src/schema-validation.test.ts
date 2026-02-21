/**
 * Schema Validation Tests
 *
 * Tests for Zod schema validation and JSON schema generation.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
const zodToJsonSchema = (schema: any) => { const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>; return rest; };
import { ToolRegistry, defineTool } from './registry.js';

describe('Schema Validation - Basic Types', () => {
  it('validates string fields correctly', () => {
    const schema = z.object({
      name: z.string(),
    });

    const valid = schema.safeParse({ name: 'test' });
    const invalid = schema.safeParse({ name: 123 });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates number fields correctly', () => {
    const schema = z.object({
      count: z.number(),
    });

    const valid = schema.safeParse({ count: 42 });
    const invalid = schema.safeParse({ count: '42' });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates boolean fields correctly', () => {
    const schema = z.object({
      enabled: z.boolean(),
    });

    const valid = schema.safeParse({ enabled: true });
    const invalid = schema.safeParse({ enabled: 'true' });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates enum fields correctly', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
    });

    const valid = schema.safeParse({ status: 'active' });
    const invalid = schema.safeParse({ status: 'unknown' });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});

describe('Schema Validation - Optional vs Required', () => {
  it('requires fields by default', () => {
    const schema = z.object({
      required: z.string(),
    });

    const valid = schema.safeParse({ required: 'value' });
    const missing = schema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('allows optional fields to be omitted', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const withOptional = schema.safeParse({ required: 'value', optional: 'opt' });
    const withoutOptional = schema.safeParse({ required: 'value' });

    expect(withOptional.success).toBe(true);
    expect(withoutOptional.success).toBe(true);
  });

  it('applies default values correctly', () => {
    const schema = z.object({
      value: z.string().default('default'),
    });

    const result = schema.parse({});
    expect(result.value).toBe('default');
  });
});

describe('Schema Validation - Nested Objects', () => {
  it('validates nested object schemas', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    });

    const valid = schema.safeParse({
      user: { name: 'Alice', age: 30 },
    });
    const invalid = schema.safeParse({
      user: { name: 'Alice' },
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates array schemas', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const valid = schema.safeParse({ tags: ['a', 'b', 'c'] });
    const invalid = schema.safeParse({ tags: ['a', 123] });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates array length constraints', () => {
    const schema = z.object({
      items: z.array(z.string()).min(1).max(3),
    });

    const valid = schema.safeParse({ items: ['a', 'b'] });
    const tooFew = schema.safeParse({ items: [] });
    const tooMany = schema.safeParse({ items: ['a', 'b', 'c', 'd'] });

    expect(valid.success).toBe(true);
    expect(tooFew.success).toBe(false);
    expect(tooMany.success).toBe(false);
  });
});

describe('Schema Validation - Constraints', () => {
  it('validates string min/max length', () => {
    const schema = z.object({
      text: z.string().min(3).max(10),
    });

    const valid = schema.safeParse({ text: 'hello' });
    const tooShort = schema.safeParse({ text: 'hi' });
    const tooLong = schema.safeParse({ text: 'this is too long' });

    expect(valid.success).toBe(true);
    expect(tooShort.success).toBe(false);
    expect(tooLong.success).toBe(false);
  });

  it('validates number min/max values', () => {
    const schema = z.object({
      count: z.number().min(1).max(100),
    });

    const valid = schema.safeParse({ count: 50 });
    const tooLow = schema.safeParse({ count: 0 });
    const tooHigh = schema.safeParse({ count: 101 });

    expect(valid.success).toBe(true);
    expect(tooLow.success).toBe(false);
    expect(tooHigh.success).toBe(false);
  });

  it('validates email format', () => {
    const schema = z.object({
      email: z.string().email(),
    });

    const valid = schema.safeParse({ email: 'user@example.com' });
    const invalid = schema.safeParse({ email: 'not-an-email' });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});

describe('JSON Schema Generation', () => {
  it('generates valid JSON schema for simple objects', () => {
    const zodSchema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' });

    expect(jsonSchema).toHaveProperty('type', 'object');
    expect(jsonSchema).toHaveProperty('properties');
    expect((jsonSchema as any).properties.name).toHaveProperty('type', 'string');
    expect((jsonSchema as any).properties.age).toHaveProperty('type', 'number');
  });

  it('includes descriptions in JSON schema', () => {
    const zodSchema = z.object({
      name: z.string().describe('User name'),
    });

    const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' });

    expect((jsonSchema as any).properties.name.description).toBe('User name');
  });

  it('marks required fields in JSON schema', () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' }) as any;

    expect(jsonSchema.required).toContain('required');
    expect(jsonSchema.required).not.toContain('optional');
  });

  it('handles enum types in JSON schema', () => {
    const zodSchema = z.object({
      status: z.enum(['active', 'inactive']),
    });

    const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' }) as any;

    expect(jsonSchema.properties.status.enum).toEqual(['active', 'inactive']);
  });
});

describe('Tool Schema Integration', () => {
  it('validates tool input against defined schema', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: z.object({
        value: z.number().min(1).max(10),
      }),
      execute: async (input) => ({ success: true, data: input }),
    }));

    const validResult = await registry.execute('test_tool', { value: 5 }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });
    const invalidResult = await registry.execute('test_tool', { value: 100 }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toContain('Validation error');
  });

  it('provides detailed validation error messages', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: z.object({
        email: z.string().email(),
        age: z.number().min(18),
      }),
      execute: async (input) => ({ success: true, data: input }),
    }));

    const result = await registry.execute('test_tool', {
      email: 'invalid',
      age: 10,
    }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.data).toHaveProperty('errorType', 'validation_error');
    expect(result.data).toHaveProperty('retryable', true);
    expect((result.data as any).issues).toBeInstanceOf(Array);
  });
});
