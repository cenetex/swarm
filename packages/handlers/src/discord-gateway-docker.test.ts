/**
 * Discord Gateway Docker Build Validation Tests
 *
 * Ensures the Dockerfile.discord-gateway CMD path matches the actual
 * TypeScript compilation output. A mismatch here causes a startup crash
 * in the ECS Fargate container (issue #210).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLERS_ROOT = resolve(__dirname, '..');
const DOCKERFILE_PATH = resolve(HANDLERS_ROOT, 'Dockerfile.discord-gateway');

describe('Dockerfile.discord-gateway', () => {
  it('Dockerfile exists', () => {
    expect(existsSync(DOCKERFILE_PATH)).toBe(true);
  });

  it('CMD entry point path matches the compiled output location', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');

    // Extract the CMD path from the Dockerfile
    // Matches: CMD ["node", "dist/discord/discord-gateway-shared.js"]
    const cmdMatch = dockerfile.match(/CMD\s+\["node",\s*"([^"]+)"\]/);
    expect(cmdMatch).not.toBeNull();
    const cmdPath = cmdMatch![1];

    // The source file is at src/discord/discord-gateway-shared.ts
    // After tsc with rootDir=src and outDir=dist, it compiles to:
    //   dist/discord/discord-gateway-shared.js
    const expectedPath = 'dist/discord/discord-gateway-shared.js';
    expect(cmdPath).toBe(expectedPath);
  });

  it('CMD entry point file exists after build', () => {
    // After `pnpm build`, the compiled JS should exist at the expected location
    const expectedFile = resolve(HANDLERS_ROOT, 'dist', 'discord', 'discord-gateway-shared.js');
    expect(existsSync(expectedFile)).toBe(true);
  });

  it('entry point detection matches the CMD path basename', () => {
    // The discord-gateway-shared.ts has:
    //   const isDirectExecution = process.argv[1]?.endsWith('discord-gateway-shared.js');
    // This should match regardless of directory nesting
    const source = readFileSync(
      resolve(__dirname, 'discord', 'discord-gateway-shared.ts'),
      'utf-8'
    );

    const entryPointMatch = source.match(/process\.argv\[1\]\?\.endsWith\('([^']+)'\)/);
    expect(entryPointMatch).not.toBeNull();
    const endsWith = entryPointMatch![1];

    // The CMD path should end with this value
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
    const cmdMatch = dockerfile.match(/CMD\s+\["node",\s*"([^"]+)"\]/);
    expect(cmdMatch![1].endsWith(endsWith)).toBe(true);
  });

  it('HEALTHCHECK pattern matches the CMD process', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');

    // Extract healthcheck pattern
    const healthMatch = dockerfile.match(/pgrep\s+-f\s+"([^"]+)"/);
    expect(healthMatch).not.toBeNull();
    const pattern = healthMatch![1];

    // Extract CMD path
    const cmdMatch = dockerfile.match(/CMD\s+\["node",\s*"([^"]+)"\]/);
    const cmdPath = cmdMatch![1];

    // The pgrep pattern "node.*discord-gateway" should match the CMD
    const processString = `node ${cmdPath}`;
    const regex = new RegExp(pattern);
    expect(regex.test(processString)).toBe(true);
  });
});
