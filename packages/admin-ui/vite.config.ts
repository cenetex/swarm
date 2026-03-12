import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle Solana deps to avoid circular dependency issues
    include: [
      '@solana/web3.js',
      '@solana/wallet-adapter-base',
      '@solana/wallet-adapter-react',
      '@solana/wallet-adapter-react-ui',
      '@solana/wallet-adapter-wallets',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Disable sourcemaps to reduce memory usage in CI
    // Privy SDK core + WalletConnect + EVM libs each exceed the default
    // 500 kB limit.  Setting to 1000 kB avoids false warnings while
    // still catching any chunk that grows beyond ~1 MB.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // Suppress INVALID_ANNOTATION warnings from third-party dependencies.
        // @privy-io/react-auth and ox emit ~198 "contains an annotation that
        // Rollup cannot interpret" warnings due to misplaced /*#__PURE__*/
        // comments in their ESM bundles. These are harmless — Rollup strips
        // the annotations automatically — but they create noisy build output.
        if (
          warning.code === 'INVALID_ANNOTATION' &&
          warning.id &&
          warning.id.includes('node_modules')
        ) {
          return;
        }
        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          // --- React core: keep react + react-dom + scheduler together to
          // avoid duplicate-context / chunk-ordering issues with Privy,
          // Solana wallet adapters, and other React-dependent libs.
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }

          // --- Cryptographic primitives shared by both Solana and EVM libs.
          // Kept in their own chunk to avoid circular deps between the
          // Solana and EVM vendor chunks.
          if (
            id.includes('/node_modules/@noble/') ||
            id.includes('/node_modules/@scure/')
          ) {
            return 'vendor-crypto';
          }

          // --- Solana wallet stack
          // eventemitter3 is a transitive dep of @solana/wallet-adapter-base
          // and must live here (not in vendor-walletconnect) to avoid a
          // circular chunk dependency: walletconnect ↔ solana.
          if (
            id.includes('/node_modules/@solana/') ||
            id.includes('/node_modules/@solana-program/') ||
            id.includes('/node_modules/bs58/') ||
            id.includes('/node_modules/base-x/') ||
            id.includes('/node_modules/eventemitter3/')
          ) {
            return 'vendor-solana';
          }

          // --- EVM / Ethereum libs pulled in by Privy (viem, ethers, wagmi, ox).
          // Kept separate from Privy so Privy's own internal code-splitting
          // (lazy-loaded screens) is preserved by Rollup.
          if (
            id.includes('/node_modules/viem/') ||
            id.includes('/node_modules/wagmi/') ||
            id.includes('/node_modules/@wagmi/') ||
            id.includes('/node_modules/ethers/') ||
            id.includes('/node_modules/ox/')
          ) {
            return 'vendor-evm';
          }

          // --- Privy auth SDK + heavy transitive deps that are only
          // used by Privy.  WalletConnect and Coinbase SDK are split
          // into their own chunks since they are large and lazily
          // loaded by Privy's connector screens.
          if (
            id.includes('/node_modules/@walletconnect/') ||
            id.includes('/node_modules/@coinbase/')
          ) {
            return 'vendor-walletconnect';
          }

          // --- Privy auth SDK: do NOT force into a single chunk.
          // Privy uses dynamic imports internally to lazy-load screens
          // (wallet connect, funding, onboarding, TOTP enrollment, etc.).
          // Rollup preserves these as separate auto-generated chunks.
          // Only Privy's eagerly-loaded core ends up in the main chunk.
          //
          // Privy's transitive deps (styled-components, headless UI,
          // jose, etc.) are also left for Rollup to handle.

          // --- Markdown rendering pipeline (react-markdown + remark/rehype).
          // Note: react-markdown depends on React, so placing it in a
          // separate chunk from vendor-react creates a circular dependency.
          // Instead, let these modules stay in the default app chunk since
          // they are modest in size (~118 kB) and always needed for chat.
        },
      },
    },
  },
});
