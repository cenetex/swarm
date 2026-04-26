# admin-ui — contributor notes

React SPA for the admin UI. Build: Vite. Tests: split between bun and vitest (see below).

## How to write a test

Two test runners cover this package, routed by file extension:

| File extension | Runner | Environment | Use for |
|----------------|--------|-------------|---------|
| `*.test.ts`    | bun    | Node        | Logic-only tests: pure functions, hook internals that don't touch the React tree, fetch/response shape checks. |
| `*.test.tsx`   | vitest | jsdom       | Anything that touches `document`, `window`, `matchMedia`, or uses `@testing-library/react`'s `render` / `renderHook`. |

The monorepo runner (`scripts/test-isolated.sh`) picks both up automatically — you just name the file correctly.

### DOM test canary

`src/components/tool-prompts/useToolPromptState.test.tsx` is the reference test for `renderHook` under the vitest harness. Copy its imports when you need to start a new component or hook test.

```ts
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
```

Setup (jsdom environment, `matchMedia` polyfill, automatic `cleanup()` after each test) is configured in `src/test/setup.ts` and wired by `vitest.config.ts`. You shouldn't have to touch either.

### Running tests locally

```bash
# All admin-ui DOM tests:
pnpm --filter @swarm/admin-ui test

# Single DOM test file:
pnpm --filter @swarm/admin-ui exec vitest run src/path/to/foo.test.tsx

# Bun-side logic tests for this package only:
bun test packages/admin-ui
```

### Things to avoid

- Don't put `@testing-library/react` imports in `.test.ts` files — bun doesn't have `document`, the import will fail at runtime. If the test needs DOM, rename to `.test.tsx`.
- Don't add a second DOM polyfill (happy-dom, linkedom). jsdom is already a devDep; a second polyfill is more ecosystem drift than signal.
- Don't loosen `test.exclude` in `vitest.config.ts` to include `*.test.ts` — those are bun's.
