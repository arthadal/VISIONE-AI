// Assistente, secondo giro (P-109b, 15/10/2026): promemoria ricorrenti, timer e liste. Come il primo giro,
// regole locali e nessun modello: si riconoscono solo forme esplicite, il resto resta al Director.
// - ricorrenti: «ogni giorno alle 8», «ogni lunedì», «dal lunedì al venerdì» / «every day», «every Monday»;
// - timer: «metti un timer di 10 minuti per la pasta» / «set a timer for 5 minutes»;
// - liste: «aggiungi latte e uova alla lista della spesa», «cosa c'è nella lista», «togli il latte dalla
//   lista», «svuota la lista» / «add milk to my shopping list», «what's on my list»…
import type { Language, ReminderRepeat } from '../../shared/contracts/index.ts';
import { fold, type ParsedWhen } from './when.ts';

const MINUTE = 60_000;

// ── Ricorrenze ─────────────────────────────────────────────────────────────────────────────────────

export interface RepeatHit {
  readonly repeat: ReminderRepeat;
  /** 0 = domenica … 6 = sabato, solo per `weekly`. */
  readonly weekday: number | null;
  /** Ora predefinita se la frase non la dice («ogni sera» → 20). */
  readonly defaultHour: number;
  readonly start: number;
  readonly end: number;
}

const DAYS_IT: Record<string, number> = { domenica: 0, domeniche: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6, sabati: 6 };
const DAYS_EN: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const hit = (m: RegExpExecArray, repeat: ReminderRepeat, weekday: number | null, defaultHour: number): RepeatHit => ({
  repeat, weekday, defaultHour, start: m.index, end: m.index + m[0].length
});

/** La ricorrenza detta nella frase (testo già ripiegato con `fold`), o null. */
export function findRepeat(text: string, lang: Language): RepeatHit | null {
  let m: RegExpExecArray | null;
  if (lang === 'en') {
    if ((m = /\b(?:every\s+(?:weekday|working\s+day|work\s+day)|on\s+weekdays|weekdays|(?:from\s+)?monday\s+(?:to|through)\s+friday)\b/.exec(text))) return hit(m, 'weekdays', null, 9);
    if ((m = /\b(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/.exec(text))) return hit(m, 'weekly', DAYS_EN[m[1] ?? m[2]!]!, 9);
    if ((m = /\b(?:every\s+(evening|night)|each\s+(evening|night))\b/.exec(text))) return hit(m, 'daily', null, (m[1] ?? m[2]) === 'night' ? 22 : 20);
    if ((m = /\b(?:every\s+(?:day|morning)|each\s+(?:day|morning)|everyday|daily)\b/.exec(text))) return hit(m, 'daily', null, 9);
    return null;
  }
  if ((m = /\b(?:dal\s+lunedi\s+al\s+venerdi|(?:nei|tutti\s+i)\s+giorni\s+(?:feriali|lavorativi)|ogni\s+giorno\s+(?:feriale|lavorativo)|nei\s+feriali)\b/.exec(text))) return hit(m, 'weekdays', null, 9);
  if ((m = /\b(?:ogni|tutti\s+i|tutte\s+le)\s+(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|sabati|domenica|domeniche)\b/.exec(text))) return hit(m, 'weekly', DAYS_IT[m[1]!]!, 9);
  if ((m = /\b(?:ogni\s+(sera|notte)|tutte\s+le\s+(sere|notti))\b/.exec(text))) return hit(m, 'daily', null, (m[1] ?? m[2]!).startsWith('nott') ? 22 : 20);
  if ((m = /\b(?:ogni\s+(?:giorno|mattina)|tutti\s+i\s+giorni|tutte\s+le\s+mattine|quotidianamente)\b/.exec(text))) return hit(m, 'daily', null, 9);
  return null;
}

/** Il testo con uno spezzone sostituito da spazi (le posizioni del resto non cambiano). */
export function blank(raw: string, start: number, end: number): string {
  return raw.slice(0, start) + ' '.repeat(end - start) + raw.slice(end);
}

const fits = (d: Date, repeat: ReminderRepeat, weekday: number | null): boolean => {
  const day = d.getDay();
  return repeat === 'daily' || (repeat === 'weekdays' ? day >= 1 && day <= 5 : day === weekday);
};

/** La prima volta di una ricorrenza: all'ora detta (o a quella predefinita), nel primo giorno valido futuro. */
export function firstOccurrence(rep: Pick<RepeatHit, 'repeat' | 'weekday' | 'defaultHour'>, when: ParsedWhen | null, now: number): number {
  const at = when?.exact ? new Date(when.at) : null;
  const hour = at ? at.getHours() : rep.defaultHour;
  const minute = at ? at.getMinutes() : 0;
  const base = new Date(now);
  for (let i = 0; i < 9; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hour, minute, 0, 0);
    if (d.getTime() > now && fits(d, rep.repeat, rep.weekday)) return d.getTime();
  }
  return now + 24 * 60 * MINUTE; // irraggiungibile: ogni ricorrenza cade in una settimana
}

