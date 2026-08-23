import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultInput = resolve(packageDirectory, 'wrangler.json');
const defaultOutput = resolve(packageDirectory, 'wrangler.deploy.json');

const requiredVariables = [
  'SWARM_CF_WORKER_NAME',
  'SWARM_CF_D1_DATABASE_NAME',
  'SWARM_CF_D1_DATABASE_ID',
  'SWARM_CF_R2_BUCKET_NAME',
  'SWARM_CF_QUEUE_NAME',
  'SWARM_PUBLIC_URL',
  'SWARM_USER_SECRET_KEY_VERSION',
];

function requiredValue(values, name) {
  const value = values[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function resourceName(value, name) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw new Error(`${name} must contain 1-63 lowercase letters, numbers, or hyphens.`);
  }
  return value;
}

function publicOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SWARM_PUBLIC_URL must be an HTTPS origin without credentials, a path, query, or fragment.');
  }
  return url.origin;
}

function databaseId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('SWARM_CF_D1_DATABASE_ID must be a D1 UUID.');
  }
  return value;
}

function keyVersion(value) {
  if (!/^[A-Za-z0-9_]{1,40}$/u.test(value)) {
    throw new Error('SWARM_USER_SECRET_KEY_VERSION must contain only letters, numbers, or underscores.');
  }
  return value;
}

function rateLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('SWARM_HOSTED_CHAT_RATE_LIMIT must be an integer from 1 to 100.');
  }
  return String(parsed);
}

export function renderWranglerConfig(baseConfig, values, environment) {
  if (environment !== 'preview' && environment !== 'production') {
    throw new Error('Environment must be preview or production.');
  }
  for (const name of requiredVariables) requiredValue(values, name);

  const config = structuredClone(baseConfig);
  const workerName = resourceName(requiredValue(values, 'SWARM_CF_WORKER_NAME'), 'SWARM_CF_WORKER_NAME');
  const d1Name = resourceName(requiredValue(values, 'SWARM_CF_D1_DATABASE_NAME'), 'SWARM_CF_D1_DATABASE_NAME');
  const r2Name = resourceName(requiredValue(values, 'SWARM_CF_R2_BUCKET_NAME'), 'SWARM_CF_R2_BUCKET_NAME');
  const queueName = resourceName(requiredValue(values, 'SWARM_CF_QUEUE_NAME'), 'SWARM_CF_QUEUE_NAME');

  config.name = workerName;
  config.vars = {
    ...config.vars,
    SWARM_ENV: environment,
    SWARM_HOSTED_ENABLED: '1',
    SWARM_PUBLIC_URL: publicOrigin(requiredValue(values, 'SWARM_PUBLIC_URL')),
    SWARM_USER_SECRET_KEY_VERSION: keyVersion(requiredValue(values, 'SWARM_USER_SECRET_KEY_VERSION')),
    SWARM_OPENROUTER_MODEL: values.SWARM_OPENROUTER_MODEL?.trim() || 'openrouter/free',
    SWARM_HOSTED_CHAT_RATE_LIMIT: rateLimit(values.SWARM_HOSTED_CHAT_RATE_LIMIT?.trim() || '20'),
  };

  config.d1_databases[0].database_name = d1Name;
  config.d1_databases[0].database_id = databaseId(requiredValue(values, 'SWARM_CF_D1_DATABASE_ID'));
  config.r2_buckets[0].bucket_name = r2Name;
  config.queues.producers[0].queue = queueName;
  config.queues.consumers[0].queue = queueName;
  return config;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const environment = readArgument('--environment');
  const input = resolve(readArgument('--input') ?? defaultInput);
  const output = resolve(readArgument('--output') ?? defaultOutput);
  const baseConfig = JSON.parse(await readFile(input, 'utf8'));
  const config = renderWranglerConfig(baseConfig, process.env, environment);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Rendered ${output} for ${environment}.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
