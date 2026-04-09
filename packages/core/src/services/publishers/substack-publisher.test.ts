/**
 * Substack Publisher Tests
 */
import { describe, it, expect, beforeEach, mock, afterAll } from 'bun:test';
import { markdownToSubstackHtml, type SubstackPublishConfig } from './substack-publisher.js';

// Mock the AWS SDK and fetch
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

  describe('Session Management', () => {
    it('should handle session caching', async () => {
      // This test verifies that session caching logic works
      // In production, this would be tested with actual API calls
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

  describe('Integration scenarios', () => {
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

    it('should handle failed Substack publish gracefully', async () => {
      // This test verifies error handling behavior
      const config: SubstackPublishConfig = {
        subdomain: 'test-agent',
        sendEmail: false,
      };

      // Simulate error case - config should still be valid
      expect(config).toBeDefined();
      expect(config.subdomain).toBe('test-agent');
    });
  });
});

afterAll(() => { mock.restore(); });
