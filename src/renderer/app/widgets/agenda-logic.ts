// Widget Agenda (beta.5, P-109): calcolo puro e testato. I promemoria arrivano dal core
// (`assistant.reminders.list`); qui si raggruppano per «scattati / oggi / domani / più avanti» e si
// trovano i giorni da segnare sul Calendario.
import type { Reminder } from '../../../shared/contracts/index.ts';

export type AgendaSectionId = 'fired' | 'today' | 'tomorrow' | 'later';

export interface AgendaSection {
  readonly id: AgendaSectionId;
  readonly items: readonly Reminder[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Chiave `aaaa-mm-gg` del giorno locale (la stessa delle celle del Calendario). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(ms: number, plusDays = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime();
}

/** Promemoria aperti in sezioni non vuote, ognuna in ordine di ora. Gli scattati vengono prima. */
export function groupReminders(list: readonly Reminder[], now: number): AgendaSection[] {
  const tomorrow = startOfDay(now, 1);
  const after = startOfDay(now, 2);
  const buckets: Record<AgendaSectionId, Reminder[]> = { fired: [], today: [], tomorrow: [], later: [] };
  for (const r of list) {
    if (r.status === 'fired') buckets.fired.push(r);
    else if (r.status !== 'pending') continue;
    else if (r.dueAt < tomorrow) buckets.today.push(r);
    else if (r.dueAt < after) buckets.tomorrow.push(r);
    else buckets.later.push(r);
  }
  return (['fired', 'today', 'tomorrow', 'later'] as const)
    .map((id) => ({ id, items: [...buckets[id]].sort((a, b) => a.dueAt - b.dueAt) }))
    .filter((s) => s.items.length > 0);
}

/** «15:30» per oggi e domani; «lun 13 ott, 9:00» più avanti (nella lingua della UI). */
export function timeLabel(r: Pick<Reminder, 'dueAt'>, now: number, locale: string): string {
  const d = new Date(r.dueAt);
  const hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (r.dueAt < startOfDay(now, 2) && r.dueAt >= startOfDay(now)) return hm;
  return `${d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}, ${hm}`;
}

/** Giorni con almeno un promemoria aperto (per i segni sul Calendario). */
export function reminderDays(list: readonly Reminder[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of list) if (r.status === 'pending' || r.status === 'fired') out.add(dayKey(r.dueAt));
  return out;
}
