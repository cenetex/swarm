import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

const storageItems = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return storageItems.size;
  },
  clear() {
    storageItems.clear();
  },
  getItem(key: string) {
    return storageItems.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(storageItems.keys())[index] ?? null;
  },
  removeItem(key: string) {
    storageItems.delete(key);
  },
  setItem(key: string, value: string) {
    storageItems.set(key, String(value));
  },
};

// Node 25 exposes a process-level localStorage object that is not usable
// without --localstorage-file. Tests need the browser contract from jsdom,
// independent of the Node version running Vitest.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
});

// Polyfill window.matchMedia for jsdom (used by theme store)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Automatic cleanup after each test
beforeEach(() => {
  testLocalStorage.clear();
});

afterEach(() => {
  cleanup();
});

// Ensure VITE_API_URL is set for tests (import.meta.env is provided by Vite/Vitest)
if (!import.meta.env.VITE_API_URL) {
  (import.meta.env as Record<string, string>).VITE_API_URL = 'http://localhost:4000';
}
