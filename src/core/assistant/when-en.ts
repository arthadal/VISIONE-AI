// Assistente personale in inglese (P-108, 12/10/2026): «quando» detto in inglese → istante, con le
// stesse regole locali di `when.ts` (nessun modello, ora locale del PC). Riconosce:
// - relativo: «in 10 minutes», «in an hour and a half», «in half an hour», «in a quarter of an hour», «in 2 days»;
// - ora: «at 3», «at 3pm», «at 3:30 pm», «at 15:30», «at half past 3», «at noon», «at midnight», «7am»;
// - giorno: «today», «tomorrow», «the day after tomorrow», «tonight», «tomorrow morning», «on Monday»,
//   «next Friday», «on 15 October», «October 15th», «15/10» (giorno/mese, come l'interfaccia inglese).
// Ciò che non riconosce resta testo: meglio chiedere «when?» che inventare un'ora.
import { fold, type ParsedWhen } from './when.ts';

type Part = 'morning' | 'afternoon' | 'evening' | 'night';
const PART_HOUR: Record<Part, number> = { morning: 9, afternoon: 15, evening: 20, night: 22 };

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90
};
const WORD_ALT = Object.keys(WORDS).sort((a, b) => b.length - a.length).map((w) => w.replace(' ', '\\s+')).join('|');
const NUM = `(?:\\d{1,3}|${WORD_ALT})`;
/** Ore e minuti a parole: senza «a»/«an», che in «at a restaurant» non sono un'ora. */
const CLOCK_WORDS = Object.keys(WORDS).filter((w) => w !== 'a' && w !== 'an').sort((a, b) => b.length - a.length).map((w) => w.replace(' ', '\\s+')).join('|');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PART_RE = '(morning|afternoon|evening|night)';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function num(token: string): number {
  const t = token.trim().replace(/\s+/g, ' ');
  if (/^\d+$/.test(t)) return Number(t);
  return WORDS[t] ?? Number.NaN;
}

function monthOf(word: string): number {
  return MONTHS.findIndex((m) => m.startsWith(word.slice(0, 3)));
}

function partOf(word: string | undefined): Part | null {
  return word === 'morning' || word === 'afternoon' || word === 'evening' || word === 'night' ? word : null;
}

interface Hit { readonly start: number; readonly end: number; readonly m: RegExpExecArray }
function find(text: string, re: RegExp): Hit | null {
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, m } : null;
}

