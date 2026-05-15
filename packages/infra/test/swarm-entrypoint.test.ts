import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = readFileSync(resolve(__dirname, '../bin/swarm.ts'), 'utf8');

describe('CDK app entrypoint', () => {
  it('passes enableDiscordGateway context into AdminApiStack', () => {
    expect(src).toContain(
      "const enableDiscordGateway = parseBoolean(getContextValue<unknown>('enableDiscordGateway', envConfig)) ?? false;"
    );
    expect(src).toContain('  enableDiscordGateway,\n');
    expect(src).not.toContain('  enableDiscordGateway: false,');
  });
});