/** La volta dopo `prev` (stessa ora; per `weekly` lo stesso giorno della settimana), comunque nel futuro. */
export function nextOccurrence(prev: number, repeat: ReminderRepeat, now: number): number {
  const p = new Date(prev);
  const weekday = repeat === 'weekly' ? p.getDay() : null;
  for (let i = 1; i < 800; i++) {
    const d = new Date(p.getFullYear(), p.getMonth(), p.getDate() + i, p.getHours(), p.getMinutes(), 0, 0);
    if (d.getTime() > now && fits(d, repeat, weekday)) return d.getTime();
  }
  return now + 24 * 60 * MINUTE;
}

/** «ogni giorno», «dal lunedì al venerdì», «ogni lunedì» / «every day», «on weekdays», «every Monday». */
export function describeRepeat(repeat: ReminderRepeat, at: number, lang: Language): string {
  const day = new Date(at).getDay();
  if (lang === 'en') {
    if (repeat === 'daily') return 'every day';
    if (repeat === 'weekdays') return 'Monday to Friday';
    return `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}`;
  }
  if (repeat === 'daily') return 'ogni giorno';
  if (repeat === 'weekdays') return 'dal lunedì al venerdì';
  return `ogni ${['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'][day]}`;
}

// ── Timer ──────────────────────────────────────────────────────────────────────────────────────────

const NUMBERS_IT: Record<string, number> = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11,
  dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
  venticinque: 25, trenta: 30, trentacinque: 35, quaranta: 40, quarantacinque: 45, cinquanta: 50, sessanta: 60, novanta: 90
};
const NUMBERS_EN: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90
};
const alt = (o: Record<string, number>): string => Object.keys(o).sort((a, b) => b.length - a.length).join('|');
const DUR_IT = new RegExp(String.raw`\b(\d{1,3}|${alt(NUMBERS_IT)})\s*'?\s*(ore|ora|minuti|minuto|min|secondi|secondo|sec)\b(?:\s+e\s+(mezzo|mezza))?|\bmezz\s*'?\s*ora\b|\bun\s+quarto\s+d\s*'?\s*ora\b`, 'g');
const DUR_EN = new RegExp(String.raw`\b(\d{1,3}|${alt(NUMBERS_EN)})[\s-]*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b(?:\s+and\s+a\s+half)?|\bhalf\s+an\s+hour\b|\ba\s+quarter\s+of\s+an\s+hour\b`, 'g');

export interface DurationHit {
  readonly seconds: number;
  readonly start: number;
  readonly end: number;
}

/** Durata detta nel testo ripiegato («10 minuti e 30 secondi», «un'ora e mezza»), o null. */
export function parseDuration(text: string, lang: Language): DurationHit | null {
  const re = new RegExp(lang === 'en' ? DUR_EN : DUR_IT);
  const numbers = lang === 'en' ? NUMBERS_EN : NUMBERS_IT;
  let seconds = 0;
  let start = -1;
  let end = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let s: number;
    if (!m[1]) s = /quart/.test(m[0]) ? 900 : 1800;
    else {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : numbers[m[1].replace(/-/g, ' ')] ?? Number.NaN;
      if (!Number.isFinite(n) || n <= 0) continue;
      const u = m[2]!;
      const unit = /^(?:or|h)/.test(u) ? 3600 : /^(?:min)/.test(u) ? 60 : 1;
      s = n * unit + (/mezz|half/.test(m[0].slice(m[1].length + u.length)) ? unit / 2 : 0);
    }
    seconds += s;
    if (start < 0) start = m.index;
    end = m.index + m[0].length;
  }
  return seconds > 0 ? { seconds: Math.round(seconds), start, end } : null;
}

