import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The app's own `tsconfig` path alias is invisible to vitest, and the receive
 * engine reaches the relay client through `@/lib/relay` — so without this the
 * tests cannot even load the module under test.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The receive engine is deliberately incremental: a full backfill sweep of a
    // synthetic backlog runs thousands of real scalarmults.
    testTimeout: 60_000,
  },
});
