# Secure Logging Best Practices

This document outlines secure logging practices for the AWS Swarm project to prevent accidental exposure of sensitive data.

## Overview

The codebase uses an ESLint rule (`no-sensitive-logs`) to detect potentially unsafe logging patterns. This guide explains what to avoid and what patterns are safe.

## 🚨 Never Log These

### 1. Sensitive Variable Values
**Never log** variables or properties with these names:
- `token`, `apiToken`, `accessToken`, `refreshToken`
- `key`, `apiKey`, `privateKey`, `walletKey`
- `secret`, `apiSecret`, `appSecret`
- `password`, `passphrase`
- `credential`, `credentials`
- `bearer`, `authorization`

**Bad:**
```typescript
console.log('API Key:', apiKey);
console.log({ token: userToken });
console.error('Auth failed with credential:', credential);
```

**Good:**
```typescript
console.log('API Key status:', apiKey ? 'present' : 'missing');
console.log('Token length:', token?.length ?? 0);
console.log('Using credential:', credentialName); // Log the name, not the value
```

### 2. Full Request/Response Objects
**Never log** entire request/response objects as they may contain sensitive headers, cookies, or bodies.

**Bad:**
```typescript
console.log('Request:', request);
console.error('Failed request:', req);
console.log('Response:', response);
```

**Good:**
```typescript
console.log('Request method:', request.method, 'path:', request.path);
console.log('Response status:', response.status);
console.log('Request ID:', request.headers['x-request-id']);
```

### 3. Full Error Objects
**Never log** error objects directly as they may contain sensitive context in their properties or stack traces.

**Bad:**
```typescript
try {
  await someOperation();
} catch (error) {
  console.error('Operation failed:', error);
}
```

**Good:**
```typescript
try {
  await someOperation();
} catch (error) {
  // Log only the error message, with a fallback for non-Error objects
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Operation failed: ${errorMessage}`);
}
```

**Note**: Use `'Unknown error'` as the fallback instead of `String(error)` to avoid accidentally logging sensitive error context.

## ✅ Safe Logging Patterns

### 1. Error Messages Only
Always extract and log only the error message, not the full error object:

```typescript
catch (error) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Failed to process: ${errorMessage}`);
}
```

### 2. Structured Logging with Explicit Fields
Use structured logging with explicit, non-sensitive fields:

```typescript
console.log(JSON.stringify({
  level: 'INFO',
  subsystem: 'twitter-oauth',
  event: 'oauth_success',
  avatarId,
  username,
  timestamp: Date.now(),
}));
```

### 3. Metadata Only
Log counts, lengths, statuses, IDs, and other metadata:

```typescript
console.log(`Processed ${items.length} items`);
console.log('User ID:', userId);
console.log('Status:', isAuthenticated ? 'authenticated' : 'unauthenticated');
console.log('Wallet address:', walletAddress.slice(0, 8) + '...');
```

### 4. Sanitized/Truncated Values
When you must log partial values for debugging, truncate them:

```typescript
console.log(`Challenge for wallet=${walletAddress.slice(0, 8)}...`);
console.log(`Nonce: ${nonce.slice(0, 16)}...`);
```

## Structured Logger Usage

For avatar-specific or system logs, use the structured logger:

```typescript
import { createAvatarLogger, createSystemLogger } from './services/structured-logger.js';

// Avatar-specific logger
const log = createAvatarLogger(avatarId, 'telegram');
log.info('chat', 'message_received', { userId, messageId, textLength: text.length });
log.error('llm', 'api_timeout', { provider: 'anthropic', attemptCount });

// System logger
const sysLog = createSystemLogger('auth');
sysLog.warn('rate-limit', 'threshold_exceeded', { key: rateLimitKey.slice(0, 8) });
```

The structured logger:
- Automatically formats logs as JSON
- Writes to both CloudWatch Logs and DynamoDB
- Includes contextual fields (avatarId, platform, requestId)
- Encourages explicit field naming (prevents accidental leaks)

## Secret Access Logging

**Do NOT log when secrets are accessed.** Secret access is already tracked via:
- CloudWatch metrics (AWS Secrets Manager API calls)
- Request logs with requestId correlation
- AWS CloudTrail

Logging secret names/types creates an attack surface by revealing:
- Which secrets exist
- When they are used
- Usage patterns

## ESLint Integration

The `no-sensitive-logs` ESLint rule automatically detects unsafe patterns:

```bash
# Run the linter
pnpm lint

# Auto-fix safe violations (won't auto-fix sensitive data issues)
pnpm lint --fix
```

The rule is configured as a **warning** (not error) because some cases require human judgment.

## Migration Checklist

When updating existing console statements:

- [ ] Identify if the log contains sensitive data
- [ ] Replace with structured logger if in a handler/service
- [ ] Extract only error.message from error objects
- [ ] Truncate/sanitize any potentially sensitive values
- [ ] Log metadata/counts instead of full objects
- [ ] Test that the log still provides useful debugging info

## Examples from Codebase

### Before (Insecure)
```typescript
// packages/admin-api/src/services/secrets.ts
console.warn(`[AUDIT] Secret value accessed: avatar=${avatarId ?? 'GLOBAL'}, type=${secretType}, name=${name}`);

// packages/admin-api/src/services/twitter-oauth.ts
console.error('Failed to get Twitter credentials:', error);
```

### After (Secure)
```typescript
// packages/admin-api/src/services/secrets.ts
// Removed - secret access already tracked via CloudWatch/CloudTrail

// packages/admin-api/src/services/twitter-oauth.ts
const errorMessage = error instanceof Error ? error.message : 'Unknown error';
console.error(`Failed to get Twitter credentials: ${errorMessage}`);
```

## References

- ESLint rule: `/eslint-plugin-no-sensitive-logs.js`
- Structured logger: `/packages/admin-api/src/services/structured-logger.ts`
- Security guidelines: `/CLAUDE.md#security-guidelines`
