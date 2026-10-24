import { defineConfig } from 'vitest/config';

// Contract test sulle CLI reali (`npm run test:contract`): opt-in, mai in `npm test` né in CI.
// Usano i motori installati e le credenziali già presenti nell'ambiente dell'utente.
export default defineConfig({
  test: {
    include: ['test/contract/**/*.test.ts'],
    // Cartelle temporanee dei test: una per corsa, cancellate a fine file e a fine corsa (test/helpers.ts).
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    env: { VISIONE_CONTRACT: '1' },
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks'
  }
});
