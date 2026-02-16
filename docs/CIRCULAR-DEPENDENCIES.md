# Circular Dependency Management

This document describes the circular dependency detection system and known circular dependencies in the codebase.

## Overview

The project uses automated circular dependency detection to prevent structural drift and maintain code quality. The system is implemented using:

1. **madge** - A tool that analyzes JavaScript/TypeScript module dependencies
2. **Custom script** (`scripts/check-circular-deps.mjs`) - Checks for circular imports with allowlist support
3. **CI integration** - Automatically runs on every PR to detect new circular dependencies

## Running Locally

```bash
# Check for circular dependencies
pnpm check:circular

# This will:
# - Scan all packages for circular imports
# - Report any new circular dependencies (blocking)
# - Show allowed circular dependencies (warning)
```

## Known Circular Dependencies

The following circular dependencies exist in the codebase and are temporarily allowed. They should be resolved over time:

### packages/core/src/types/

**Cycle:**
- `types/index.ts` → `types/service.ts` → `types/envelope.ts` → `types/platform.ts` → (back to `types/index.ts`)

**Description:**
The types module has a circular dependency through the barrel export (`index.ts`). The cycle exists because:
- `service.ts` imports types from `envelope.ts` and `platform.ts`
- `envelope.ts` imports types from `platform.ts`
- `platform.ts` re-exports types from `index.ts`
- `index.ts` exports everything including `service.ts`

**Resolution Strategy:**
1. **Option A (Recommended):** Remove the re-export layer in `platform.ts`. Instead of re-exporting from `index.ts`, define the platform types directly in `platform.ts` or create a new `platform-defs.ts` file.

2. **Option B:** Break the barrel export pattern for types and use explicit imports from individual type files.

3. **Option C:** Extract shared type primitives into a separate `types/primitives.ts` file that has no dependencies, and have other type files import from it instead of from each other.

## Resolving Circular Dependencies

When you encounter a circular dependency, here are common resolution strategies:

### 1. Extract Shared Types

Create a new file for shared type definitions:

```typescript
// Before (circular):
// a.ts
import { TypeB } from './b.js';
export type TypeA = { b: TypeB };

// b.ts
import { TypeA } from './a.js';
export type TypeB = { a: TypeA };

// After (resolved):
// shared.ts
export type TypeA = { b: TypeB };
export type TypeB = { a: TypeA };

// a.ts
export type { TypeA } from './shared.js';

// b.ts
export type { TypeB } from './shared.js';
```

### 2. Use Dependency Injection

Replace direct imports with dependency injection:

```typescript
// Before (circular):
// a.ts
import { serviceB } from './b.js';
export const serviceA = {
  doSomething: () => serviceB.helper()
};

// b.ts
import { serviceA } from './a.js';
export const serviceB = {
  helper: () => serviceA.value
};

// After (resolved):
// a.ts
export const createServiceA = (serviceB) => ({
  doSomething: () => serviceB.helper()
});

// b.ts  
export const createServiceB = (serviceA) => ({
  helper: () => serviceA.value
});

// index.ts
const serviceB = createServiceB();
const serviceA = createServiceA(serviceB);
serviceB.setServiceA(serviceA);
```

### 3. Restructure Module Hierarchy

Reorganize modules to create a clear dependency tree:

```typescript
// Before (circular):
// user.ts imports from auth.ts
// auth.ts imports from user.ts

// After (resolved):
// types.ts (no dependencies)
// user.ts (imports from types.ts)
// auth.ts (imports from types.ts and user.ts)
```

### 4. Use Type-Only Imports

TypeScript's type-only imports don't create runtime dependencies:

```typescript
// Use type-only import to break the cycle
import type { TypeA } from './a.js';

// Only for types, not values
export interface SomethingUsingTypeA {
  field: TypeA;
}
```

## CI Integration

The circular dependency check runs as part of the `lint` job in the CI pipeline:

```yaml
- name: Check circular dependencies
  run: pnpm check:circular
```

**Behavior:**
- ✅ **Pass:** No circular dependencies found, or only allowed circular dependencies exist
- ❌ **Fail:** New circular dependencies detected that are not in the allowlist

## Allowlist Management

The allowlist is defined in `scripts/check-circular-deps.mjs`:

```javascript
const ALLOWED_CYCLES = [
  'types/index.ts > types/service.ts > types/envelope.ts > types/platform.ts',
  // ... other allowed cycles
];
```

**Guidelines:**
- Only add cycles to the allowlist if they are existing technical debt
- Always add a corresponding TODO comment with a resolution plan
- Never add new circular dependencies to the allowlist without discussion
- Periodically review and resolve allowlisted cycles

## Troubleshooting

### False Positives

If madge reports a false positive (e.g., type-only circular dependencies that don't cause runtime issues), you can:

1. Verify it's truly a false positive by checking if it causes any runtime initialization issues
2. Add it to the allowlist with a clear comment explaining why it's safe
3. Consider refactoring anyway to improve code clarity

### Performance

Madge can be slow on large codebases. To speed up checks:

```bash
# Check a single package
npx madge --circular --extensions ts packages/core/src/

# Skip node_modules (done automatically by the script)
npx madge --circular --exclude 'node_modules/' packages/*/src/
```

## References

- [madge documentation](https://github.com/pahen/madge)
- [Circular dependencies in JavaScript explained](https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de)
- Issue #027: Add circular dependency detection to build pipeline
