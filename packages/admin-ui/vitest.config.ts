import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * DOM-capable test harness for admin-ui (#1455).
 *
 * Kept separate from vite.config.ts so the dev server doesn't pull in the
 * jsdom environment. Runs every test file that needs `document`, `window`,
 * or React's test dispatcher — in practice, anything using
 * @testing-library/react's render / renderHook.
 *
 * Convention:
 *   *.test.tsx → runs here (jsdom, vitest)
 *   *.test.ts  → runs under bun via scripts/test-isolated.sh
 *
 * The .tsx suffix is how we route. Bun's test discovery in test-isolated.sh
 * uses `find -name '*.test.ts'`, so .test.tsx files are invisible to it.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx'],
    // .test.ts files live under bun — vitest must not pick them up here.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.test.ts'],
    clearMocks: true,
  },
});
