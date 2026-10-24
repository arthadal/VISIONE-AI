import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { contentSecurityPolicy } from './src/main/security-policy.ts';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Il core e la voce sono processi separati (utilityProcess) con il proprio punto d'ingresso; il modello
        // offline è un filo di lavoro del core (17/10/2026).
        input: {
          index: resolve('src/main/index.ts'),
          core: resolve('src/core/index.ts'),
          voice: resolve('src/voice/index.ts'),
          'offline-worker': resolve('src/core/offline/worker.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    // Runtime JSX automatico (tsconfig.web.json non è letto da esbuild).
    esbuild: { jsx: 'automatic' },
    build: {
      // Nessun asset inlinizzato come data: URL nel renderer: la CSP di produzione è
      // `script-src 'self'` e il worklet PCM (importato con `?url`) veniva inlinizzato da Vite,
      // facendo fallire `audioWorklet.addModule` e quindi la cattura del microfono (P-84+).
      // Con 0 il worklet è emesso come file e caricato da `file://` (stessa origine).
      assetsInlineLimit: 0,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [
      {
        name: 'visione-csp',
        transformIndexHtml: {
          order: 'pre',
          handler: (html, ctx) => html.replace('%VISIONE_CSP%', contentSecurityPolicy(ctx.server !== undefined))
        }
      }
    ]
  }
});
