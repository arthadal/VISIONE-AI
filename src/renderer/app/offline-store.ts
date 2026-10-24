// Modalità offline (17/10/2026) nell'interfaccia: lo stato arriva dal core (`offline.status` all'avvio, poi
// l'evento `offline.changed`) e lo leggono la spia, la barra comandi, la Chat e il Director. Un solo posto
// decide dove va una frase scritta: agli agenti o, offline, al modello locale.
import { useSyncExternalStore } from 'react';
import type { CommandError, Language, OfflineState } from '../../shared/contracts/index.ts';

let current: OfflineState | null = null;
const listeners = new Set<() => void>();

export function setOfflineState(next: OfflineState | null): void {
  current = next;
  for (const l of listeners) l();
}

export function offlineState(): OfflineState | null {
  return current;
}

export function useOfflineState(): OfflineState | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current
  );
}

export type GoalOutcome = { ok: true; offline: boolean } | { ok: false; error: CommandError };

/** Una frase scritta: al Director, o — offline — al modello locale (la risposta arriva con `offline.reply`). */
export async function sendGoal(goal: string): Promise<GoalOutcome> {
  if (current?.active) {
    const res = await window.visione.offline.ask(goal);
    return res.ok ? { ok: true, offline: true } : { ok: false, error: res.error };
  }
  const res = await window.visione.director.submit({ goal });
  return res.ok ? { ok: true, offline: false } : { ok: false, error: res.error };
}

/**
 * Il tasto «Entra in modalità offline» / «Torna online». Nel primo mezzo secondo (o mentre il supervisore
 * riavvia il core) il core risponde `core_unavailable`: si riprova per qualche secondo invece di ignorare il
 * clic in silenzio (17/10/2026, dal collaudo). Restituisce l'errore se non ci si riesce.
 */
export async function setOffline(active: boolean, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<CommandError | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await window.visione.offline.set(active);
    if (res.ok) {
      setOfflineState(res.data);
      return null;
    }
    if (res.error.code !== 'core_unavailable' || attempt >= 16) return res.error;
    await wait(500);
  }
}

/** «3,1 GB» / «3.1 GB». */
export function formatSize(bytes: number, lang: Language): string {
  const gb = bytes / 1e9;
  const text = gb >= 1 ? gb.toFixed(1) : (bytes / 1e6).toFixed(0);
  return `${lang === 'it' ? text.replace('.', ',') : text} ${gb >= 1 ? 'GB' : 'MB'}`;
}
