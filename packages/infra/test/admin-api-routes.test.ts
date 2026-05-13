import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = readFileSync(resolve(__dirname, '../src/constructs/admin-api.ts'), 'utf8');

describe('AdminApiConstruct avatar routes', () => {
  it('registers POST /avatars/scan-nft with the avatars Lambda', () => {
    const scanNftRouteMatch = src.match(
      /this\.api\.addRoutes\(\{\s*path:\s*'\/avatars\/scan-nft',\s*methods:\s*\[apigateway\.HttpMethod\.POST\],\s*integration:\s*avatarsIntegration,\s*\}\);/
    );

    expect(scanNftRouteMatch).not.toBeNull();
  });
});
