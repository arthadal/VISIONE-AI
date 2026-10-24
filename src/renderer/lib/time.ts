// Tempi leggibili (12/10/2026, richiesta del proprietario): «2270 s fa» non si legge. Sotto il minuto
// si dicono i secondi, poi minuti, ore e giorni. Italiano e inglese (P-108); funzioni pure, testate.
import type { Language } from '../../shared/contracts/index.ts';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Durata: «45 s», «12 min», «3 h 5 min», «2 g 4 h» (in inglese «2 d 4 h»). */
export function formatDuration(ms: number, lang: Language = 'it'): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < MIN) return `${Math.floor(v / SEC)} s`;
  if (v < HOUR) return `${Math.floor(v / MIN)} min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MIN);
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  const unit = lang === 'en' ? 'd' : 'g';
  return h > 0 ? `${d} ${unit} ${h} h` : `${d} ${unit}`;
}

/** Quanto tempo fa: «45 s fa», «12 min fa», «3 ore fa», «2 giorni fa» (in inglese «… ago»). */
export function formatAgo(ms: number, lang: Language = 'it'): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const en = lang === 'en';
  let n: number;
  let unit: string;
  if (v < MIN) { n = Math.floor(v / SEC); unit = 's'; }
  else if (v < HOUR) { n = Math.floor(v / MIN); unit = 'min'; }
  else if (v < DAY) { n = Math.floor(v / HOUR); unit = en ? (n === 1 ? 'hour' : 'hours') : (n === 1 ? 'ora' : 'ore'); }
  else { n = Math.floor(v / DAY); unit = en ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'giorno' : 'giorni'); }
  return en ? `${n} ${unit} ago` : `${n} ${unit} fa`;
}
