// Import and re-export root eslint config with no-console enforcement
import config from '../../eslint.config.js';

export default [
  ...config,
  // Enforce no-console in production code — use logger from @swarm/core instead.
  {
    files: ['src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
];
