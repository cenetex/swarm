import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workerSrc = readFileSync(resolve(__dirname, '../src/constructs/discord-gateway-worker.ts'), 'utf8');
const stackSrc = readFileSync(resolve(__dirname, '../src/stacks/admin-api-stack.ts'), 'utf8');

describe('DiscordGatewayWorker infrastructure wiring', () => {
  it('passes the admin table to the gateway for shared-room ledger access', () => {
    expect(workerSrc).toContain('adminTable?: dynamodb.ITable;');
    expect(workerSrc).toContain('ADMIN_TABLE: adminTable.tableName');
    expect(workerSrc).toContain('SHARED_ROOM_TABLE: adminTable.tableName');
    expect(workerSrc).toContain('adminTable?.grantReadWriteData(this.taskDefinition.taskRole);');
  });

  it('imports and passes the admin table whenever the gateway is enabled', () => {
    expect(stackSrc).toMatch(/const sharedAdminTable =\s+adminEmails \|\| enableDiscordGateway/);
    expect(stackSrc).toContain('adminTable: sharedAdminTable,');
  });
});
