/**
 * Gallery Tools Tests
 *
 * Tests for gallery and reference image management tools.
 */
import { describe, it, expect } from 'vitest';
import { createGalleryTools, type GalleryServices, type GalleryItem } from './gallery.js';

const mockGalleryItems: GalleryItem[] = [
  {
    id: 'img-1',
    type: 'image',
    url: 'https://example.com/image1.jpg',
    prompt: 'First image',
    createdAt: Date.now(),
  },
  {
    id: 'img-2',
    type: 'image',
    url: 'https://example.com/image2.jpg',
    prompt: 'Second image',
    createdAt: Date.now() - 1000,
  },
];

const mockGalleryServices: GalleryServices = {
  getGallery: async (avatarId: string) => {
    if (avatarId === 'empty') return [];
    return mockGalleryItems;
  },

  getGalleryItem: async (_avatarId: string, itemId: string) => {
    return mockGalleryItems.find(item => item.id === itemId) || null;
  },

  searchGallery: async (_avatarId: string, _query: string) => {
    return mockGalleryItems;
  },
};

describe('Gallery Tools - get_my_gallery', () => {
  it('lists gallery images', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Array);
    expect(result.data.length).toBe(2);
    expect(result.data[0]).toHaveProperty('id');
    expect(result.data[0]).toHaveProperty('url');
  });

  it('returns empty array when no images exist', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');

    const result = await (tool!.execute as any)({}, {
      avatarId: 'empty',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - send_gallery_image', () => {
  it('sends gallery image to chat', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');
    expect(tool).toBeDefined();

    // Just verify the tool exists and has correct structure
    expect(tool?.description).toContain('gallery');
  });

  it('returns success with media for valid imageId', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const result = await (tool!.execute as any)({ imageId: 'img-1' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.media).toBeDefined();
    expect(result.media.type).toBe('image');
    expect(result.media.url).toBe('https://example.com/image1.jpg');
    expect(result.data).toEqual({ id: 'img-1', url: 'https://example.com/image1.jpg' });
    expect(result.error).toBeUndefined();
  });

  it('returns success:false with actionable error for nonexistent imageId', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const result = await (tool!.execute as any)({ imageId: 'nonexistent-id-999' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('not found');
    expect(result.error).toContain('get_my_gallery');
    // Must NOT contain media or data that could be rendered as a broken image
    expect(result.media).toBeUndefined();
    expect(result.data).toBeUndefined();
  });

  it('error message starts with FAILED: to prevent LLM from claiming success', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const result = await (tool!.execute as any)({ imageId: 'stale-id' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error!.startsWith('FAILED:')).toBe(true);
  });

  it('error mentions stale ID possibility and deleted images', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const result = await (tool!.execute as any)({ imageId: 'deleted-image' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.error).toContain('stale');
    expect(result.error).toContain('deleted');
  });

  it('returns success:false with actionable error when ID is not an image item', async () => {
    const nonImageServices: GalleryServices = {
      ...mockGalleryServices,
      getGalleryItem: async () => ({
        id: 'vid-1',
        type: 'video',
        url: 'https://example.com/video1.mp4',
        prompt: 'Video clip',
        createdAt: Date.now(),
      }),
    };
    const tools = createGalleryTools(nonImageServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const result = await (tool!.execute as any)({ imageId: 'vid-1' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('not an image');
    expect(result.error).toContain('type "image"');
    // Must NOT contain media or data that could be rendered as an image
    expect(result.media).toBeUndefined();
    expect(result.data).toBeUndefined();
  });

  it('builds image-only context for send_gallery_image to avoid non-image IDs', async () => {
    const mixedItems: GalleryItem[] = [
      {
        id: 'vid-1',
        type: 'video',
        url: 'https://example.com/video1.mp4',
        prompt: 'Video clip',
        createdAt: Date.now(),
      },
      {
        id: 'img-10',
        type: 'image',
        url: 'https://example.com/image10.jpg',
        prompt: 'Sunset photo',
        createdAt: Date.now() - 1000,
      },
      {
        id: 'stk-1',
        type: 'sticker',
        url: 'https://example.com/sticker1.webp',
        prompt: 'Sticker',
        createdAt: Date.now() - 2000,
      },
      {
        id: 'img-11',
        type: 'image',
        url: 'https://example.com/image11.jpg',
        prompt: 'Forest photo',
        createdAt: Date.now() - 3000,
      },
    ];

    const mixedServices: GalleryServices = {
      getGallery: async (_avatarId: string, options) => {
        if (options.type) {
          return mixedItems.filter(item => item.type === options.type);
        }
        return mixedItems;
      },
      getGalleryItem: async (_avatarId: string, itemId: string) => {
        return mixedItems.find(item => item.id === itemId) || null;
      },
      searchGallery: async () => mixedItems,
    };

    const tools = createGalleryTools(mixedServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const contextText = await tool!.contextBuilder!({
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(contextText).toContain('img-10');
    expect(contextText).toContain('img-11');
    expect(contextText).not.toContain('vid-1');
    expect(contextText).not.toContain('stk-1');
  });

  it('validates required imageId field', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const valid = tool!.inputSchema.safeParse({
      imageId: 'img-123',
    });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('rejects blank imageId values', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const blank = tool!.inputSchema.safeParse({ imageId: '   ' });

    expect(blank.success).toBe(false);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - search_gallery', () => {
  it('searches gallery by query', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');
    expect(tool).toBeDefined();

    expect(tool?.description).toContain('Search');
  });

  it('validates required query field', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');

    const valid = tool!.inputSchema.safeParse({ query: 'cat images' });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - Service Interface', () => {
  it('creates tools with valid service interface', () => {
    const tools = createGalleryTools(mockGalleryServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('all gallery tools have gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const galleryTools = tools.filter(t => t.category === 'gallery');

    expect(galleryTools.length).toBe(tools.length);
  });
});
