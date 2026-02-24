# @swarm/layer

Lambda layer packaging for native modules and Node.js compatibility shims.

## Purpose

AWS Lambda functions need native binaries (e.g. `sharp` for image processing) compiled for the Lambda execution environment (Linux x64). This package builds a Lambda layer that bundles:

1. **sharp** -- High-performance image processing, compiled for `linux-x64`
2. **node-fetch shim** -- Maps `node-fetch` imports to the native `fetch` available in Node.js 20+
3. **abort-controller shim** -- Maps `abort-controller` imports to the global `AbortController` in Node.js 20+

The shims exist because some transitive dependencies still `require('node-fetch')` or `require('abort-controller')` even though both are built into Node.js 20+.

## Building

```bash
pnpm run build:layer
```

This:
1. Removes any previous `nodejs/` directory
2. Runs `npm install --omit=dev --platform=linux --arch=x64` to get Linux-native binaries
3. Copies the `node-fetch` and `abort-controller` shim modules into `nodejs/node_modules/`

The resulting `nodejs/` directory is the layer payload consumed by CDK in `packages/infra/`.

## Directory Layout

```
abort-controller-shim/   # Shim: re-exports globalThis.AbortController
node-fetch-shim/         # Shim: re-exports globalThis.fetch as default
nodejs/                  # Built layer output (gitignored)
package.json
```

## Notes

- Do **not** add this package to the pnpm workspace build graph; it uses `npm install` internally to produce a standalone `node_modules` tree for the Lambda runtime.
- The CDK infra stack references the `nodejs/` output directory when creating the `LayerVersion` construct.
