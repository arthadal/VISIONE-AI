import { defineConfig } from 'vitest/config';

// End-to-end sull'app Electron compilata (`npm run test:e2e` esegue prima la build).
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // Cartelle temporanee dei test: una per corsa, cancellate a fine file e a fine corsa (test/helpers.ts).
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
