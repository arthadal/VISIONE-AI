import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Font self-hosted, licenza OFL-1.1 (P-74, G2): Chakra Petch per l'HUD, JetBrains Mono per
// log/metriche/mono. Nessun CDN (bloccato/offline): i file arrivano dal bundle dell'app.
import '@fontsource/chakra-petch/latin-300.css';
import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/jetbrains-mono/latin-300.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import { App } from './app/App.tsx';
import './ui/styles.css';

// Diagnostica dei crash del renderer (P-74): l'errore originale del 04/10 aveva solo il messaggio,
// senza stack. Qui i primi errori non gestiti vengono registrati con stack e origine nel log del
// main (`window.ts`), con una soglia per non inondare: serve a isolare la causa se ricapita.
const MAX_REPORTED_ERRORS = 10;
let reportedErrors = 0;
function reportRendererError(kind: string, detail: unknown): void {
  if (reportedErrors >= MAX_REPORTED_ERRORS) {
    if (reportedErrors === MAX_REPORTED_ERRORS) {
      reportedErrors++;
      console.error('[VISIONE] ulteriori errori del renderer non registrati (soglia raggiunta)');
    }
    return;
  }
  reportedErrors++;
  const error = detail instanceof Error ? detail : new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.error(`[VISIONE] ${kind}: ${error.message}\n${error.stack ?? '(nessuno stack)'}`);
}
window.addEventListener('error', (e) => reportRendererError('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportRendererError('unhandledrejection', e.reason));

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root mancante');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
