// Assistente personale (beta.5, P-109): «quando» detto in italiano → istante, con regole locali e
// nessun modello (come gli intenti a voce, P-12). Usa l'ora locale del PC. Riconosce:
// - relativo: «tra 10 minuti», «fra un'ora e mezza», «tra mezz'ora», «tra un quarto d'ora», «tra 2 giorni»;
// - ora: «alle 15», «alle 15:30», «alle 3 e mezza», «all'una», «alle 9 di sera», «a mezzogiorno», «18.45»;
// - giorno: «oggi», «domani», «dopodomani», «stasera», «domattina», «lunedì», «il 15 ottobre», «il 15/10».
// Ciò che non riconosce resta testo: meglio chiedere «quando?» che inventare un'ora.

export interface ParsedWhen {
  /** Istante (ms dall'epoca, ora locale del PC). */
  readonly at: number;
  /** true se l'ora è stata detta (o è relativa); false se c'è solo il giorno o il momento («stasera»). */
  readonly exact: boolean;
  /** true se l'istante è già passato (es. «oggi alle 9» detto alle 10). */
  readonly past: boolean;
  /** Il testo senza le parole del «quando». */
  readonly rest: string;
}

type Part = 'mattina' | 'pomeriggio' | 'sera' | 'notte';
const PART_HOUR: Record<Part, number> = { mattina: 9, pomeriggio: 15, sera: 20, notte: 22 };

const WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
  dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16,
  diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, ventuno: 21, ventidue: 22, ventitre: 23,
  ventiquattro: 24, venticinque: 25, trenta: 30, trentacinque: 35, quaranta: 40, quarantacinque: 45,
  cinquanta: 50, cinquantacinque: 55, sessanta: 60, novanta: 90
};
const WORD_ALT = Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|');
const NUM = `(?:\\d{1,3}|${WORD_ALT})`;
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const PART_RE = '(mattina|mattino|mattinata|pomeriggio|sera|serata|notte|nottata)';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Minuscole e senza accenti, con la STESSA lunghezza del testo originale: le posizioni trovate qui
 * valgono anche sull'originale, così il resto della frase conserva maiuscole e accenti.
 */
export function fold(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '’' || c === '`' || c === '´') { out += "'"; continue; }
    const base = (c.normalize('NFD')[0] ?? ' ').toLowerCase()[0] ?? ' ';
    out += /[a-z0-9:'./]/.test(base) ? base : ' ';
  }
  return out;
}

function num(token: string): number {
  const t = token.trim();
  if (/^\d+$/.test(t)) return Number(t);
  return WORDS[t] ?? Number.NaN;
}

function partOf(word: string | undefined): Part | null {
  if (!word) return null;
  if (word.startsWith('matt')) return 'mattina';
  if (word.startsWith('pomer')) return 'pomeriggio';
  if (word.startsWith('ser')) return 'sera';
  if (word.startsWith('nott')) return 'notte';
  return null;
}

interface Hit { readonly start: number; readonly end: number; readonly m: RegExpExecArray }
function find(text: string, re: RegExp): Hit | null {
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, m } : null;
}

