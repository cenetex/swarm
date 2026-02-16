import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import noSensitiveLogs from './eslint-plugin-no-sensitive-logs.js';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'no-sensitive-logs': {
        rules: {
          'no-sensitive-logs': noSensitiveLogs,
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'no-sensitive-logs/no-sensitive-logs': 'warn',
    },
  },
  // React Hooks rules (admin UI only)
  {
    files: ['packages/admin-ui/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  // Suppress no-explicit-any in test files (mocking often requires any)
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/cdk.out/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  }
);
