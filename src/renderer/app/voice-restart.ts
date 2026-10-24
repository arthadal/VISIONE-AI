// Riavvio del processo voce dalla UI (procedura guidata): la configurazione nuova vale dal riavvio.
import type { VisioneEvent } from '../../shared/contracts/index.ts';

/** Riavvia il processo voce e aspetta che sia pronto (false se non lo diventa in tempo). */
export async function restartVoice(timeoutMs = 30_000): Promise<boolean> {
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type !== 'voice.process.changed') return;
      const to = (e.payload as { to?: string }).to;
      if (to === 'ready' || to === 'unavailable') {
        clearTimeout(timer);
        off();
        resolve(to === 'ready');
      }
    });
  });
  await window.visione.voice.restart();
  return ready;
}

/**
 * Aspetta che il processo voce finisca di partire (collaudo in VM del 24/10/2026: su un PC lento caricare i modelli
 * d'ascolto richiede più di un minuto e la verifica diceva «il processo voce non è pronto»). Già pronto = subito
 * vero; spento, fermo o guasto = subito falso; in partenza = aspetta fino a `timeoutMs`.
 */
export async function waitVoiceReady(timeoutMs = 180_000): Promise<boolean> {
  let settle: (ok: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => {
    // In ascolto PRIMA di chiedere lo stato: un «pronto» che arriva in mezzo non va perso.
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type !== 'voice.process.changed') return;
      const to = (e.payload as { to?: string }).to;
      if (to !== undefined && to !== 'starting') settle(to === 'ready');
    });
    const timer = setTimeout(() => settle(false), timeoutMs);
    settle = (ok) => {
      clearTimeout(timer);
      off();
      resolve(ok);
    };
  });
  const st = await window.visione.voice.status();
  if (!st.ok || st.data.status !== 'starting') settle(st.ok && st.data.status === 'ready');
  return done;
}
