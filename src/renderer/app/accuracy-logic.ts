// Prova di precisione dell'ascolto (24/10/2026, richiesta del proprietario: «pretendo una precisione del 98%»). Il
// proprietario legge frasi note e VISIONE confronta ciò che ha sentito: parole giuste sulla SUA voce, nel suo ambiente.
// Stessa misura usata sul PC di sviluppo (parole sbagliate = distanza di modifica fra le parole; i numeri scritti in
// cifre valgono come in lettere: «10» = «dieci»). Parte pura, provata dai test.
import type { Language } from '../../shared/contracts/index.ts';

const UNITS: Record<Language, readonly string[]> = {
  it: ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
};
const TENS: Record<Language, readonly string[]> = {
  it: ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'],
  en: ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
};

/** Un numero da 0 a 99 in lettere («21» → «ventuno», «twenty one»). */
export function numberWords(n: number, lang: Language): string {
  const units = UNITS[lang];
  if (n < 20) return units[n]!;
  const ten = TENS[lang][Math.floor(n / 10)]!;
  const unit = n % 10;
  if (unit === 0) return ten;
  if (lang === 'en') return `${ten} ${units[unit]!}`;
  // «ventuno», «ventotto»: la vocale finale cade davanti a uno e otto.
  return (unit === 1 || unit === 8 ? ten.slice(0, -1) : ten) + units[unit]!;
}

/** Le parole di una frase, confrontabili: minuscole, senza accenti né punteggiatura, numeri in lettere. */
export function comparableWords(text: string, lang: Language): string[] {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
  return plain.replace(/\b\d{1,2}\b/g, (d) => numberWords(Number(d), lang)).split(' ').filter(Boolean);
}

/** Parole sbagliate (sostituite, mancanti o in più) di `heard` rispetto a `expected`. */
export function wordErrors(expected: string, heard: string, lang: Language): { errors: number; words: number } {
  const r = comparableWords(expected, lang);
  const h = comparableWords(heard, lang);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)));
    prev = row;
  }
  return { errors: prev[h.length]!, words: r.length };
}

/** Percentuale di parole giuste su tutte le frasi lette (0–100, un decimale). */
export function accuracyPercent(results: ReadonlyArray<{ errors: number; words: number }>): number {
  const words = results.reduce((n, r) => n + r.words, 0);
  if (words === 0) return 0;
  const errors = results.reduce((n, r) => n + r.errors, 0);
  return Math.max(0, Math.round((1 - errors / words) * 1000) / 10);
}
