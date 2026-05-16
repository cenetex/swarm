import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const shouldSkip = ['1', 'true', 'yes'].includes(String(process.env.SKIP_UI_SMOKE || '').toLowerCase());
if (shouldSkip) {
  console.log('smoke-admin-ui: SKIP_UI_SMOKE set; skipping');
  process.exit(0);
}

const PORT = process.env.SMOKE_UI_PORT || '4173';
const URL = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return;
    } catch {
      // ignore until server is up
    }
    await delay(500);
  }
  throw new Error(`Admin UI preview did not become ready within ${timeoutMs}ms at ${url}`);
}

async function runSmoke() {
  const preview = spawn(
    'pnpm',
    ['--filter', '@swarm/admin-ui', 'preview', '--', '--port', PORT, '--strictPort'],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );

  try {
    await waitForServer(URL);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];

    const isAllowedError = (entry) => {
      const message = entry.message || '';
      const locationUrl = entry.locationUrl || '';

      if (/\[WalletAuth\] Check auth error: SyntaxError: Unexpected token '<'/i.test(message)) return true;
      if (/\[bootstrapAuth\] Auth bootstrap failed: SyntaxError: Unexpected token '<'/i.test(message)) return true;
      if (/Failed to fetch/i.test(message)) return true;

      // Browser may request favicon.ico in preview; missing icon is non-fatal for smoke.
      if (
        /Failed to load resource: the server responded with a status of 404/i.test(message) &&
        /\/favicon\.ico($|\?)/i.test(locationUrl)
      ) {
        return true;
      }

      // External fonts are cosmetic and may be blocked in local/sandboxed
      // smoke environments. The app still needs to render without them.
      if (
        /Failed to load resource/i.test(message) &&
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(locationUrl)
      ) {
        return true;
      }

      // API backend is not running during local/CI preview — proxy returns
      // 500 (no target) or 502 (ECONNREFUSED from vite's proxy middleware).
      // Both are expected when no admin-api lambda is up.
      if (
        /Failed to load resource: the server responded with a status of 5\d{2}/i.test(message) &&
        /\/(api|auth)\//i.test(locationUrl)
      ) {
        return true;
      }

      // Privy telemetry and iframe restrictions are expected in local preview.
      if (
        /Failed to load resource: the server responded with a status of 403/i.test(message) &&
        /auth\.privy\.io\/api\/v1\/analytics_events/i.test(locationUrl)
      ) {
        return true;
      }
      if (/Framing 'https:\/\/auth\.privy\.io\/' violates/i.test(message)) return true;

      return false;
    };

    page.on('pageerror', (err) => {
      errors.push({ message: err?.message || String(err), locationUrl: '' });
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        errors.push({
          message: msg.text(),
          locationUrl: loc.url || '',
        });
      }
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    const bodyText = await page.textContent('body');
    if (bodyText && bodyText.includes('Privy is not configured')) {
      throw new Error('Privy is not configured. Set VITE_PRIVY_APP_ID in packages/admin-ui/.env.');
    }

    const filtered = errors.filter((entry) => !isAllowedError(entry));
    if (filtered.length > 0) {
      throw new Error(
        `Admin UI console errors:\n- ${filtered
          .map((entry) => `${entry.message}${entry.locationUrl ? ` [${entry.locationUrl}]` : ''}`)
          .join('\n- ')}`
      );
    }

    await browser.close();
  } finally {
    preview.kill('SIGTERM');
  }
}

runSmoke().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
