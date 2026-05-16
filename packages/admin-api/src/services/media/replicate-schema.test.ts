import { describe, it, expect } from 'bun:test';
import {
  extractSupportedParams,
  validateReplicateInput,
  type ModelSupportedParams,
} from './replicate-schema.js';

// ============================================================================
// extractSupportedParams
// ============================================================================

describe('extractSupportedParams', () => {
  it('extracts parameters from a model OpenAPI schema', () => {
    const modelData = {
      latest_version: {
        id: 'abc123',
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'Input prompt',
                  },
                  aspect_ratio: {
                    type: 'string',
                    description: 'Aspect ratio',
                    enum: ['1:1', '3:2', '2:3', '16:9', '9:16'],
                    default: '1:1',
                  },
                  output_format: {
                    type: 'string',
                    enum: ['png', 'jpg', 'webp'],
                    default: 'png',
                  },
                  num_outputs: {
                    type: 'integer',
                    description: 'Number of outputs',
                    minimum: 1,
                    maximum: 4,
                    default: 1,
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = extractSupportedParams('test/model', modelData);

    expect(result.modelId).toBe('test/model');
    expect(result.params.prompt.type).toBe('string');
    expect(result.params.aspect_ratio.enum).toEqual(['1:1', '3:2', '2:3', '16:9', '9:16']);
    expect(result.params.aspect_ratio.default).toBe('1:1');
    expect(result.params.output_format.enum).toEqual(['png', 'jpg', 'webp']);
    expect(result.params.num_outputs.minimum).toBe(1);
    expect(result.params.num_outputs.maximum).toBe(4);
  });

  it('handles missing schema gracefully', () => {
    const result = extractSupportedParams('test/model', {});
    expect(result.modelId).toBe('test/model');
    expect(Object.keys(result.params)).toHaveLength(0);
  });

  it('handles allOf patterns for enums', () => {
    const modelData = {
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                properties: {
                  aspect_ratio: {
                    allOf: [
                      { enum: ['1:1', '4:3', '16:9'] },
                      { default: '1:1' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = extractSupportedParams('test/model', modelData);
    expect(result.params.aspect_ratio.enum).toEqual(['1:1', '4:3', '16:9']);
    expect(result.params.aspect_ratio.default).toBe('1:1');
  });
});

// ============================================================================
// validateReplicateInput
// ============================================================================

describe('validateReplicateInput', () => {
  const schema: ModelSupportedParams = {
    modelId: 'test/model',
    params: {
      prompt: { type: 'string' },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '3:2', '2:3'],
        default: '1:1',
      },
      output_format: {
        type: 'string',
        enum: ['png', 'jpg'],
        default: 'png',
      },
      num_outputs: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        default: 1,
      },
    },
    fetchedAt: Date.now(),
  };

  it('passes valid input unchanged', () => {
    const input = {
      prompt: 'a cat',
      aspect_ratio: '1:1',
      output_format: 'png',
      num_outputs: 2,
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput).toEqual(input);
    expect(adjustments).toHaveLength(0);
  });

  it('strips unsupported parameters', () => {
    const input = {
      prompt: 'a cat',
      resolution: '2K',       // Not in schema
      safety_filter_level: 'block_only_high',  // Not in schema
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput.prompt).toBe('a cat');
    expect(cleanedInput.resolution).toBeUndefined();
    expect(cleanedInput.safety_filter_level).toBeUndefined();
    expect(adjustments).toHaveLength(2);
    expect(adjustments[0]).toContain('Removed unsupported parameter "resolution"');
    expect(adjustments[1]).toContain('Removed unsupported parameter "safety_filter_level"');
  });

  it('corrects invalid enum values to default', () => {
    const input = {
      prompt: 'a cat',
      aspect_ratio: '4:5',  // Not in this model's enum
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput.aspect_ratio).toBe('1:1'); // Corrected to default
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toContain('Corrected "aspect_ratio"');
    expect(adjustments[0]).toContain('valid: 1:1, 3:2, 2:3');
  });

  it('corrects invalid enum values to first enum when no default', () => {
    const schemaNoDefault: ModelSupportedParams = {
      modelId: 'test/model',
      params: {
        format: {
          type: 'string',
          enum: ['webp', 'png'],
        },
      },
      fetchedAt: Date.now(),
    };

    const input = { format: 'gif' };
    const { cleanedInput } = validateReplicateInput('test/model', input, schemaNoDefault);

    expect(cleanedInput.format).toBe('webp'); // Falls back to first enum value
  });

  it('clamps numeric values to valid range', () => {
    const input = {
      prompt: 'a cat',
      num_outputs: 10, // Above maximum of 4
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput.num_outputs).toBe(4);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toContain('Corrected "num_outputs" from 10 to 4');
  });

  it('clamps numeric values below minimum', () => {
    const input = {
      prompt: 'a cat',
      num_outputs: 0, // Below minimum of 1
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput.num_outputs).toBe(1);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toContain('minimum: 1');
  });

  it('keeps prompt even if not in schema params', () => {
    const emptySchema: ModelSupportedParams = {
      modelId: 'test/model',
      params: {},
      fetchedAt: Date.now(),
    };

    const input = { prompt: 'a cat', unknown_param: 'value' };
    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, emptySchema);

    expect(cleanedInput.prompt).toBe('a cat');
    expect(cleanedInput.unknown_param).toBeUndefined();
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toContain('Removed unsupported parameter "unknown_param"');
  });

  it('handles mixed valid and invalid inputs', () => {
    const input = {
      prompt: 'a beautiful sunset',
      aspect_ratio: '21:9',        // Invalid
      output_format: 'png',         // Valid
      num_outputs: 2,               // Valid
      width: 1024,                  // Unsupported
      height: 1024,                 // Unsupported
    };

    const { cleanedInput, adjustments } = validateReplicateInput('test/model', input, schema);

    expect(cleanedInput.prompt).toBe('a beautiful sunset');
    expect(cleanedInput.aspect_ratio).toBe('1:1'); // Corrected
    expect(cleanedInput.output_format).toBe('png'); // Kept
    expect(cleanedInput.num_outputs).toBe(2);       // Kept
    expect(cleanedInput.width).toBeUndefined();     // Stripped
    expect(cleanedInput.height).toBeUndefined();    // Stripped
    expect(adjustments).toHaveLength(3); // 1 corrected + 2 removed
  });

  it('keeps Flux image_prompt and strips unsupported reference aliases', () => {
    const fluxSchema: ModelSupportedParams = {
      modelId: 'black-forest-labs/flux-1.1-pro',
      params: {
        prompt: { type: 'string' },
        image_prompt: { type: 'string' },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9'],
          default: '1:1',
        },
      },
      fetchedAt: Date.now(),
    };

    const input = {
      prompt: 'self portrait',
      image_input: ['https://example.com/ref.png'],
      image: 'https://example.com/ref.png',
      image_prompt: 'https://example.com/ref.png',
      aspect_ratio: '1:1',
    };

    const { cleanedInput, adjustments } = validateReplicateInput('black-forest-labs/flux-1.1-pro', input, fluxSchema);

    expect(cleanedInput.image_prompt).toBe('https://example.com/ref.png');
    expect(cleanedInput.image_input).toBeUndefined();
    expect(cleanedInput.image).toBeUndefined();
    expect(adjustments).toHaveLength(2);
  });

  it('keeps Nano Banana image_input and strips unsupported Flux alias', () => {
    const nanoSchema: ModelSupportedParams = {
      modelId: 'google/nano-banana-pro',
      params: {
        prompt: { type: 'string' },
        image_input: { type: 'array' },
        aspect_ratio: {
          type: 'string',
          enum: ['match_input_image', '1:1'],
          default: 'match_input_image',
        },
      },
      fetchedAt: Date.now(),
    };

    const input = {
      prompt: 'self portrait',
      image_input: ['https://example.com/ref.png'],
      image_prompt: 'https://example.com/ref.png',
      aspect_ratio: 'match_input_image',
    };

    const { cleanedInput, adjustments } = validateReplicateInput('google/nano-banana-pro', input, nanoSchema);

    expect(cleanedInput.image_input).toEqual(['https://example.com/ref.png']);
    expect(cleanedInput.image_prompt).toBeUndefined();
    expect(cleanedInput.aspect_ratio).toBe('match_input_image');
    expect(adjustments).toHaveLength(1);
  });
});
