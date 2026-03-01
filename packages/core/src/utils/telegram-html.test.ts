/**
 * Telegram HTML Formatting Tests
 *
 * Tests for markdownToTelegramHtml conversion utility.
 *
 * @see packages/core/src/utils/telegram-html.ts
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, markdownToTelegramHtml, stripMarkdown } from './telegram-html.js';

describe('escapeHtml', () => {
  it('should escape ampersands', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('should escape angle brackets', () => {
    expect(escapeHtml('a < b > c')).toBe('a &lt; b &gt; c');
  });

  it('should escape all HTML special characters together', () => {
    expect(escapeHtml('<script>alert("xss")&</script>')).toBe(
      '&lt;script&gt;alert("xss")&amp;&lt;/script&gt;'
    );
  });

  it('should return empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeHtml('Hello world')).toBe('Hello world');
  });
});

describe('markdownToTelegramHtml', () => {
  describe('Bold', () => {
    it('should convert **bold** to <b>', () => {
      expect(markdownToTelegramHtml('Hello **world**')).toBe('Hello <b>world</b>');
    });

    it('should convert __bold__ to <b>', () => {
      expect(markdownToTelegramHtml('Hello __world__')).toBe('Hello <b>world</b>');
    });

    it('should handle multiple bold segments', () => {
      expect(markdownToTelegramHtml('**one** and **two**')).toBe('<b>one</b> and <b>two</b>');
    });
  });

  describe('Italic', () => {
    it('should convert *italic* to <i>', () => {
      expect(markdownToTelegramHtml('Hello *world*')).toBe('Hello <i>world</i>');
    });

    it('should convert _italic_ to <i>', () => {
      expect(markdownToTelegramHtml('Hello _world_')).toBe('Hello <i>world</i>');
    });

    it('should not convert mid-word underscores', () => {
      expect(markdownToTelegramHtml('some_variable_name')).toBe('some_variable_name');
    });
  });

  describe('Bold and Italic combined', () => {
    it('should handle bold and italic in the same string', () => {
      const result = markdownToTelegramHtml('**bold** and *italic*');
      expect(result).toBe('<b>bold</b> and <i>italic</i>');
    });
  });

  describe('Strikethrough', () => {
    it('should convert ~~strikethrough~~ to <s>', () => {
      expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
    });
  });

  describe('Inline Code', () => {
    it('should convert `code` to <code>', () => {
      expect(markdownToTelegramHtml('Use `npm install`')).toBe('Use <code>npm install</code>');
    });

    it('should not apply formatting inside inline code', () => {
      expect(markdownToTelegramHtml('Run `**not bold**`')).toBe('Run <code>**not bold**</code>');
    });

    it('should escape HTML inside inline code', () => {
      expect(markdownToTelegramHtml('Use `<div>`')).toBe('Use <code>&lt;div&gt;</code>');
    });
  });

  describe('Code Blocks', () => {
    it('should convert ```code``` to <pre>', () => {
      expect(markdownToTelegramHtml('```\nhello\n```')).toBe('<pre>hello</pre>');
    });

    it('should handle code blocks with language identifier', () => {
      expect(markdownToTelegramHtml('```javascript\nconsole.log("hi");\n```')).toBe(
        '<pre>console.log("hi");</pre>'
      );
    });

    it('should not apply formatting inside code blocks', () => {
      expect(markdownToTelegramHtml('```\n**bold** and *italic*\n```')).toBe(
        '<pre>**bold** and *italic*</pre>'
      );
    });

    it('should escape HTML inside code blocks', () => {
      expect(markdownToTelegramHtml('```\n<div>test</div>\n```')).toBe(
        '<pre>&lt;div&gt;test&lt;/div&gt;</pre>'
      );
    });
  });

  describe('Links', () => {
    it('should convert [text](url) to <a href>', () => {
      expect(markdownToTelegramHtml('[Click here](https://example.com)')).toBe(
        '<a href="https://example.com">Click here</a>'
      );
    });

    it('should handle multiple links', () => {
      const input = 'Visit [one](https://a.com) or [two](https://b.com)';
      const expected = 'Visit <a href="https://a.com">one</a> or <a href="https://b.com">two</a>';
      expect(markdownToTelegramHtml(input)).toBe(expected);
    });
  });

  describe('HTML Escaping', () => {
    it('should escape < and > in non-formatting text', () => {
      expect(markdownToTelegramHtml('Use 1 < 2 > 0')).toBe('Use 1 &lt; 2 &gt; 0');
    });

    it('should escape & in non-formatting text', () => {
      expect(markdownToTelegramHtml('A & B')).toBe('A &amp; B');
    });

    it('should escape HTML but still apply formatting', () => {
      expect(markdownToTelegramHtml('**bold** & *italic* < 3')).toBe(
        '<b>bold</b> &amp; <i>italic</i> &lt; 3'
      );
    });
  });

  describe('Empty and edge cases', () => {
    it('should handle empty string', () => {
      expect(markdownToTelegramHtml('')).toBe('');
    });

    it('should handle plain text with no formatting', () => {
      expect(markdownToTelegramHtml('Just plain text')).toBe('Just plain text');
    });

    it('should handle multiline text', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      expect(markdownToTelegramHtml(input)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should handle unclosed bold markers gracefully', () => {
      // Unclosed ** should pass through as-is (escaped)
      const result = markdownToTelegramHtml('This is **unclosed');
      // The ** will remain as literal text
      expect(result).toContain('**');
    });

    it('should handle unclosed italic markers gracefully', () => {
      const result = markdownToTelegramHtml('This is *unclosed');
      // The * will remain as literal text
      expect(result).toContain('*');
    });
  });

  describe('Complex LLM output', () => {
    it('should handle a typical LLM response', () => {
      const input = [
        'Here are the steps:',
        '',
        '1. **Install** the package with `npm install`',
        '2. *Configure* your settings',
        '3. Run the ~~old~~ new command',
        '',
        'Check the [docs](https://docs.example.com) for more info.',
      ].join('\n');

      const result = markdownToTelegramHtml(input);

      expect(result).toContain('<b>Install</b>');
      expect(result).toContain('<code>npm install</code>');
      expect(result).toContain('<i>Configure</i>');
      expect(result).toContain('<s>old</s>');
      expect(result).toContain('<a href="https://docs.example.com">docs</a>');
    });

    it('should handle mixed code and formatting', () => {
      const input = 'Use **`bold code`** for emphasis';
      const result = markdownToTelegramHtml(input);

      // The inline code should be preserved, bold wraps around it
      expect(result).toContain('<code>bold code</code>');
    });
  });
});

describe('stripMarkdown', () => {
  it('should strip bold markers', () => {
    expect(stripMarkdown('**bold** text')).toBe('bold text');
  });

  it('should strip italic markers', () => {
    expect(stripMarkdown('*italic* text')).toBe('italic text');
  });

  it('should strip code markers', () => {
    expect(stripMarkdown('Use `code` here')).toBe('Use code here');
  });

  it('should strip code block markers', () => {
    expect(stripMarkdown('```\ncode\n```')).toBe('code');
  });

  it('should convert links to text (url)', () => {
    expect(stripMarkdown('[link](https://example.com)')).toBe('link (https://example.com)');
  });

  it('should strip strikethrough markers', () => {
    expect(stripMarkdown('~~deleted~~')).toBe('deleted');
  });

  it('should handle empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('should handle plain text', () => {
    expect(stripMarkdown('no formatting')).toBe('no formatting');
  });
});
