// Preferenze dello schermo pulito (11/10/2026), per chi guarda: la barra in basso (eventi, log,
// terminale), la striscia degli agenti in alto e le linguette laterali. Comodità di questo PC
// (localStorage); senza archivio valgono i default dello schermo pulito.
import { useCallback, useEffect, useState } from 'react';

const KEY = 'visione.schermo.v1';
const SYNC = 'visione:screen-prefs';

export interface ScreenPrefs {
  /** Barra in basso con Eventi, Logs e Terminale. */
  bottom: boolean;
  /** Striscia degli agenti sotto i comandi in alto. */
  strip: boolean;
  /** Linguette laterali (cartelle) con le schermate per tema. */
  tabs: boolean;
  /** Dettagli tecnici sulla scena: ultimi effetti grezzi, qualità, fps e nodi (replay e legenda restano sempre). */
  sceneInfo: boolean;
}
export const DEFAULT_SCREEN_PREFS: ScreenPrefs = { bottom: false, strip: false, tabs: true, sceneInfo: false };

export function readScreenPrefs(): ScreenPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const pick = (k: keyof ScreenPrefs): boolean => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : DEFAULT_SCREEN_PREFS[k]);
    return { bottom: pick('bottom'), strip: pick('strip'), tabs: pick('tabs'), sceneInfo: pick('sceneInfo') };
  } catch {
    return { ...DEFAULT_SCREEN_PREFS };
  }
}

export function useScreenPrefs(): [ScreenPrefs, (patch: Partial<ScreenPrefs>) => void] {
  const [prefs, setPrefs] = useState(readScreenPrefs);
  useEffect(() => {
    const sync = (): void => setPrefs(readScreenPrefs());
    window.addEventListener(SYNC, sync);
    return () => window.removeEventListener(SYNC, sync);
  }, []);
  const update = useCallback((patch: Partial<ScreenPrefs>) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readScreenPrefs(), ...patch }));
    } catch {
      // Solo una comodità: senza archivio si torna ai default al prossimo avvio.
    }
    setPrefs((p) => ({ ...p, ...patch }));
    window.dispatchEvent(new CustomEvent(SYNC));
  }, []);
  return [prefs, update];
}
