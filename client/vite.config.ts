import preact from '@preact/preset-vite';
import { configDefaults, defineConfig } from 'vitest/config';

// Where the bridge listens by default (bridge/bin/chatter-bridge.js); only the dev server proxies to it.
const BRIDGE_ORIGIN = 'http://127.0.0.1:8791';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The bridge's CSP has no `data:` source for images or fonts, so small assets must stay separate files.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/v1': BRIDGE_ORIGIN,
      '/healthz': BRIDGE_ORIGIN,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // e2e/ holds Playwright specs, which Vitest must never try to run.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