/** «Dieci minuti», «un'ora e cinque minuti», «30 secondi» / «10 minutes». */
export function describeDuration(seconds: number, lang: Language): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const en = lang === 'en';
  const part = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const parts = [
    h > 0 ? part(h, en ? 'hour' : 'ora', en ? 'hours' : 'ore') : '',
    m > 0 ? part(m, en ? 'minute' : 'minuto', en ? 'minutes' : 'minuti') : '',
    s > 0 ? part(s, en ? 'second' : 'secondo', en ? 'seconds' : 'secondi') : ''
  ].filter((x) => x.length > 0);
  return parts.join(en ? ' and ' : ' e ');
}

const TIMER_IT = /^\s*(?:(?:ehi|ok|hey)\s+)?(?:visione\s+)?(?:per\s+favore\s+)?(?:(?:metti|mettimi|imposta|avvia|fai\s+partire|parti\s+con|crea|attiva|fammi)\s+)?(?:un\s+)?(?:timer|conto\s+alla\s+rovescia)\b/;
const TIMER_EN = /^\s*(?:(?:hey|ok|okay)\s+)?(?:visione\s*)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:set|start|put|make|create|give\s+me)\s+)?(?:me\s+)?(?:a\s+|an\s+)?(?:(\d{1,3}|[a-z]+)[\s-]*(minutes?|mins?|seconds?|secs?|hours?)\s+)?(?:timer|countdown)\b/;

export interface TimerRequest {
  readonly seconds: number | null;
  /** A cosa serve («la pasta»), vuoto se non detto. */
  readonly label: string;
}

/** «Metti un timer di 10 minuti per la pasta» → 600 s, «la pasta». Null se la frase non è un timer. */
export function parseTimer(raw: string, lang: Language): TimerRequest | null {
  const text = fold(raw);
  const head = (lang === 'en' ? TIMER_EN : TIMER_IT).exec(text);
  if (!head) return null;
  // La durata può stare prima («a 5 minute timer») o dopo la parola «timer».
  const dur = parseDuration(text, lang);
  if (dur && dur.end > head[0].length && dur.start < head[0].length) return null;
  const rest = dur && dur.start >= head[0].length ? blank(raw, dur.start, dur.end).slice(head[0].length) : raw.slice(head[0].length);
  const label = rest
    .replace(/\s+/g, ' ')
    .replace(lang === 'en' ? /^\s*(?:of|for|to)\s*(?=$|\s)/i : /^\s*(?:di|da)\s*(?=$|\s)/i, '')
    .replace(lang === 'en' ? /^\s*(?:for|to)\s+/i : /^\s*(?:per|che)\s+/i, '')
    .replace(/[.!?\s]+$/g, '')
    .trim();
  return { seconds: dur ? Math.min(dur.seconds, 24 * 3600) : null, label: label.length > 0 ? label[0]!.toLowerCase() + label.slice(1) : '' };
}

// ── Liste ──────────────────────────────────────────────────────────────────────────────────────────

export type ListOp = 'add' | 'read' | 'remove' | 'clear';

export interface ListRequest {
  readonly op: ListOp;
  /** Nome della lista, minuscolo («spesa», «regali di natale»). */
  readonly list: string;
  readonly items: readonly string[];
}