function relative(text: string): Hit & { ms: number } | null {
  const idiom = find(text, /\b(?:in|within)\s+(half\s+an\s+hour|a\s+half\s+hour|(?:a\s+)?quarter\s+of\s+an\s+hour|three\s+quarters\s+of\s+an\s+hour|a\s+couple\s+of\s+hours|an\s+hour\s+and\s+a\s+half|a\s+few\s+minutes)\b/);
  if (idiom) {
    const w = idiom.m[1]!;
    const ms = w.startsWith('three') ? 45 * MINUTE : w.includes('quarter') ? 15 * MINUTE : w.includes('couple') ? 2 * HOUR
      : w.startsWith('an hour') ? 90 * MINUTE : w.includes('few') ? 5 * MINUTE : 30 * MINUTE;
    return { ...idiom, ms };
  }
  const re = new RegExp(
    `\\b(?:in|within)\\s+(a\\s+couple\\s+of|${NUM})\\s+(minutes|minute|mins|min|hours|hour|hrs|hr|days|day|weeks|week)\\b` +
    `(?:\\s+and\\s+(a\\s+half|a\\s+quarter|${NUM})(?:\\s+(?:minutes|minute|mins|min))?\\b)?`
  );
  const hit = find(text, re);
  if (!hit) return null;
  const n = hit.m[1]!.startsWith('a couple') ? 2 : num(hit.m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = hit.m[2]!;
  const unitMs = unit.startsWith('min') ? MINUTE : unit.startsWith('h') ? HOUR : unit.startsWith('d') ? DAY : 7 * DAY;
  let ms = n * unitMs;
  const extra = hit.m[3];
  if (extra && unitMs === HOUR) {
    if (extra.endsWith('half')) ms += 30 * MINUTE;
    else if (extra.endsWith('quarter')) ms += 15 * MINUTE;
    else if (Number.isFinite(num(extra)) && num(extra) < 60) ms += num(extra) * MINUTE;
  } else if (extra && unitMs === MINUTE && extra.endsWith('half')) ms += 30_000;
  else if (extra) {
    const short = hit.m[0].slice(0, hit.m[0].search(/\s+and\s+/));
    return { start: hit.start, end: hit.start + short.length, m: hit.m, ms };
  }
  return { ...hit, ms };
}

interface Clock { readonly hour: number; readonly minute: number; readonly part: Part | null; readonly meridiem: 'am' | 'pm' | null }

function clock(text: string): Hit & Clock | null {
  const special = find(text, /\b(?:at\s+|by\s+|around\s+)?(noon|midday|midnight)\b/);
  if (special) return { ...special, hour: special.m[1] === 'midnight' ? 0 : 12, minute: 0, part: null, meridiem: null };
  const H = `(\\d{1,2}|${CLOCK_WORDS})`;
  // Niente «tomorrow» qui: «at 9 tomorrow morning» lascia il giorno al suo riconoscitore.
  const TAIL = `(?:\\s*o\\s*'?\\s*clock)?(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.))?(?:\\s+(?:in\\s+the|at|this)\\s+${PART_RE}\\b)?`;
  // «at half past 3», «at a quarter to 5»
  // Dopo l'ora: confine di parola, oppure «am/pm» attaccato («7am»: fra 7 e «a» non c'è confine).
  const END = '(?:(?=\\s*(?:am|pm|a\\.m\\.|p\\.m\\.))|\\b)';
  const past = find(text, new RegExp(`\\b(?:at|by|around)\\s+(?:a\\s+)?(half|quarter|\\d{1,2}|${CLOCK_WORDS})\\s+(past|to)\\s+${H}${END}${TAIL}`));
  if (past) {
    const h = num(past.m[3]!);
    const off = past.m[1] === 'half' ? 30 : past.m[1] === 'quarter' ? 15 : num(past.m[1]!);
    if (!Number.isFinite(h) || !Number.isFinite(off) || off >= 60 || h > 24) return null;
    const total = h * 60 + (past.m[2] === 'past' ? off : -off);
    return { ...past, hour: Math.floor(((total + 1440) % 1440) / 60), minute: ((total % 60) + 60) % 60, part: partOf(past.m[5]), meridiem: meridiemOf(past.m[4]) };
  }
  const re = new RegExp(`\\b(?:at|by|around|before)\\s+${H}(?:\\s*[:.]\\s*(\\d{2}))?${END}${TAIL}`);
  let hit = find(text, re);
  if (!hit) {
    // «3pm», «7:30 am» senza preposizione; «15:30» a 24 ore.
    hit = find(text, /(?<![\d.:])(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/)
      ?? find(text, /(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/);
    if (!hit) return null;
    const hour = num(hit.m[1]!);
    const minute = hit.m[2] ? Number(hit.m[2]) : 0;
    if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
    return { ...hit, hour, minute, part: null, meridiem: meridiemOf(hit.m[3]) };
  }
  const hour = num(hit.m[1]!);
  const minute = hit.m[2] ? Number(hit.m[2]) : 0;
  if (!Number.isFinite(hour) || hour > 24 || minute > 59) return null;
  return { ...hit, hour: hour === 24 ? 0 : hour, minute, part: partOf(hit.m[4]), meridiem: meridiemOf(hit.m[3]) };
}

function meridiemOf(token: string | undefined): 'am' | 'pm' | null {
  if (!token) return null;
  return token.startsWith('p') ? 'pm' : 'am';
}

interface DaySpec { readonly kind: 'offset'; readonly days: number }
interface WeekdaySpec { readonly kind: 'weekday'; readonly weekday: number }
interface DateSpec { readonly kind: 'date'; readonly day: number; readonly month: number | null; readonly year: number | null }
type Day = (DaySpec | WeekdaySpec | DateSpec) & { readonly part: Part | null };

function dayOf(text: string): Array<Hit & Day> {
  const out: Array<Hit & Day> = [];
  const rel = find(text, new RegExp(`\\b(the\\s+day\\s+after\\s+tomorrow|today|tonight|tomorrow|this\\s+${PART_RE})\\b(?:\\s+(?:in\\s+the\\s+|at\\s+)?${PART_RE}\\b)?`));
  if (rel) {
    const w = rel.m[1]!;
    const days = w.startsWith('the day') ? 2 : w.startsWith('tomorrow') ? 1 : 0;
    const own: Part | null = w === 'tonight' ? 'evening' : w.startsWith('this') ? partOf(rel.m[2]) : null;
    out.push({ ...rel, kind: 'offset', days, part: partOf(rel.m[3]) ?? own });
  }
  const later = find(text, new RegExp(`\\b(?:in\\s+the|at)\\s+${PART_RE}\\b`));
  if (later && !rel) out.push({ ...later, kind: 'offset', days: 0, part: partOf(later.m[1]) });
  const wd = find(text, new RegExp(`\\b(?:(on|this|next|coming)\\s+)?(${WEEKDAYS.join('|')})(?:\\s+(?:in\\s+the\\s+|at\\s+)?${PART_RE})?\\b`));
  if (wd) out.push({ ...wd, kind: 'weekday', weekday: WEEKDAYS.indexOf(wd.m[2]!), part: partOf(wd.m[3]) });
  // «on 15 October», «15th of October», «October 15th», «on the 15th of October 2027»
  const dm = find(text, new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:\\s+(\\d{4}))?`))
    ?? find(text, new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`));
  if (dm) {
    const first = /^\d/.test(dm.m[1]!);
    const day = Number(first ? dm.m[1] : dm.m[2]);
    const month = monthOf(first ? dm.m[2]! : dm.m[1]!);
    out.push({ ...dm, kind: 'date', day, month, year: dm.m[3] ? Number(dm.m[3]) : null, part: null });
  }
  const slash = find(text, /\b(?:on\s+)?(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
  if (slash && !dm) {
    const y = slash.m[3] ? Number(slash.m[3]) : null;
    out.push({ ...slash, kind: 'date', day: Number(slash.m[1]), month: Number(slash.m[2]) - 1, year: y === null ? null : y < 100 ? 2000 + y : y, part: null });
  }
  return out;
}

function without(raw: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let s = raw;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) s = `${s.slice(0, a)} ${s.slice(b)}`;
  return s.replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,.;:]+|[\s,;:]+$/g, '').trim();
}

