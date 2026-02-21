import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = readFileSync(resolve(__dirname, '../src/constructs/admin-api.ts'), 'utf8');

describe('AdminApiConstruct chat worker IAM permissions (issue #232)', () => {
  it('grants explicit GSI1 query permission to chat worker', () => {
    const workerPermissionsMatch = src.match(
      /\/\/ Worker permissions[\s\S]*?this\.chatWorkerHandler\.addToRolePolicy\(\s*new iam\.PolicyStatement\(\{\s*actions:\s*\['dynamodb:Query'\],\s*resources:\s*\[`\$\{this\.table\.tableArn\}\/index\/GSI1`\],\s*\}\)\s*\);[\s\S]*?llmApiKey\.grantRead\(this\.chatWorkerHandler\);/
    );

    expect(src).toContain('this.table.grantReadWriteData(this.chatWorkerHandler);');
    expect(workerPermissionsMatch).not.toBeNull();
  });
});
