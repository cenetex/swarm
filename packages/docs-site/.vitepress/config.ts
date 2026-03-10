import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Swarm API',
  description: 'API documentation for the Swarm avatar platform',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Swarm API',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/chat-completions' },
      { text: 'Dashboard', link: 'https://swarm.rati.chat' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Energy System', link: '/guide/energy' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Chat Completions', link: '/api/chat-completions' },
          { text: 'Models', link: '/api/models' },
          { text: 'Streaming', link: '/api/streaming' },
          { text: 'Voice Audio', link: '/api/voice' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Error Codes', link: '/reference/errors' },
          { text: 'Rate Limits', link: '/reference/rate-limits' },
          { text: 'SDK Examples', link: '/reference/sdk-examples' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cenetex/aws-swarm' },
      { icon: 'discord', link: 'https://discord.gg/swarm' },
    ],
    footer: {
      message: 'OpenAI-compatible API for AI avatars',
      copyright: 'RATiMICS',
    },
    search: {
      provider: 'local',
    },
  },
});