/** Il «quando» di una frase in inglese, o null se non ce n'è. */
export function parseWhenEn(raw: string, now: number): ParsedWhen | null {
  const text = fold(raw);
  const rel = relative(text);
  if (rel) return { at: now + rel.ms, exact: true, past: false, rest: without(raw, [[rel.start, rel.end]]) };
  const time = clock(text);
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
    // «on Monday» e «next Monday»: il prossimo lunedì, mai oggi.
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
    if (time.meridiem === 'pm' && hour < 12) hour += 12;
    else if (time.meridiem === 'am' && hour === 12) hour = 0;
    else if (time.meridiem === null) {
      if (part === 'afternoon' || part === 'evening') { if (hour < 12) hour += 12; }
      else if (part === 'night') { if (hour >= 6 && hour < 12) hour += 12; else if (hour === 12) hour = 0; }
      else if (part === null && hour >= 1 && hour <= 5) hour += 12; // «at 3» = 15:00, come in italiano
    }
  } else {
    hour = part ? PART_HOUR[part] : 9;
  }
  let at = new Date(y, mo, d, hour, minute, 0, 0).getTime();
  if (time && !day) {
    if (at <= now && time.part === null && time.meridiem === null && hour >= 6 && hour < 12) at += 12 * HOUR;
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

const WEEKDAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LABEL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** «today at 15:30», «tomorrow at 9:00», «Monday 13 October at 9:00» (24 ore, come l'interfaccia en-GB). */
export function describeWhenEn(at: number, now: number): string {
  const a = new Date(at);
  const n = new Date(now);
  const dayDiff = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY);
  const hm = `${a.getHours()}:${String(a.getMinutes()).padStart(2, '0')}`;
  const dayLabel = dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : dayDiff === 2 ? 'the day after tomorrow' : dayDiff === -1 ? 'yesterday'
    : `${WEEKDAY_LABEL[a.getDay()]} ${a.getDate()} ${MONTH_LABEL[a.getMonth()]}${a.getFullYear() !== n.getFullYear() ? ` ${a.getFullYear()}` : ''}`;
  return `${dayLabel} at ${hm}`;
}
