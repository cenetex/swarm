// Local-only review server. All API responses use sample data.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = process.env.HOSTED_REVIEW_ROOT || fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.HOSTED_REVIEW_PORT || 3191);
const baseline = process.env.HOSTED_REVIEW_BASELINE;
const vite = await createViteServer({
  root,
  cacheDir: root + '/node_modules/.vite-hosted-review-' + port,
  configFile: false,
  plugins: [
    react(),
    {
      name: 'hosted-review-baseline',
      enforce: 'pre',
      load(id) {
        const name = id.split('/').at(-1);
        if (baseline && ['HostedApp.tsx', 'HostedCatalogApp.tsx'].includes(name)) {
          return execFileSync('git', ['show', baseline + ':packages/admin-ui/src/' + name], {
            cwd: root,
            encoding: 'utf8',
          });
        }
      },
    },
  ],
  server: { middlewareMode: true, hmr: false, host: '127.0.0.1' },
  appType: 'custom',
});
const revisionId = 'sha256:' + 'a'.repeat(64);
const seed = [
  {
    avatarId: 'ada',
    slug: 'ada',
    name: 'Ada',
    description: 'A curious research companion. Clear answers, careful thinking.',
    persona: 'Be curious, clear, and kind.',
    status: 'active',
  },
  {
    avatarId: 'penguinz-research',
    slug: 'penguinz-research',
    name: 'PENGUINZ',
    description: 'Research a topic and turn it into a clear brief.',
    persona: 'Help people explore creative ideas.',
    status: 'shell',
  },
  {
    avatarId: 'penguinz-planning',
    slug: 'penguinz-planning',
    name: 'PENGUINZ',
    description: 'Make a plan for your next project or busy week.',
    persona: 'Make the next step simple.',
    status: 'active',
  },
].map((avatar) => ({
  ...avatar,
  visibility: 'public',
  listed: true,
  controller: '11111111111111111111111111111111',
  revisionId,
  createdAt: 1,
  updatedAt: 1,
}));
let avatars = [...seed];
const project = (avatar) => ({
  ...avatar,
  sha256: 'a'.repeat(64),
  bundle: {
    schema: 'swarm.avatar/v1',
    identity: {
      avatarId: avatar.avatarId,
      slug: avatar.slug,
      name: avatar.name,
      description: avatar.description,
      controller: { type: 'solana-wallet', address: avatar.controller },
    },
    publication: { visibility: 'public', listed: true },
    prompts: { system: (avatar.persona + ' ').repeat(35), starters: [] },
    capabilities: [{ id: 'conversation', name: 'Conversation' }],
    sharedMemory: { summary: 'A fresh starting point for shared work.', entries: [] },
    media: [],
    lineage: {},
    revision: { createdAt: '2026-09-02T00:00:00Z' },
  },
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    const preview = new URL(req.headers.referer || 'http://127.0.0.1').searchParams.get('preview');
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const path = url.pathname.slice(4);
    if (path === '/auth/me') {
      const authProvider = preview === 'wallet-account' ? 'wallet' : 'passkey';
      return send({
        authenticated: preview !== 'signed-out',
        authProvider,
        user: { walletAddress: '11111111111111111111111111111111' },
        account: {
          accountId: 'review',
          role: 'user',
          identities: [{ type: 'wallet', providerId: '11111111111111111111111111111111' }],
        },
      });
    }
    if (path === '/auth/openrouter/status')
      return send({ connected: preview !== 'model', provider: preview === 'model' ? null : 'openrouter' });
    if (path === '/auth/mobile/start') {
      const pairingId = 'sample-mobile-pairing-1234567890';
      const purpose = input.purpose === 'link' ? 'link' : 'sign-in';
      const mobileUrl = new URL('/mobile-sign-in', `http://${req.headers.host}`);
      mobileUrl.searchParams.set('pairing', pairingId);
      if (purpose === 'link') mobileUrl.searchParams.set('purpose', 'link');
      return send({
        pairingId,
        pollToken: 'sample-private-poll-token-1234567890',
        mobileUrl: mobileUrl.toString(),
        verificationCode: 'SAMPLE',
        expiresAt: Date.now() + 300_000,
        purpose,
      }, 201);
    }
    if (/^\/auth\/mobile\/[A-Za-z0-9_-]+$/u.test(path) && req.method === 'GET') {
      return send({ status: 'pending', expiresAt: Date.now() + 300_000 }, 202);
    }
    if (path === '/public/avatars') return send(seed);
    if (path.startsWith('/public/avatars/'))
      return send(project(seed.find((avatar) => avatar.slug === path.split('/')[3]) || seed[0]));
    if (path === '/avatars/import') {
      const avatar = { ...seed[0], avatarId: 'imported', name: input.bundle.identity.name };
      avatars.unshift(avatar);
      return send(avatar);
    }
    if (path === '/avatars' && req.method === 'POST') {
      const avatar = { ...seed[0], ...input, avatarId: 'new-' + avatars.length };
      avatars.unshift(avatar);
      return send(avatar);
    }
    if (path === '/avatars') return send(preview === 'empty' ? [] : avatars);
    if (path.endsWith('/integrations/telegram'))
      return send({
        connected: true,
        status: 'connected',
        ownerBound: true,
        bot: { id: '123', username: 'SampleCompanionBot', name: 'Sample companion' },
        addToGroupUrl: 'https://t.me/SampleCompanionBot',
        groups: [],
      });
    if (path.endsWith('/integrations/x')) return send({ connected: false, status: 'disconnected' });
    if (path.startsWith('/avatars/') && req.method === 'PATCH') {
      const id = path.split('/')[2];
      avatars = avatars.map((avatar) => (avatar.avatarId === id ? { ...avatar, ...input } : avatar));
      return send(avatars.find((avatar) => avatar.avatarId === id));
    }
    if (path === '/chat' && req.method === 'POST') return send({ jobId: 'sample-job' });
    if (path === '/chat')
      return send({
        history: [
          { role: 'user', content: 'Help me turn a rough idea into a plan.' },
          {
            role: 'assistant',
            content:
              '<thinking>Sample internal reasoning.</thinking>**Start with the result you want.**\n\n- Name the smallest useful outcome.\n- Pick one action for today.\n\n```text\nA clear first version\n```\n\nWhat would a good first version look like?',
          },
        ],
      });
    if (path === '/jobs/sample-job')
      return send({
        jobId: 'sample-job',
        status: 'completed',
        response: 'Let’s start with one small step. What matters most to you?',
      });
    return send({ error: 'This action belongs to the local review only.' }, 404);
  }
  if (url.pathname === '/' || url.pathname === '/studio' || url.pathname.startsWith('/a/')) {
    const html = await vite.transformIndexHtml(req.url, await readFile(root + '/hosted.html', 'utf8'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log('Local hosted review: http://127.0.0.1:' + port));