/** Durata di un «tra …» in ms, o null. */
function relative(text: string): Hit & { ms: number } | null {
  const idiom = find(text, /\b(?:tra|fra)\s+(un\s+quarto\s+d\s*'?\s*ora|tre\s+quarti\s+d\s*'?\s*ora|mezz\s*'?\s*ora|un\s+paio\s+d\s*'?\s*ore)\b/);
  if (idiom) {
    const w = idiom.m[1]!;
    const ms = /^un\s+quarto/.test(w) ? 15 * MINUTE : w.startsWith('tre') ? 45 * MINUTE : w.startsWith('mezz') ? 30 * MINUTE : 2 * HOUR;
    return { ...idiom, ms };
  }
  const re = new RegExp(
    `\\b(?:tra|fra)\\s+(un\\s+paio\\s+di|${NUM})\\s*'?\\s*(minuti|minuto|min|ore|ora|giorni|giorno|settimane|settimana)\\b` +
    `(?:\\s+e\\s+(mezza|mezzo|un\\s+quarto|tre\\s+quarti|${NUM})(?:\\s*(?:minuti|minuto|min))?\\b)?`
  );
  const hit = find(text, re);
  if (!hit) return null;
  const n = hit.m[1]!.startsWith('un paio') ? 2 : num(hit.m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = hit.m[2]!;
  const unitMs = unit.startsWith('min') ? MINUTE : unit.startsWith('or') ? HOUR : unit.startsWith('giorn') ? DAY : 7 * DAY;
  let ms = n * unitMs;
  const extra = hit.m[3];
  if (extra && unitMs === HOUR) {
    if (extra.startsWith('mezz')) ms += 30 * MINUTE;
    else if (extra.startsWith('un')) ms += 15 * MINUTE;
    else if (extra.startsWith('tre')) ms += 45 * MINUTE;
    else if (Number.isFinite(num(extra)) && num(extra) < 60) ms += num(extra) * MINUTE;
  } else if (extra && unitMs === MINUTE && extra.startsWith('mezz')) ms += 30_000;
  else if (extra) {
    // «tra 2 giorni e …»: la coda non è capita, non si consuma.
    const short = hit.m[0].slice(0, hit.m[0].search(/\s+e\s+/));
    return { start: hit.start, end: hit.start + short.length, m: hit.m, ms };
  }
  return { ...hit, ms };
}

interface Clock { readonly hour: number; readonly minute: number; readonly part: Part | null }

function clock(text: string): Hit & Clock | null {
  const special = find(text, /\b(?:a\s+|alle\s+|verso\s+)?(mezzogiorno|mezzanotte)\b/);
  if (special) return { ...special, hour: special.m[1] === 'mezzogiorno' ? 12 : 0, minute: 0, part: null };
  const H = `(\\d{1,2}|${WORD_ALT})`;
  const MM = `(\\d{1,2}|mezza|mezzo|un\\s+quarto|tre\\s+quarti|${WORD_ALT})`;
  const re = new RegExp(
    `\\b(?:alle|all\\s*'|all|per\\s+le|verso\\s+le|entro\\s+le|dalle|ore)\\s*${H}(?:(?:\\s*[:.]\\s*|\\s+e\\s+)${MM})?\\b` +
    `(?:\\s+in\\s+punto)?(?:\\s+(?:di|del|della|dello|nel|nella|in)?\\s*${PART_RE}\\b)?`
  );
  let hit = find(text, re);
  if (!hit) {
    // «15:30», «18.45» senza preposizione (col punto solo a due cifre: «versione 1.10» non è un'ora).
    const bare = find(text, /(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/) ?? find(text, /(?<![\d.])([01]\d|2[0-3])\.([0-5]\d)(?![.\d])/);
    if (!bare) return null;
    hit = bare;
  }
  const hour = num(hit.m[1]!);
  if (!Number.isFinite(hour) || hour > 24) return null;
  const mm = hit.m[2];
  let minute = 0;
  if (mm) {
    if (mm.startsWith('mezz')) minute = 30;
    else if (mm.startsWith('un')) minute = mm.includes('quarto') ? 15 : 1;
    else if (mm.startsWith('tre') && mm.includes('quarti')) minute = 45;
    else minute = num(mm);
  }
  if (!Number.isFinite(minute) || minute > 59) return null;
  return { ...hit, hour: hour === 24 ? 0 : hour, minute, part: partOf(hit.m[3]) };
}

interface DaySpec { readonly kind: 'offset'; readonly days: number }
interface WeekdaySpec { readonly kind: 'weekday'; readonly weekday: number }
interface DateSpec { readonly kind: 'date'; readonly day: number; readonly month: number | null; readonly year: number | null }
type Day = (DaySpec | WeekdaySpec | DateSpec) & { readonly part: Part | null };

function dayOf(text: string): Array<Hit & Day> {
  const out: Array<Hit & Day> = [];
  const rel = find(text, new RegExp(`\\b(oggi|stamattina|stamani|stasera|stanotte|domani|domattina|dopodomani)\\b(?:\\s+(?:in\\s+|di\\s+|nel\\s+)?${PART_RE}\\b)?`));
  if (rel) {
    const w = rel.m[1]!;
    const days = w.startsWith('dopo') ? 2 : w.startsWith('dom') ? 1 : 0;
    const own: Part | null = w === 'stamattina' || w === 'stamani' || w === 'domattina' ? 'mattina' : w === 'stasera' ? 'sera' : w === 'stanotte' ? 'notte' : null;
    out.push({ ...rel, kind: 'offset', days, part: partOf(rel.m[2]) ?? own });
  }
  const today = find(text, new RegExp(`\\b(?:questo|questa|in|nel|nella|di)\\s+${PART_RE}\\b`));
  if (today && !rel) out.push({ ...today, kind: 'offset', days: 0, part: partOf(today.m[1]) });
  const wd = find(text, new RegExp(`\\b(?:(?:questo|questa|il|la|di|per|prossimo|prossima)\\s+)?(${WEEKDAYS.join('|')})(?:\\s+(?:prossimo|prossima))?(?:\\s+(?:in\\s+|di\\s+|nel\\s+)?${PART_RE}\\b)?\\b`));
  if (wd) out.push({ ...wd, kind: 'weekday', weekday: WEEKDAYS.indexOf(wd.m[1]!), part: partOf(wd.m[2]) });
  const dm = find(text, new RegExp(`\\b(?:il\\s+|l\\s*'\\s*|per\\s+il\\s+)?(\\d{1,2}|primo)\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`));
  if (dm) out.push({ ...dm, kind: 'date', day: dm.m[1] === 'primo' ? 1 : Number(dm.m[1]), month: MONTHS.indexOf(dm.m[2]!), year: dm.m[3] ? Number(dm.m[3]) : null, part: null });
  const slash = find(text, /\b(?:il\s+)?(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
  if (slash && !dm) {
    const y = slash.m[3] ? Number(slash.m[3]) : null;
    out.push({ ...slash, kind: 'date', day: Number(slash.m[1]), month: Number(slash.m[2]) - 1, year: y === null ? null : y < 100 ? 2000 + y : y, part: null });
  }
  return out;
}

/** Toglie gli spezzoni [start,end) dal testo originale e ripulisce gli spazi rimasti. */
function without(raw: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let s = raw;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) s = `${s.slice(0, a)} ${s.slice(b)}`;
  return s.replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,.;:]+|[\s,;:]+$/g, '').trim();
}

/** Il «quando» di una frase, o null se non ce n'è. `now` in ms (ora locale del PC). */
export function parseWhen(raw: string, now: number): ParsedWhen | null {
  const text = fold(raw);
  const rel = relative(text);
  if (rel) {
    const at = now + rel.ms;
    return { at, exact: true, past: false, rest: without(raw, [[rel.start, rel.end]]) };
  }
  const time = clock(text);
  // Un giorno dentro lo spezzone dell'ora («alle 9 di sera») non conta due volte.
  const days = dayOf(text).filter((d) => !time || d.end <= time.start || d.start >= time.end);
  const day = days[0] ?? null;
  if (!time && !day) return null;

  const base = new Date(now);
  let y = base.getFullYear();
  let mo = base.getMonth();
  let d = base.getDate();
  if (day?.kind === 'offset') d += day.days;
  else if (day?.kind === 'weekday') {
    const ahead = (day.weekday - base.getDay() + 7) % 7;
    d += ahead === 0 ? 7 : ahead;
  } else if (day?.kind === 'date') {
    if (day.month === null || day.month < 0 || day.month > 11 || day.day < 1 || day.day > 31) return null;
    mo = day.month;
    d = day.day;
    if (day.year !== null) y = day.year;
    else if (new Date(y, mo, d).getTime() < new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()) y += 1;
  }

  const part = time?.part ?? day?.part ?? null;
  let hour: number;
  let minute = 0;
  if (time) {
    hour = time.hour;
    minute = time.minute;
    if (part === 'pomeriggio' || part === 'sera') { if (hour < 12) hour += 12; }
    else if (part === 'notte') { if (hour >= 6 && hour < 12) hour += 12; else if (hour === 12) hour = 0; }
    else if (part === null && hour >= 1 && hour <= 5) hour += 12; // «alle 3» = le 15: nessuno fissa le 3 di notte senza dirlo
  } else {
    hour = part ? PART_HOUR[part] : 9;
  }
  let at = new Date(y, mo, d, hour, minute, 0, 0).getTime();
  if (time && !day) {
    // Solo l'ora: la prossima volta che arriva. «alle 9» detto alle 10 = le 21, poi domani.
    if (at <= now && time.part === null && hour >= 6 && hour < 12) at += 12 * HOUR;
    while (at <= now) {
      const t = new Date(at);
      at = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, t.getHours(), t.getMinutes()).getTime();
    }
  }
  const spans: Array<[number, number]> = [];
  if (time) spans.push([time.start, time.end]);
  if (day) spans.push([day.start, day.end]);
  return { at, exact: time !== null, past: at <= now, rest: without(raw, spans) };
}

const WEEKDAY_LABEL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

/** «oggi alle 15:30», «domani alle 9:00», «lunedì 13 ottobre alle 9:00». */
export function describeWhen(at: number, now: number): string {
  const a = new Date(at);
  const n = new Date(now);
  const dayDiff = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY);
  const hm = `${a.getHours()}:${String(a.getMinutes()).padStart(2, '0')}`;
  const dayLabel = dayDiff === 0 ? 'oggi' : dayDiff === 1 ? 'domani' : dayDiff === 2 ? 'dopodomani' : dayDiff === -1 ? 'ieri'
    : `${WEEKDAY_LABEL[a.getDay()]} ${a.getDate()} ${MONTHS[a.getMonth()]}${a.getFullYear() !== n.getFullYear() ? ` ${a.getFullYear()}` : ''}`;
  return `${dayLabel} alle ${hm}`;
}
