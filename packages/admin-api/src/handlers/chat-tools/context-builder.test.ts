/**
 * Context builder tests — pure functions.
 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { injectTestClients } from '../__test-helpers__/inject-clients.js';


let buildSystemPrompt: typeof import('./context-builder.js').buildSystemPrompt;
let buildModelInput: typeof import('./context-builder.js').buildModelInput;
let buildUserMessageContent: typeof import('./context-builder.js').buildUserMessageContent;

beforeAll(async () => {
  await injectTestClients();

  const mod = await import('./context-builder.js');
  buildSystemPrompt = mod.buildSystemPrompt;
  buildModelInput = mod.buildModelInput;
  buildUserMessageContent = mod.buildUserMessageContent;
});

describe('buildSystemPrompt', () => {
  it('returns fallback when no avatar provided', () => {
    const result = buildSystemPrompt(undefined);
    expect(result).toMatch(/Swarm avatar assistant/);
    expect(result).toMatch(/select an avatar/);
  });

  it('builds prompt from avatar config', () => {
    const result = buildSystemPrompt({
      id: 'av-1',
      name: 'TestBot',
      description: 'A test avatar',
      persona: 'helpful assistant',
      enabledCategories: ['secrets', 'profile'],
    });
    expect(result).toContain('TestBot');
  });

  it('uses default categories when none specified', () => {
    const result = buildSystemPrompt({
      id: 'av-2',
      name: 'DefaultBot',
      description: 'Default avatar',
      persona: 'friendly',
    });
    expect(result).toContain('DefaultBot');
  });
});

describe('buildModelInput', () => {
  it('passes through short message lists unchanged modulo sanitization', () => {
    const msgs = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    const result = buildModelInput('system prompt', msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('truncates messages exceeding MAX_CONTEXT_MESSAGES', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }));
    const result = buildModelInput('sys', msgs);
    // MAX_CONTEXT_MESSAGES = 20, so 25 → 20
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('re-sanitizes after truncation', () => {
    // If the first message was an assistant with tool_calls and gets truncated,
    // orphan tool results that follow would be removed in re-sanitization.
    const msgs: any[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', content: 'r', tool_call_id: 'tc-1' },
    ];
    // Add enough messages so the assistant gets truncated
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `msg ${i}` });
    }
    const result = buildModelInput('sys', msgs);
    // The orphaned tool result (no matching assistant) should be gone
    const toolMsgs = result.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(0);
  });

  it('returns empty for empty input', () => {
    expect(buildModelInput('sys', [])).toEqual([]);
  });
});

describe('buildUserMessageContent', () => {
  it('returns plain text when no transcription or attachments', () => {
    const result = buildUserMessageContent('hello', '');
    expect(result).toBe('hello');
  });

  it('appends transcription to message', () => {
    const result = buildUserMessageContent(
      'hello',
      '\n\n[Voice message]: "hi there"'
    );
    expect(result).toBe('hello\n\n[Voice message]: "hi there"');
  });

  it('returns text-only when attachments have no images', () => {
    const result = buildUserMessageContent('hello', '', [
      { type: 'file', data: 'base64...', name: 'doc.pdf' },
    ]);
    expect(typeof result).toBe('string');
    expect(result).toBe('hello');
  });

  it('returns multimodal array when image attachments present', () => {
    const result = buildUserMessageContent('describe this', '', [
      { type: 'image', data: 'https://example.com/photo.png', name: 'photo.png' },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.some(p => p.type === 'text')).toBe(true);
    expect(parts.some(p => p.type === 'image_url')).toBe(true);
  });

  it('includes transcription in multimodal content', () => {
    const result = buildUserMessageContent(
      'check this',
      '\n\n[Voice]: "what do you think?"',
      [{ type: 'image', data: 'https://example.com/img.png', name: 'img.png' }]
    );
    const parts = result as Array<{ type: string; text?: string }>;
    const textPart = parts.find(p => p.type === 'text');
    expect(textPart!.text).toContain('[Voice]');
  });

  it('handles empty attachments array', () => {
    const result = buildUserMessageContent('hi', '', []);
    expect(result).toBe('hi');
  });
});
