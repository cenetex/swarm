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

describe('AdminApiConstruct entitlement fallback alarm (issue #232)', () => {
  it('defines an EntitlementFallbackAlarm on the Swarm/EntitlementFallback metric', () => {
    expect(src).toContain("'EntitlementFallbackAlarm'");
    expect(src).toContain("namespace: 'Swarm'");
    expect(src).toContain("metricName: 'EntitlementFallback'");
    expect(src).toContain("Subsystem: 'Entitlements'");
  });

  it('wires the entitlement fallback alarm to SNS notifications', () => {
    expect(src).toContain('entitlementFallbackAlarm');
    // Verify it appears in the alarm array that gets wired to snsAction
    const alarmArrayMatch = src.match(
      /for \(const alarm of \[[\s\S]*?entitlementFallbackAlarm[\s\S]*?\]\)/
    );
    expect(alarmArrayMatch).not.toBeNull();
  });
});

describe('AdminApiConstruct NFT ownership wiring', () => {
  it('passes Helius secret config to NFT-backed chat request paths', () => {
    const heliusEnvCount = [...src.matchAll(/HELIUS_API_KEY_ARN: heliusApiKeySecret\?\.secretArn \|\| ''/g)].length;

    expect(heliusEnvCount).toBeGreaterThanOrEqual(4);
  });

  it('grants Helius secret read access to chat handler and chat worker', () => {
    const chatHandlerGrantMatch = src.match(
      /llmApiKey\.grantRead\(this\.chatHandler\);\s*if \(heliusApiKeySecret\) \{\s*heliusApiKeySecret\.grantRead\(this\.chatHandler\);\s*\}/
    );
    const chatWorkerGrantMatch = src.match(
      /llmApiKey\.grantRead\(this\.chatWorkerHandler\);\s*if \(heliusApiKeySecret\) \{\s*heliusApiKeySecret\.grantRead\(this\.chatWorkerHandler\);\s*\}/
    );

    expect(chatHandlerGrantMatch).not.toBeNull();
    expect(chatWorkerGrantMatch).not.toBeNull();
  });
});
