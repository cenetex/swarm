/**
 * Claude Code Worker Entry Point
 *
 * ECS Fargate task that processes Claude Code jobs from SQS.
 */
export * from './types.js';
export { runWorker } from './worker.js';
export { createClaudeCodeServices } from './services.js';

// Run worker if executed directly
if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  const { runWorker } = await import('./worker.js');
  runWorker().catch((error) => {
    console.error('Worker crashed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
