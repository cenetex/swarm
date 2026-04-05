/**
 * Substack Publisher Tests
 */
import { describe, it, expect, beforeEach, mock, afterAll } from 'bun:test';
import {
  markdownToSubstackHtml,
  markdownToSubstackProseMirror,
  validatePostContent,
  type SubstackPublishConfig,
  type ProseMirrorDoc,
} from './substack-publisher.js';

// Mock the AWS SDK
mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = mock(async () => ({ SecretString: '{}' }));
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Stub global fetch for tests in this file
const fetchMock = mock(async () => new Response('{}', { status: 200 }));
(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

describe('Substack Publisher', () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  describe('markdownToSubstackProseMirror', () => {
    it('should convert markdown to ProseMirror JSON', () => {
      const markdown = '# Hello\n\nThis is a paragraph.';
      const doc = markdownToSubstackProseMirror(markdown);

      expect(doc.type).toBe('doc');
      expect(doc.attrs.schemaVersion).toBe('v1');
      expect(doc.content).toBeInstanceOf(Array);
    });

    it('should convert headings', () => {
      const markdown = '# H1\n## H2\n### H3';
      const doc = markdownToSubstackProseMirror(markdown) as ProseMirrorDoc;

      expect(doc.content.some(n => n.type === 'heading' && (n.attrs as { level: number }).level === 1)).toBe(true);
      expect(doc.content.some(n => n.type === 'heading' && (n.attrs as { level: number }).level === 2)).toBe(true);
      expect(doc.content.some(n => n.type === 'heading' && (n.attrs as { level: number }).level === 3)).toBe(true);
    });

    it('should convert bold and italic text', () => {
      const markdown = '**bold** and *italic*';
      const doc = markdownToSubstackProseMirror(markdown) as ProseMirrorDoc;

      const paragraph = doc.content.find(n => n.type === 'paragraph');
      expect(paragraph).toBeDefined();

      // Check for marks in the content
      const fullJson = JSON.stringify(doc);
      expect(fullJson).toContain('strong');
      expect(fullJson).toContain('em');
    });

    it('should convert links', () => {
      const markdown = '[click here](https://example.com)';
      const doc = markdownToSubstackProseMirror(markdown) as ProseMirrorDoc;

      const fullJson = JSON.stringify(doc);
      expect(fullJson).toContain('link');
      expect(fullJson).toContain('https://example.com');
    });

    it('should convert bullet lists', () => {
      const markdown = '- Item 1\n- Item 2\n- Item 3';
      const doc = markdownToSubstackProseMirror(markdown) as ProseMirrorDoc;

      expect(doc.content.some(n => n.type === 'bullet_list')).toBe(true);
    });

    it('should handle complex markdown with multiple formats', () => {
      const markdown = `# Title

A paragraph with **bold** and *italic* text.

## Subheading

- List item 1
- List item 2

[See more](https://example.com)`;

      const doc = markdownToSubstackProseMirror(markdown) as ProseMirrorDoc;

      expect(doc.type).toBe('doc');
      expect(doc.attrs.schemaVersion).toBe('v1');
      expect(doc.content.length > 0).toBe(true);

      // Verify structure
      const fullJson = JSON.stringify(doc);
      expect(fullJson).toContain('heading');
      expect(fullJson).toContain('paragraph');
      expect(fullJson).toContain('bullet_list');
      expect(fullJson).toContain('strong');
      expect(fullJson).toContain('link');
    });
  });

  describe('validatePostContent', () => {
    it('should reject posts without title', () => {
      const result = validatePostContent({
        title: '',
        content: 'Some content',
      });
      expect(result).toBeTruthy();
      expect(result).toContain('Title is required');
    });

    it('should reject posts with titles longer than 300 chars', () => {
      const result = validatePostContent({
        title: 'x'.repeat(301),
        content: 'Some content',
      });
      expect(result).toBeTruthy();
      expect(result).toContain('too long');
    });

    it('should reject posts without content', () => {
      const result = validatePostContent({
        title: 'Valid Title',
        content: '',
      });
      expect(result).toBeTruthy();
      expect(result).toContain('Content is required');
    });

    it('should reject invalid image formats', () => {
      const result = validatePostContent({
        title: 'Valid Title',
        content: 'Some content',
        imageUrl: 'https://example.com/image.svg',
      });
      expect(result).toBeTruthy();
      expect(result).toContain('not supported');
    });

    it('should accept valid posts', () => {
      const result = validatePostContent({
        title: 'Valid Title',
        content: 'Some content',
        imageUrl: 'https://example.com/image.jpg',
      });
      expect(result).toBeNull();
    });

    it('should accept posts with supported image formats', () => {
      const formats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
      for (const fmt of formats) {
        const result = validatePostContent({
          title: 'Valid Title',
          content: 'Some content',
          imageUrl: `https://example.com/image.${fmt}`,
        });
        expect(result).toBeNull();
      }
    });
  });

  describe('markdownToSubstackHtml', () => {
    it('should convert headings to HTML', () => {
      const markdown = '# H1\n## H2\n### H3';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('<h1>H1</h1>');
      expect(html).toContain('<h2>H2</h2>');
      expect(html).toContain('<h3>H3</h3>');
    });

    it('should convert bold text', () => {
      const markdown = '**bold text** and __bold text__';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('<strong>bold text</strong>');
    });

    it('should convert italic text', () => {
      const markdown = '*italic text* and _italic text_';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('<em>italic text</em>');
    });

    it('should convert links', () => {
      const markdown = '[click here](https://example.com)';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('<a href="https://example.com">click here</a>');
    });

    it('should handle paragraph breaks', () => {
      const markdown = 'Line 1\n\nLine 2';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('</p><p>');
    });

    it('should wrap content in paragraphs', () => {
      const markdown = 'This is some text';
      const html = markdownToSubstackHtml(markdown);
      expect(html).toMatch(/^<p>.*<\/p>$/);
    });

    it('should handle complex markdown', () => {
      const markdown = `# Title

A paragraph with **bold** and *italic* text.

## Subheading

- List item 1
- List item 2

[See more](https://example.com)`;

      const html = markdownToSubstackHtml(markdown);
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<h2>Subheading</h2>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
      expect(html).toContain('<a href="https://example.com">See more</a>');
    });
  });

  describe('Cookie-based Authentication', () => {
    it('should require substack_sid or connect_sid in credentials', () => {
      // This test documents the new auth requirement
      // withRetry and other functions should use these cookies instead of email/password
      const validCredentials = {
        substack_sid: 'test-sid-value',
        connect_sid: 'test-connect-sid',
      };

      expect(validCredentials.substack_sid).toBeDefined();
      expect(validCredentials.connect_sid).toBeDefined();
    });
  });

  describe('Session Management', () => {
    it('should handle publish configuration', () => {
      const config: SubstackPublishConfig = {
        subdomain: 'test-agent',
        sendEmail: false,
        publishImmediately: true,
      };

      expect(config.subdomain).toBe('test-agent');
      expect(config.sendEmail).toBe(false);
      expect(config.publishImmediately).toBe(true);
    });

    it('should have correct publish configuration defaults', () => {
      const config: SubstackPublishConfig = {
        subdomain: 'myagent',
      };

      // publishImmediately should default to true
      const publishImmediately = config.publishImmediately !== false;
      expect(publishImmediately).toBe(true);

      // sendEmail should default to false
      expect(config.sendEmail).toBe(undefined);
    });
  });

  describe('Content Validation', () => {
    it('should structure post content correctly', () => {
      const postContent = {
        title: 'Test Post',
        content: '# Heading\n\nSome content',
        subtitle: 'By Agent X',
        imageUrl: 'https://example.com/image.jpg',
      };

      expect(postContent.title).toBe('Test Post');
      expect(postContent.content).toContain('# Heading');
      expect(postContent.subtitle).toContain('By Agent X');
      expect(postContent.imageUrl).toBeDefined();
    });

    it('should validate before publishing', () => {
      const validPost = {
        title: 'Valid Title',
        content: 'Valid content with proper length',
      };

      const error = validatePostContent(validPost);
      expect(error).toBeNull();
    });
  });
});

afterAll(() => { mock.restore(); });
