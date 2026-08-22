/**
 * Swarm Desktop — application entry point (Tauri sidecar).
 *
 * Launched by the Tauri Rust backend. Accepts --password to skip
 * interactive prompt. Prints "running at http://localhost:{port}"
 * to stdout when ready (Tauri reads this to detect readiness).
 */
import { mkdirSync } from 'fs';
import { startServer } from './server.js';

const args = process.argv.slice(2);

function parseArg(flag: string): string | undefined {
  const eqFlag = args.find((a) => a.startsWith(`${flag}=`));
  if (eqFlag) return eqFlag.slice(eqFlag.indexOf('=') + 1);
  const idx = args.findIndex((a) => a === flag);
  if (idx !== -1) {
    const next = args[idx + 1];
    // If the next arg looks like another flag, someone forgot the value
    if (!next || next.startsWith("-")) return undefined;
    return next;
  }
  return undefined;
}

const password = parseArg('--password');
const adminUiPath = parseArg('--admin-ui-path');

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.SWARM_HOST ?? '127.0.0.1';
const HOME = process.env.HOME ?? '/tmp';
const DB_PATH = process.env.SWARM_DB_PATH ?? `${HOME}/Library/Application Support/Swarm/swarm.db`;
const BLOB_DIR = process.env.SWARM_BLOB_DIR ?? `${HOME}/Library/Application Support/Swarm/blobs`;

async function startApp(): Promise<string> {
  mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  mkdirSync(BLOB_DIR, { recursive: true });

  const { services } = await startServer({
    port: PORT,
    host: HOST,
    dbPath: DB_PATH,
    blobDir: BLOB_DIR,
    password,
    adminUiPath,
  });

  process.on('SIGINT', () => { services.shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { services.shutdown(); process.exit(0); });

  return `http://${HOST}:${PORT}`;
}

startApp().then((url) => {
  console.log(`Server running at ${url}`); // Tauri parses this line
}).catch((err) => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
