/**
 * Tool Schema Sanitization Tests
 *
 * Tests for sanitizeToolSchema and related schema validation to ensure
 * JSON Schema 2020-12 compliance for LLM provider dispatch.
 *
 * Covers: $schema removal, $ref inlining, type array conversion,
 * nullable handling, default removal, diagnostics logging.
 */
import { describe, it, expect } from 'vitest';
import { _sanitizeToolSchema, _validateToolSchema } from './chat-llm.js';

// Helper: cast sanitizeToolSchema output for easier assertions
function sanitize(schema: unknown): unknown {
  return _sanitizeToolSchema(schema);
}

describe('sanitizeToolSchema', () => {
  describe('basic pass-through', () => {
    it('should pass through simple object schemas unchanged', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };
      expect(sanitize(schema)).toEqual(schema);
    });

    it('should pass through primitive values', () => {
      expect(sanitize('hello')).toBe('hello');
      expect(sanitize(42)).toBe(42);
      expect(sanitize(true)).toBe(true);
      expect(sanitize(null)).toBeNull();
      expect(sanitize(undefined)).toBeUndefined();
    });

    it('should handle empty object schema', () => {
      expect(sanitize({})).toEqual({});
    });

    it('should sanitize arrays by mapping each element', () => {
      const arr = [
        { type: 'string', $schema: 'http://...' },
        { type: 'number' },
      ];
      const result = sanitize(arr) as unknown[];
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'string' });
      expect(result[1]).toEqual({ type: 'number' });
    });
  });

  describe('$schema removal', () => {
    it('should strip $schema from root', () => {
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('$schema');
      expect(result.type).toBe('object');
    });

    it('should strip $schema from nested schemas', () => {
      const schema = {
        type: 'object',
        properties: {
          inner: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { x: { type: 'string' } },
          },
        },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      const inner = (result.properties as Record<string, unknown>).inner as Record<string, unknown>;
      expect(inner).not.toHaveProperty('$schema');
      expect(inner.type).toBe('object');
    });
  });

  describe('nullable handling', () => {
    it('should convert nullable to anyOf pattern', () => {
      const schema = {
        type: 'number',
        nullable: true,
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('nullable');
      expect(result.anyOf).toEqual([
        { type: 'number' },
        { type: 'null' },
      ]);
    });

    it('should not add anyOf when nullable is false', () => {
      const schema = {
        type: 'string',
        nullable: false,
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('nullable');
      expect(result).not.toHaveProperty('anyOf');
      expect(result.type).toBe('string');
    });
  });

  describe('default removal', () => {
    it('should strip default values from schemas', () => {
      const schema = {
        type: 'string',
        enum: ['a', 'b'],
        default: 'a',
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('default');
      expect(result.type).toBe('string');
      expect(result.enum).toEqual(['a', 'b']);
    });

    it('should strip default from nested properties', () => {
      const schema = {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            default: 'auto',
          },
        },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      const mode = (result.properties as Record<string, unknown>).mode as Record<string, unknown>;
      expect(mode).not.toHaveProperty('default');
    });
  });

  describe('type array conversion', () => {
    it('should convert type array to anyOf', () => {
      const schema = {
        type: ['string', 'number'],
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('type');
      expect(result.anyOf).toEqual([
        { type: 'string' },
        { type: 'number' },
      ]);
    });

    it('should convert type array with null to anyOf', () => {
      const schema = {
        type: ['number', 'null'],
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result.anyOf).toEqual([
        { type: 'number' },
        { type: 'null' },
      ]);
    });

    it('should simplify single-element type array', () => {
      const schema = {
        type: ['string'],
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result.type).toBe('string');
      expect(result).not.toHaveProperty('anyOf');
    });

    it('should filter out invalid type values from type arrays', () => {
      const schema = {
        type: ['string', 'invalid_type', 'number'],
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result.anyOf).toEqual([
        { type: 'string' },
        { type: 'number' },
      ]);
    });

    it('should preserve other properties when converting type array', () => {
      const schema = {
        type: ['string', 'number'],
        description: 'A value',
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result.description).toBe('A value');
      expect(result.anyOf).toBeDefined();
    });
  });

  describe('$ref resolution', () => {
    it('should resolve $ref to sibling schema', () => {
      const schema = {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: { val: { type: 'string' } },
            required: ['val'],
            additionalProperties: false,
          },
          b: {
            $ref: '#/properties/a',
          },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      };
      const result = sanitize(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      // b should be inlined to match a
      expect(props.b).toEqual(props.a);
      expect(props.b).not.toHaveProperty('$ref');
    });

    it('should resolve $ref to definitions', () => {
      const schema = {
        type: 'object',
        definitions: {
          Address: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
        properties: {
          home: { $ref: '#/definitions/Address' },
        },
      };
      // definitions will be stripped, but $ref should be resolved first
      const result = sanitize(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.home).toEqual({
        type: 'object',
        properties: { city: { type: 'string' } },
      });
      // definitions should be stripped
      expect(result).not.toHaveProperty('definitions');
    });

    it('should fall back to {type: "object"} for unresolvable $ref', () => {
      const schema = {
        type: 'object',
        properties: {
          broken: { $ref: '#/nonexistent/path' },
        },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.broken).toEqual({ type: 'object' });
    });
  });

  describe('invalid type values', () => {
    it('should remove invalid type strings', () => {
      const schema = {
        type: 'invalid_type',
        description: 'test',
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('type');
      expect(result.description).toBe('test');
    });

    it('should keep valid type strings', () => {
      const validTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
      for (const t of validTypes) {
        const result = sanitize({ type: t }) as Record<string, unknown>;
        expect(result.type).toBe(t);
      }
    });
  });

  describe('definitions/$defs removal', () => {
    it('should strip definitions from root', () => {
      const schema = {
        type: 'object',
        definitions: {
          Foo: { type: 'string' },
        },
        properties: { name: { type: 'string' } },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('definitions');
    });

    it('should strip $defs from root', () => {
      const schema = {
        type: 'object',
        $defs: {
          Foo: { type: 'string' },
        },
        properties: { name: { type: 'string' } },
      };
      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('$defs');
    });
  });

  describe('complex real-world schemas', () => {
    it('should sanitize a zodToJsonSchema output with all constructs', () => {
      // Simulates output from zodToJsonSchema for a complex tool schema
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1 },
          aspectRatio: {
            type: 'string',
            enum: ['1:1', '16:9'],
            default: '1:1',
          },
          nullable_field: {
            type: ['number', 'null'],
          },
          shared_ref: {
            $ref: '#/properties/prompt',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      };

      const result = sanitize(schema) as Record<string, unknown>;

      // $schema removed
      expect(result).not.toHaveProperty('$schema');

      // default removed
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.aspectRatio).not.toHaveProperty('default');

      // type array converted to anyOf
      expect(props.nullable_field.anyOf).toEqual([
        { type: 'number' },
        { type: 'null' },
      ]);

      // $ref resolved
      expect(props.shared_ref).toEqual({ type: 'string', minLength: 1 });

      // Other properties preserved
      expect(result.type).toBe('object');
      expect(result.required).toEqual(['prompt']);
    });

    it('should handle discriminated union schemas', () => {
      const schema = {
        type: 'object',
        properties: {
          source: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'url' },
                  url: { type: 'string' },
                },
                required: ['type', 'url'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'file' },
                  path: { type: 'string' },
                },
                required: ['type', 'path'],
              },
            ],
          },
        },
        required: ['source'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      };

      const result = sanitize(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty('$schema');
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.source.anyOf).toHaveLength(2);
    });
  });
});

