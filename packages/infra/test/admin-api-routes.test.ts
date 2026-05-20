import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = readFileSync(resolve(__dirname, '../src/constructs/admin-api.ts'), 'utf8');

function expectRoute(path: string, methods: string[]) {
  const escapedPath = path.replace(/[{}]/g, match => `\\${match}`);
  const escapedMethods = methods
    .map(method => `apigateway\\.HttpMethod\\.${method}`)
    .join(',\\s*');
  const routeMatch = src.match(
    new RegExp(
      `this\\.api\\.addRoutes\\(\\{\\s*path:\\s*'${escapedPath}',\\s*methods:\\s*\\[${escapedMethods}\\],\\s*integration:\\s*avatarsIntegration,\\s*\\}\\);`,
    ),
  );

  expect(routeMatch).not.toBeNull();
}

describe('AdminApiConstruct avatar routes', () => {
  it('registers POST /avatars/scan-nft with the avatars Lambda', () => {
    expectRoute('/avatars/scan-nft', ['POST']);
  });

  it('registers Telegram dashboard routes with the avatars Lambda', () => {
    expectRoute('/avatars/{avatarId}/telegram/state', ['GET']);
    expectRoute('/avatars/{avatarId}/telegram/allowed-chats/{chatId}', ['DELETE']);
    expectRoute('/avatars/{avatarId}/telegram/allowed-dmers/{userId}', ['DELETE']);
  });
});
