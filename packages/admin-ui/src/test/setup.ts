import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Automatic cleanup after each test
afterEach(() => {
  cleanup();
});

// Stub import.meta.env for tests
if (typeof import.meta.env === 'undefined') {
  // @ts-expect-error test setup
  import.meta.env = {};
}
if (!import.meta.env.VITE_API_URL) {
  (import.meta.env as Record<string, string>).VITE_API_URL = 'http://localhost:4000';
}