describe('validateToolSchema', () => {
  it('should return true for valid schemas', () => {
    expect(_validateToolSchema({ type: 'object' }, 'test_tool')).toBe(true);
    expect(_validateToolSchema({ anyOf: [{ type: 'string' }] }, 'test_tool')).toBe(true);
    expect(_validateToolSchema({ oneOf: [{ type: 'string' }] }, 'test_tool')).toBe(true);
    expect(_validateToolSchema({ allOf: [{ type: 'string' }] }, 'test_tool')).toBe(true);
  });

  it('should return false for schemas missing type/composition', () => {
    expect(_validateToolSchema({ properties: { name: { type: 'string' } } }, 'test_tool')).toBe(false);
  });

  it('should return false for schemas with unresolved $ref', () => {
    expect(_validateToolSchema({ type: 'object', properties: { x: { $ref: '#/bad' } } }, 'test_tool')).toBe(false);
  });

  it('should return false for schemas with leftover $schema', () => {
    expect(_validateToolSchema({ type: 'object', $schema: 'http://...' }, 'test_tool')).toBe(false);
  });

  it('should return true for clean schemas', () => {
    const clean = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['name'],
    };
    expect(_validateToolSchema(clean, 'test_tool')).toBe(true);
  });
});

describe('end-to-end: zodToJsonSchema -> sanitize', () => {
  it('should produce valid schemas from Zod-like JSON Schema output', () => {
    // This simulates what zodToJsonSchema(z.object({...}), { target: 'jsonSchema7' }) produces
    const zodOutput = {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 280,
          description: 'Tweet text',
        },
        replyTo: {
          type: 'string',
          description: 'Tweet ID to reply to',
        },
        mediaIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Media IDs to attach',
        },
      },
      required: ['text'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    const result = sanitize(zodOutput) as Record<string, unknown>;

    // Should be valid for provider dispatch
    expect(result).not.toHaveProperty('$schema');
    expect(result.type).toBe('object');
    expect(result.additionalProperties).toBe(false);
    expect(_validateToolSchema(result, 'twitter_post')).toBe(true);
  });

  it('should handle nullable optional fields from Zod', () => {
    // z.string().nullable().optional() produces this in jsonSchema7:
    const zodOutput = {
      type: 'object',
      properties: {
        bio: {
          type: ['string', 'null'],
        },
      },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    const result = sanitize(zodOutput) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;

    // type array should become anyOf
    expect(props.bio.anyOf).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
    expect(props.bio).not.toHaveProperty('type');
  });
});