const LEAD_IT = String.raw`^\s*(?:(?:ehi|ok|hey)\s+)?(?:visione\s+)?(?:per\s+favore\s+)?`;
const LEAD_EN = String.raw`^\s*(?:(?:hey|ok|okay)\s+)?(?:visione\s*)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?`;
const LIST_IT = {
  add: new RegExp(LEAD_IT + String.raw`(?:aggiungi|aggiungimi|metti|mettimi|segna|segnami|scrivi|inserisci)\s+(.+?)\s+(?:alla|nella|sulla|in|nelle|sulle|alle)\s+(?:mia\s+)?lista\b(.*)$`, 'd'),
  read: new RegExp(LEAD_IT + String.raw`(?:(?:(?:che\s+)?cosa|che)\s+c\s*'?\s*e\s+(?:nella|sulla|in)|leggimi|dimmi|mostrami|mostra|apri|fammi\s+vedere|elenca|com\s*'?\s*e)\s+(?:la\s+)?(?:mia\s+)?lista\b(.*)$`, 'd'),
  remove: new RegExp(LEAD_IT + String.raw`(?:togli|toglimi|rimuovi|cancella|elimina|leva|spunta|depenna)\s+(.+?)\s+(?:dalla|dalle|dal)\s+(?:mia\s+)?lista\b(.*)$`, 'd'),
  clear: new RegExp(LEAD_IT + String.raw`(?:svuota|cancella|azzera|pulisci|elimina)\s+(?:tutta\s+)?(?:la\s+)?(?:mia\s+)?lista\b(.*)$`, 'd')
};
const LIST_EN = {
  add: new RegExp(LEAD_EN + String.raw`(?:add|put|write\s+down|write)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:my\s+|the\s+)?(?:([a-z' ]+?)\s+)?list\b(.*)$`, 'd'),
  read: new RegExp(LEAD_EN + String.raw`(?:what\s*(?:'\s*s|\s+is)\s+on|what\s+do\s+i\s+have\s+on|read(?:\s+me)?|show(?:\s+me)?|tell\s+me|open)\s+(?:my\s+|the\s+)?(?:([a-z' ]+?)\s+)?list\b(.*)$`, 'd'),
  remove: new RegExp(LEAD_EN + String.raw`(?:remove|delete|take|cross|tick)\s+(?:off\s+)?(.+?)\s+(?:off|from|out\s+of)\s+(?:my\s+|the\s+)?(?:([a-z' ]+?)\s+)?list\b(.*)$`, 'd'),
  clear: new RegExp(LEAD_EN + String.raw`(?:clear|empty|wipe)\s+(?:out\s+)?(?:my\s+|the\s+)?(?:([a-z' ]+?)\s+)?list\b(.*)$`, 'd')
};

// «un po' di» prima di «un»: l'alternativa più lunga deve vincere.
const ARTICLES_IT = /^(?:(?:un\s+po\s*'?\s*di|il|lo|la|i|gli|le|uno|una|un|dello|della|dei|degli|delle|del|qualche|anche)\s+|l\s*'\s*|dell\s*'\s*|un\s*'\s*)/i;
const ARTICLES_EN = /^(?:(?:a|an|the|some|my|also|more)\s+)/i;

function items(segment: string, lang: Language): string[] {
  const parts = segment.split(lang === 'en' ? /\s*,\s*|\s+and\s+/i : /\s*,\s*|\s+e\s+|\s+ed\s+/i);
  const out: string[] = [];
  for (const p of parts) {
    let s = p.trim();
    for (let i = 0; i < 3; i++) s = s.replace(lang === 'en' ? ARTICLES_EN : ARTICLES_IT, '').trim();
    s = s.replace(/[.!?]+$/g, '').trim();
    if (s.length > 0) out.push((s[0]!.toLowerCase() + s.slice(1)).slice(0, 120));
  }
  return out.slice(0, 20);
}

function listName(raw: string, lang: Language): string {
  const name = raw
    .replace(/[.!?]+$/g, '')
    .replace(lang === 'en' ? /^\s*(?:of|for)\s+/i : /^\s*(?:della|delle|dei|degli|dello|del|di|per\s+(?:la|le|il|i|gli|lo)|per)\s+/i, '')
    .trim()
    .toLowerCase()
    .slice(0, 40);
  if (name.length > 0) return name;
  return lang === 'en' ? 'shopping' : 'spesa';
}

/** Una richiesta sulle liste («aggiungi il latte alla lista della spesa»), o null. */
export function parseList(raw: string, lang: Language): ListRequest | null {
  const text = fold(raw);
  const rules = lang === 'en' ? LIST_EN : LIST_IT;
  // Le posizioni di `fold` valgono sull'originale: gli elementi conservano maiuscole e accenti.
  const segment = (m: RegExpExecArray, group: number): string => {
    const span = m.indices?.[group];
    return span ? raw.slice(span[0], span[1]) : '';
  };
  for (const op of ['add', 'remove', 'clear', 'read'] as const) {
    const m = rules[op].exec(text);
    if (!m) continue;
    if (lang === 'en') {
      const named = op === 'add' || op === 'remove' ? m[2] : m[1];
      const tail = op === 'add' || op === 'remove' ? m[3] : m[2];
      const list = named && named.trim() ? listName(named, 'en') : listName(tail ?? '', 'en');
      return { op, list, items: op === 'add' || op === 'remove' ? items(segment(m, 1), 'en') : [] };
    }
    const tail = op === 'add' || op === 'remove' ? m[2] : m[1];
    return { op, list: listName(tail ?? '', 'it'), items: op === 'add' || op === 'remove' ? items(segment(m, 1), 'it') : [] };
  }
  return null;
}
