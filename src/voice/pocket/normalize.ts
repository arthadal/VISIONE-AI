// Testo da leggere per la voce VISIONE (P-110). Pocket TTS legge bene solo parole: le cifre, le sigle, i
// simboli e i due punti li inventa (misurato il 15/10/2026 sul saluto «Il PC sta bene: processore al 43
// per cento»: «4 a 3», «per approcessore», parole saltate). La voce di Windows fa questo lavoro da sé;
// qui lo si fa prima: numeri, ore, date e percentuali in lettere, sigle compitate, nomi in maiuscolo
// resi normali, simboli in parole, emoji via, e i due punti diventano una pausa di frase.

const UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** 0–999 in lettere, con le elisioni dell'italiano (ventuno, ventotto, centottanta, trentatré). */
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = h === 0 ? '' : h === 1 ? 'cento' : `${UNITS[h]}cento`;
  if (rest === 0) return out || 'zero';
  let tail: string;
  if (rest < 20) tail = UNITS[rest]!;
  else {
    const t = TENS[Math.floor(rest / 10)]!;
    const u = rest % 10;
    tail = u === 0 ? t : (u === 1 || u === 8 ? t.slice(0, -1) : t) + (u === 3 ? 'tré' : UNITS[u]);
  }
  if (out && tail.startsWith('o')) out = out.slice(0, -1); // cento + ottanta → centottanta
  return out + tail;
}

/** Intero non negativo in lettere (fino ai miliardi). */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e12 || !Number.isInteger(n)) return String(n);
  if (n < 1000) return belowThousand(n);
  const parts: string[] = [];
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  if (billions) parts.push(billions === 1 ? 'un miliardo' : `${numberToWords(billions)} miliardi`);
  if (millions) parts.push(millions === 1 ? 'un milione' : `${belowThousand(millions)} milioni`);
  let small = '';
  if (thousands) small = thousands === 1 ? 'mille' : `${belowThousand(thousands)}mila`;
  if (rest) small += belowThousand(rest);
  if (small) parts.push(small);
  return parts.join(' ');
}

/** Cifre come si dicono: «1.250» migliaia, «3,14» virgola, «0,05» con lo zero davanti letto. */
function readNumber(raw: string): string {
  const [int, dec] = raw.replace(/\.(?=\d{3}(?:\D|$))/g, '').split(/[.,]/);
  const whole = numberToWords(Number(int));
  if (dec === undefined) return whole;
  const lead = /^0+/.exec(dec)?.[0].length ?? 0;
  const digits = dec.length > 3 || lead > 0 ? [...dec].map((d) => UNITS[Number(d)]).join(' ') : numberToWords(Number(dec));
  return `${whole} virgola ${digits}`;
}

const LETTERS: Record<string, string> = {
  A: 'a', B: 'bi', C: 'ci', D: 'di', E: 'e', F: 'effe', G: 'gi', H: 'acca', I: 'i', J: 'i lunga', K: 'cappa', L: 'elle', M: 'emme',
  N: 'enne', O: 'o', P: 'pi', Q: 'cu', R: 'erre', S: 'esse', T: 'ti', U: 'u', V: 'vu', W: 'doppia vu', X: 'ics', Y: 'ipsilon', Z: 'zeta'
};
/** Sigle che si dicono come parola, non lettera per lettera. */
const SAID_AS_WORD: Record<string, string> = { RAM: 'ram', OK: 'okay', GB: 'giga', MB: 'mega', KB: 'kilo', TB: 'tera', NASA: 'nasa', FIAT: 'fiat', ANSA: 'ansa', WIFI: 'uaifai', LED: 'led' };

function acronym(word: string): string {
  const said = SAID_AS_WORD[word];
  if (said) return said;
  // Nomi scritti in maiuscolo (VISIONE, ROMA): si leggono come parole normali.
  if (word.length >= 5 || (word.length === 4 && /^[^AEIOU]*[AEIOU][^AEIOU]+[AEIOU]$/.test(word))) return word[0] + word.slice(1).toLowerCase();
  return [...word].map((c) => LETTERS[c] ?? c).join(' ');
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** Il testo come lo deve leggere la voce VISIONE. */
export function normalizeForSpeech(input: string): string {
  let t = input.normalize('NFC').replace(EMOJI, ' ');
  // Indirizzi: si leggono, non si inventano.
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' un collegamento ');
  t = t.replace(/([\p{L}\d._%+-]+)@([\p{L}\d.-]+\.[\p{L}]{2,})/gu, (_m, user: string, host: string) => `${user.replace(/[._]/g, ' punto ')} chiocciola ${host.replace(/\./g, ' punto ')}`);
  // Date e ore prima dei numeri semplici.
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d: string, mo: string, y: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return `${Number(d) === 1 ? 'primo' : numberToWords(Number(d))} ${month} ${numberToWords(Number(y))}`;
  });
  t = t.replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?![.,]\d)/g, (_m, h: string, mi: string) => (Number(mi) === 0 ? numberToWords(Number(h)) : `${numberToWords(Number(h))} e ${numberToWords(Number(mi))}`));
  // Valute, percentuali, gradi.
  t = t.replace(/€\s*(\d+(?:[.,]\d+)*)/g, '$1 euro').replace(/\$\s*(\d+(?:[.,]\d+)*)/g, '$1 dollari');
  t = t.replace(/\s*%/g, ' per cento').replace(/\s*°\s*C\b/g, ' gradi').replace(/\s*°/g, ' gradi').replace(/€/g, ' euro ');
  t = t.replace(/(^|[^\p{L}\d])-(\d)/gu, '$1meno $2');
  // Versioni (1.1.0) cifra per cifra; «beta.11», «nord-est»: il punto e il trattino fra parole non sono pause.
  t = t.replace(/\b\d+(?:\.\d+){2,}\b/g, (m) => (/^\d{1,3}(?:\.\d{3})+$/.test(m) ? m : m.split('.').map((d) => numberToWords(Number(d))).join(' punto ')));
  t = t.replace(/(\p{L})\.(\d)/gu, '$1 $2').replace(/([\p{L}\d])-(?=[\p{L}\d])/gu, '$1 ');
  t = t.replace(/\d+(?:[.,]\d+)*/g, (m) => readNumber(m));
  // Sigle e nomi in maiuscolo.
  t = t.replace(/(?<![\p{L}\d])\p{Lu}{2,}(?![\p{L}\d])/gu, (w) => acronym(w));
  // Simboli in parole o in pause.
  t = t.replace(/&/g, ' e ').replace(/\+/g, ' più ').replace(/=/g, ' uguale ').replace(/@/g, ' chiocciola ');
  t = t.replace(/[«»"“”„]/g, '').replace(/[()[\]{}]/g, ', ').replace(/\s[–—-]\s/g, ', ').replace(/[–—]/g, ', ');
  t = t.replace(/…/g, '...').replace(/[*_#~^|<>\\/]/g, ' ');
  // I due punti e il punto e virgola: il modello ci inciampa, una pausa di frase no.
  t = t.replace(/\s*[:;]+\s*(\p{L})/gu, (_m, c: string) => `. ${c.toUpperCase()}`).replace(/[:;]+/g, '.');
  t = t.replace(/\s*,(\s*,)+/g, ',').replace(/\s+([,.!?])/g, '$1').replace(/,+([.!?])/g, '$1').replace(/\s{2,}/g, ' ');
  return t.trim().replace(/^[,.\s]+/, '').replace(/[,\s]+$/, '');
}
