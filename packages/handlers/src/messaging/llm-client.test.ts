import { describe, expect, it } from 'vitest';
import { parseXmlToolCalls } from './llm-client.js';

describe('llm-client tool call parser', () => {
  it('converts leaked bracket sticker calls into tool calls', () => {
    const content = `PHANTOM.RESEARCH: Executing direct tool call.

<details>
<summary>System Action: Sticker Generation</summary>
[generate_sticker(prompt="A minimalist, sharp cyberpunk phantom mask icon, glowing cyan circuitry on matte black, bold geometric lines, high contrast, transparent background.")]
</details>`;

    const result = parseXmlToolCalls(content, ['generate_sticker']);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('generate_sticker');
    expect(result.toolCalls[0].arguments).toEqual({
      prompt: 'A minimalist, sharp cyberpunk phantom mask icon, glowing cyan circuitry on matte black, bold geometric lines, high contrast, transparent background.',
    });
    expect(result.cleanedContent).not.toContain('[generate_sticker');
  });

  it('does not parse bracket calls for unavailable tools', () => {
    const content = '[generate_sticker(prompt="mask")]';
    const result = parseXmlToolCalls(content, ['generate_image']);

    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedContent).toBe(content);
  });

  it('maps direct media tags to prompt arguments', () => {
    const result = parseXmlToolCalls(
      '<generate_sticker>refined cyberpunk sticker mask</generate_sticker>',
      ['generate_sticker'],
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({
      prompt: 'refined cyberpunk sticker mask',
    });
    expect(result.cleanedContent).toBe('');
  });
});
