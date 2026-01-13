/**
 * Chat Handler Tool Routing Tests
 *
 * HIGH VALUE: These tests verify the critical tool routing logic that determines
 * which tools need UI interaction (upload widgets, model selectors, etc.)
 *
 * This is where the character reference bug was - missing tool names in the routing logic.
 * These tests ensure we never regress on tool detection.
 */
import { describe, it, expect } from 'vitest';
import { isPauseForInputTool } from '../tools/index.js';

/**
 * Extracted tool routing logic from tools/index.ts for testability
 */
function shouldPauseTool(toolCall: { function: { name: string; arguments?: string } }): boolean {
  const { name, arguments: args } = toolCall.function;
  let parsedArgs: Record<string, unknown> = {};
  if (args) {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = {};
    }
  }
  return isPauseForInputTool(name, parsedArgs);
}

/**
 * Extracted from ToolPrompts.tsx - detection of upload URL responses
 * This mirrors the logic at ToolPrompts.tsx:591-592
 */
function isUploadUrlResponse(args: Record<string, unknown>): boolean {
  return args?.type === 'upload_url' ||
    (!!args?.uploadUrl && !!args?.s3Key && !!args?.publicUrl);
}

/**
 * Check if a tool call is for an upload URL tool
 * These tools return upload URLs and need UI interaction
 */
function isUploadUrlTool(toolCall: { function: { name: string; arguments?: string } }): boolean {
  const uploadUrlTools = [
    'get_profile_upload_url',
    'get_reference_image_upload_url',
    'get_character_reference_upload_url',
  ];

  const { name, arguments: args } = toolCall.function;

  // Direct upload URL tools
  if (uploadUrlTools.includes(name)) {
    return true;
  }

  // set_profile_image with source='upload'
  if (name === 'set_profile_image' && args) {
    try {
      const parsed = JSON.parse(args);
      if (parsed.source === 'upload') {
        return true;
      }
    } catch {
      // ignore parse errors
    }
  }

  return false;
}

/**
 * Extracted from ChatPanel.tsx - detection of character reference uploads
 * This mirrors the logic at ChatPanel.tsx:327-336
 */
function classifyUpload(toolName: string, result: Record<string, unknown>): 'character_reference' | 'profile' | 'reference_image' {
  // Character reference upload
  if (toolName === 'set_character_reference' ||
      toolName === 'get_character_reference_upload_url' ||
      result.purpose === 'character_reference') {
    return 'character_reference';
  }

  // Profile image upload
  if (toolName === 'set_profile_image' ||
      toolName === 'get_profile_upload_url' ||
      !result.category) {
    return 'profile';
  }

  // Other reference images
  return 'reference_image';
}

describe('Chat Handler - Tool Routing Logic', () => {
  describe('Pause tools', () => {
    it('should pause for request_secret', () => {
      expect(shouldPauseTool({
        function: { name: 'request_secret' }
      })).toBe(true);
    });

    it('should pause for request_model_selection', () => {
      expect(shouldPauseTool({
        function: { name: 'request_model_selection' }
      })).toBe(true);
    });

    it('should pause for request_feature_toggle', () => {
      expect(shouldPauseTool({
        function: { name: 'request_feature_toggle' }
      })).toBe(true);
    });

    it('should pause for get_profile_upload_url', () => {
      expect(shouldPauseTool({
        function: { name: 'get_profile_upload_url' }
      })).toBe(true);
    });

    it('should pause for get_reference_image_upload_url', () => {
      expect(shouldPauseTool({
        function: { name: 'get_reference_image_upload_url' }
      })).toBe(true);
    });

    it('should pause for get_character_reference_upload_url', () => {
      expect(shouldPauseTool({
        function: { name: 'get_character_reference_upload_url' }
      })).toBe(true);
    });

    it('should pause for set_profile_image with source=upload', () => {
      expect(shouldPauseTool({
        function: {
          name: 'set_profile_image',
          arguments: JSON.stringify({ source: 'upload' })
        }
      })).toBe(true);
    });

    it('should pause for set_character_reference with source=upload', () => {
      expect(shouldPauseTool({
        function: {
          name: 'set_character_reference',
          arguments: JSON.stringify({ source: 'upload' })
        }
      })).toBe(true);
    });

    it('should NOT pause for set_profile_image with source=url', () => {
      expect(shouldPauseTool({
        function: {
          name: 'set_profile_image',
          arguments: JSON.stringify({ source: 'url', url: 'https://example.com/img.png' })
        }
      })).toBe(false);
    });

    it('should NOT pause for generate_image', () => {
      expect(shouldPauseTool({
        function: { name: 'generate_image' }
      })).toBe(false);
    });
  });
});

