// Test environment setup - preloaded before test files
process.env.STATE_TABLE = process.env.STATE_TABLE || 'test-state-table';
process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'test-admin-table';
process.env.MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL || 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue';
