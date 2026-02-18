// Validate avatar config files against the RATi schema.
//
// Usage:
//   npx tsx scripts/validate-avatar-config.ts [path...]
//
// Examples:
//   npx tsx scripts/validate-avatar-config.ts avatars/my-avatar/config.yaml
//   npx tsx scripts/validate-avatar-config.ts avatars/*/config.yaml
//   npx tsx scripts/validate-avatar-config.ts rati/examples/avatar-config.base+extensions.json

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';

// Schema paths (relative to repo root)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '../rati/schema');
const FILE_SCHEMA_PATH = resolve(SCHEMA_DIR, 'avatar-config-file.v1.schema.json');

// Load all schemas for $ref resolution
function loadSchemas(): Record<string, object> {
  const schemas: Record<string, object> = {};

  const loadSchema = (relativePath: string) => {
    const fullPath = resolve(SCHEMA_DIR, relativePath);
    if (existsSync(fullPath)) {
      const content = JSON.parse(readFileSync(fullPath, 'utf-8'));
      schemas[content.$id || relativePath] = content;
      // Also register by relative path for local $ref resolution
      schemas[relativePath] = content;
    }
  };

  // Load main schemas
  loadSchema('avatar-config.v1.schema.json');
  loadSchema('avatar-config-file.v1.schema.json');
  loadSchema('base/avatar-base.v1.schema.json');

  // Load expansions
  const expansions = [
    'platforms', 'llm', 'media', 'scheduling', 'behavior',
    'tools-secrets', 'voice', 'solana', 'energy', 'dnd',
    'nft-avatar', 'integrations', 'stickers'
  ];
  for (const exp of expansions) {
    loadSchema(`expansions/${exp}.v1.schema.json`);
  }

  // Load NFT schema
  loadSchema('nft/metadata.v1.schema.json');

  return schemas;
}

function loadConfigFile(filePath: string): unknown {
  const ext = extname(filePath).toLowerCase();
  const content = readFileSync(filePath, 'utf-8');

  if (ext === '.yaml' || ext === '.yml') {
    return parseYaml(content);
  } else if (ext === '.json') {
    return JSON.parse(content);
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx scripts/validate-avatar-config.ts [path...]');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx scripts/validate-avatar-config.ts avatars/my-avatar/config.yaml');
    console.log('  npx tsx scripts/validate-avatar-config.ts avatars/*/config.yaml');
    process.exit(0);
  }

  // Initialize AJV
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);

  // Load and add schemas
  const schemas = loadSchemas();
  for (const [id, schema] of Object.entries(schemas)) {
    try {
      ajv.addSchema(schema, id);
    } catch (e) {
      // Schema may already be added via $id
    }
  }

  // Get the file schema validator
  const fileSchema = schemas['avatar-config-file.v1.schema.json'];
  if (!fileSchema) {
    console.error('❌ Could not load avatar-config-file.v1.schema.json');
    process.exit(1);
  }

  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(fileSchema);
  } catch (e) {
    console.error('❌ Failed to compile schema:', e);
    process.exit(1);
  }

  let hasErrors = false;

  for (const filePath of args) {
    const resolved = resolve(filePath);

    if (!existsSync(resolved)) {
      console.error(`❌ File not found: ${filePath}`);
      hasErrors = true;
      continue;
    }

    try {
      const config = loadConfigFile(resolved);
      const valid = validate(config);

      if (valid) {
        console.log(`✅ ${filePath}`);
      } else {
        console.log(`❌ ${filePath}`);
        for (const error of validate.errors || []) {
          const path = error.instancePath || '(root)';
          console.log(`   ${path}: ${error.message}`);
          if (error.params) {
            const params = Object.entries(error.params)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ');
            console.log(`      (${params})`);
          }
        }
        hasErrors = true;
      }
    } catch (e) {
      console.error(`❌ ${filePath}: ${e instanceof Error ? e.message : e}`);
      hasErrors = true;
    }
  }

  process.exit(hasErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
