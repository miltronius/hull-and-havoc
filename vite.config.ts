import { fileURLToPath, URL } from 'node:url';
// vitest/config re-exports Vite's defineConfig widened with the `test` key,
// so one config file covers both the dev server and the test runner.
import { defineConfig } from 'vitest/config';

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolvePath('./src/engine'),
      '@ui': resolvePath('./src/ui'),
      '@game': resolvePath('./src/game'),
    },
  },
  server: {
    // Bound to all interfaces so the game stays testable on a phone over the
    // LAN. This project was iterated on a phone throughout and mobile-first
    // touch controls are a core design value — don't lose the ability to
    // check them on real hardware.
    host: '0.0.0.0',
    port: 5173,
  },
  optimizeDeps: {
    // cannon 0.6.2 predates ESM and ships a UMD bundle; Vite needs to
    // pre-bundle it into an importable module. Removed in Phase 2 when we
    // move to cannon-es, which is ESM already.
    include: ['cannon'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    // Engine physics tests run headless in Node — no DOM, no WebGL. This is
    // what the buildShip / attachShipView split buys us.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
