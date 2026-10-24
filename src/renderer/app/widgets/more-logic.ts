// Widget aggiunti con lo schermo pulito (11/10/2026): Calendario, Note, Ultime risposte. Qui il calcolo
// puro e testato: la griglia del mese e le ultime risposte vere degli agenti dagli eventi.
import type { VisioneEvent } from '../../../shared/contracts/index.ts';

export interface DayCell {
  day: number;
  /** Del mese mostrato (gli altri sono i giorni di contorno, più spenti). */
  inMonth: boolean;
  today: boolean;
  /** Chiave stabile `aaaa-mm-gg`. */
  key: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Griglia di 6 settimane del mese (`month` 0…11) con la settimana che parte da `weekStart`
 * (1 = lunedì in Italia, 0 = domenica). `now` dice qual è oggi.
 */
export function monthGrid(year: number, month: number, weekStart: 0 | 1, now: Date): DayCell[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - offset);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const out: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out.push({ day: d.getDate(), inMonth: d.getMonth() === month, today: key === todayKey, key });
  }
  return out;
}

/** Mese successivo o precedente (anno compreso). */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export interface Reply {
  id: string;
  agentId: string;
  text: string;
  at: number;
}

/** Le ultime `n` risposte finite degli agenti (testo finale di un turno), la più recente prima. */
export function lastReplies(events: readonly VisioneEvent[], n = 5): Reply[] {
  const out: Reply[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i] as VisioneEvent;
    if (e.type !== 'agent.message.text') continue;
    const p = e.payload as { agentId?: unknown; text?: unknown; final?: unknown };
    if (p.final !== true || typeof p.agentId !== 'string' || typeof p.text !== 'string') continue;
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    out.push({ id: e.id, agentId: p.agentId, text: text.length > 280 ? `${text.slice(0, 279)}…` : text, at: e.ts });
  }
  return out;
}

/** Limite delle note veloci (caratteri). */
export const NOTES_MAX = 5_000;