describe('Frontend - Upload URL Response Detection', () => {
  it('should detect response with type=upload_url', () => {
    expect(isUploadUrlResponse({
      type: 'upload_url',
      uploadUrl: 'https://s3.amazonaws.com/...',
      s3Key: 'agents/123/ref.png',
      publicUrl: 'https://cdn.example.com/ref.png'
    })).toBe(true);
  });

  it('should detect response with uploadUrl + s3Key + publicUrl', () => {
    expect(isUploadUrlResponse({
      uploadUrl: 'https://s3.amazonaws.com/...',
      s3Key: 'agents/123/ref.png',
      publicUrl: 'https://cdn.example.com/ref.png'
    })).toBe(true);
  });

  it('should detect character reference upload response', () => {
    expect(isUploadUrlResponse({
      uploadUrl: 'https://s3.amazonaws.com/...',
      s3Key: 'agents/123/character-reference/abc.png',
      publicUrl: 'https://cdn.example.com/character-reference/abc.png',
      purpose: 'character_reference',
      description: 'Blue whale turnaround'
    })).toBe(true);
  });

  it('should NOT detect response missing uploadUrl', () => {
    expect(isUploadUrlResponse({
      s3Key: 'agents/123/ref.png',
      publicUrl: 'https://cdn.example.com/ref.png'
    })).toBe(false);
  });

  it('should NOT detect response missing s3Key', () => {
    expect(isUploadUrlResponse({
      uploadUrl: 'https://s3.amazonaws.com/...',
      publicUrl: 'https://cdn.example.com/ref.png'
    })).toBe(false);
  });

  it('should NOT detect response missing publicUrl', () => {
    expect(isUploadUrlResponse({
      uploadUrl: 'https://s3.amazonaws.com/...',
      s3Key: 'agents/123/ref.png'
    })).toBe(false);
  });

  it('should NOT detect empty response', () => {
    expect(isUploadUrlResponse({})).toBe(false);
  });

  it('should NOT detect model selector response', () => {
    expect(isUploadUrlResponse({
      type: 'model_selector',
      models: [{ id: 'gpt-4', name: 'GPT-4' }]
    })).toBe(false);
  });
});

describe('Frontend - Upload Type Classification', () => {
  describe('Character Reference Detection', () => {
    it('should classify set_character_reference tool as character_reference', () => {
      expect(classifyUpload('set_character_reference', {})).toBe('character_reference');
    });

    it('should classify get_character_reference_upload_url tool as character_reference', () => {
      expect(classifyUpload('get_character_reference_upload_url', {})).toBe('character_reference');
    });

    it('should classify response with purpose=character_reference as character_reference', () => {
      expect(classifyUpload('unknown_tool', { purpose: 'character_reference' })).toBe('character_reference');
    });
  });

  describe('Profile Image Detection', () => {
    it('should classify set_profile_image tool as profile', () => {
      expect(classifyUpload('set_profile_image', {})).toBe('profile');
    });

    it('should classify get_profile_upload_url tool as profile', () => {
      expect(classifyUpload('get_profile_upload_url', {})).toBe('profile');
    });

    it('should classify response without category as profile', () => {
      expect(classifyUpload('unknown_tool', {})).toBe('profile');
    });
  });

  describe('Reference Image Detection', () => {
    it('should classify response with category as reference_image', () => {
      expect(classifyUpload('unknown_tool', { category: 'pose_reference' })).toBe('reference_image');
    });

    it('should classify get_reference_image_upload_url with category as reference_image', () => {
      expect(classifyUpload('get_reference_image_upload_url', { category: 'style' })).toBe('reference_image');
    });
  });

  describe('Edge Cases', () => {
    it('should prioritize character_reference over profile for set_character_reference', () => {
      // Even if category is missing, tool name takes precedence
      expect(classifyUpload('set_character_reference', { category: undefined })).toBe('character_reference');
    });

    it('should prioritize purpose=character_reference over missing category', () => {
      expect(classifyUpload('some_other_tool', { purpose: 'character_reference' })).toBe('character_reference');
    });
  });
});

describe('Integration - Full Tool Call Flow Simulation', () => {
  it('should correctly route character reference upload through the full flow', () => {
    // Simulate LLM returning a tool call
    const toolCall = {
      id: 'call_abc123',
      function: {
        name: 'get_character_reference_upload_url',
        arguments: JSON.stringify({ description: 'Blue whale character sheet' })
      }
    };

    // Step 1: Chat handler detects it needs UI interaction
    expect(isUploadUrlTool(toolCall)).toBe(true);

    // Step 2: Tool executes and returns upload URL payload
    const toolResult = {
      uploadUrl: 'https://s3.amazonaws.com/bucket/signed-url',
      s3Key: 'agents/agent-123/character-reference/uuid.png',
      publicUrl: 'https://cdn.example.com/agents/agent-123/character-reference/uuid.png',
      purpose: 'character_reference',
      description: 'Blue whale character sheet'
    };

    // Step 3: Frontend detects this is an upload prompt
    expect(isUploadUrlResponse(toolResult)).toBe(true);

    // Step 4: After upload, frontend classifies the upload type
    const uploadType = classifyUpload('get_character_reference_upload_url', toolResult);
    expect(uploadType).toBe('character_reference');
  });

  it('should correctly route profile image upload through the full flow', () => {
    const toolCall = {
      id: 'call_def456',
      function: {
        name: 'set_profile_image',
        arguments: JSON.stringify({ source: 'upload' })
      }
    };

    expect(isUploadUrlTool(toolCall)).toBe(true);

    const toolResult = {
      uploadUrl: 'https://s3.amazonaws.com/bucket/signed-url',
      s3Key: 'agents/agent-123/profile/uuid.png',
      publicUrl: 'https://cdn.example.com/agents/agent-123/profile/uuid.png'
    };

    expect(isUploadUrlResponse(toolResult)).toBe(true);
    expect(classifyUpload('set_profile_image', toolResult)).toBe('profile');
  });

  it('should NOT route generate_image as needing UI interaction', () => {
    const toolCall = {
      id: 'call_ghi789',
      function: {
        name: 'generate_image',
        arguments: JSON.stringify({ prompt: 'A whale swimming' })
      }
    };

    // generate_image should NOT trigger upload UI
    expect(isUploadUrlTool(toolCall)).toBe(false);
  });
});
