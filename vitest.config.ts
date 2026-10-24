import { defineConfig } from 'vitest/config';

// Test unitari e d'integrazione: Node puro, nessun Electron. Gli e2e hanno la loro configurazione.
// `maxWorkers` contenuto: molti file usano node-pty (nativo); troppa concorrenza causa crash
// sporadici del worker (access violation). Pochi fork restano veloci e stabili.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    // Cartelle temporanee dei test: una per corsa, cancellate a fine file e a fine corsa (test/helpers.ts).
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    maxWorkers: 4
  }
});
