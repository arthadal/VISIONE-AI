// Lingua → locale per date, ore e ordinamenti delle finestre (inglese in tutta l'app, 11/10/2026).
// Un solo punto, così Esplora, registri e terminale scelgono la stessa locale: italiano → «it-IT»,
// inglese → «en-GB» (data giorno/mese, ora a 24 ore come nel resto dell'interfaccia).
import type { Language } from '../../shared/contracts/index.ts';

export function localeFor(lang: Language): string {
  return lang === 'en' ? 'en-GB' : 'it-IT';
}

/** Ora «hh:mm:ss» a 24 ore nella lingua dell'interfaccia (l'italiano è esattamente quello di prima). */
export function clockText(ts: number, lang: Language = 'it'): string {
  return new Date(ts).toLocaleTimeString(localeFor(lang), { hour12: false });
}

/** Data e ora complete a 24 ore nella lingua dell'interfaccia. */
export function dateTimeText(ts: number, lang: Language = 'it'): string {
  return new Date(ts).toLocaleString(localeFor(lang), { hour12: false });
}
