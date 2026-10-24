// Assistente personale (beta.5, P-109): promemoria e appuntamenti locali, note, agenda a voce.
// Il proprietario lo usa a voce («tra un'ora devo andare a fare la spesa») o dal widget Agenda.
// Tutto resta sul PC: tabella `reminders`, nessun servizio esterno, nessun modello (regole in
// `intent.ts` e `when.ts`). Un orologio a catena di setTimeout (al più un minuto per anello: regge
// sospensione e cambio d'ora) fa scattare i promemoria; quelli scaduti a VISIONE chiusa scattano
// all'avvio come «in ritardo».
import {
  ASSISTANT_LIMITS,
  type AssistantList,
  type ListItem,
  type Reminder,
  type ReminderAction,
  type ReminderKind,
  type ReminderRepeat,
  type ReminderSource,
  type ReminderStatus
} from '../../shared/contracts/index.ts';
import { redactString } from '../../shared/lib/redact.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Db, Row } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { Language } from '../../shared/contracts/index.ts';
import { fold, parseWhen, describeWhen, type ParsedWhen } from './when.ts';
import { describeWhenEn, parseWhenEn } from './when-en.ts';
import { isAppointment, parseAssistantRequest, tidy, type AgendaDay } from './intent.ts';
import { isAppointmentEn, tidyEn } from './intent-en.ts';
import { describeDuration, describeRepeat, nextOccurrence, parseDuration, type ListRequest } from './extra.ts';
import { createLearning, parseLearningRequest, type Learning, type LearningRequest } from './learning.ts';

export { parseWhen, describeWhen } from './when.ts';
export { parseWhenEn, describeWhenEn } from './when-en.ts';
export { parseAssistantRequest } from './intent.ts';
export { cleanQuip, composeBriefing, quipPrompt, resolveGreeting, weatherSentence, weatherWords, type BriefingEngine, type BriefingFacts, type BriefingWeather, type QuipFacts } from './briefing.ts';

const MINUTE = 60_000;
/** Oltre questo ritardo un promemoria è annunciato «in ritardo» (VISIONE era chiusa o il PC dormiva). */
const LATE_MS = 2 * MINUTE;
/** Anello massimo dell'orologio. */
const TICK_MAX_MS = MINUTE;
/** Primo controllo dopo l'avvio: il processo voce è pronto in pochi secondi e dice i promemoria scaduti. */
const START_DELAY_MS = 15_000;
/** «Bella» o «questa no» valgono per la battuta detta al più mezz'ora prima. */
const QUIP_FEEDBACK_MS = 30 * 60_000;
/** Per quanto vale la domanda «quando te lo ricordo?». */
const ASK_WHEN_MS = 45_000;

export interface AssistantTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AssistantDeps {
  readonly db: Db;
  readonly events: EventEmitter;
  readonly log: Logger;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: AssistantTimers;
  /** Attesa prima del primo controllo all'avvio (predefinita 15 s). */
  readonly startDelayMs?: number;
  /** «Salvami…»: scrive una nota nella memoria globale. Senza, le note non sono disponibili. */
  readonly saveNote?: (text: string, correlationId: string | null) => void;
  /** Lingua di VISIONE (P-108): regole delle frasi e risposte. Predefinita l'italiano. */
  readonly language?: () => Language;
}

export interface AssistantReply {
  /** Frase da dire (o mostrare) al proprietario. */
  readonly reply: string;
  readonly reminder: Reminder | null;
  /**
   * false = conferma di un'azione fatta (promemoria, timer, nota, annullamento): a voce non si dice, si
   * vede sullo schermo (scelta del proprietario, 15/10/2026: niente frasi fatte). Assente = da dire:
   * risposte vere (agenda, lista), domande e problemi.
   */
  readonly speak?: boolean;
}

export interface Assistant {
  /** Una frase a voce: la risposta, o null se non è una richiesta per l'Assistente. */
  handle(text: string, source: ReminderSource, correlationId?: string | null): AssistantReply | null;
  /** Nuovo promemoria dal widget: il «quando» da `at` o dalla frase. */
  add(text: string, at: number | undefined, source: ReminderSource, correlationId?: string | null): AssistantReply;
  list(status: 'open' | 'all', limit: number): Reminder[];
  update(id: string, action: ReminderAction, minutes?: number, correlationId?: string | null): Reminder;
  /** La frase dell'agenda («Oggi hai 2 impegni: …»). */
  agenda(day: AgendaDay): string;
  /** Quanti impegni aperti in quel giorno (il saluto di stato li dice solo se ce ne sono). */
  agendaCount(day: AgendaDay): number;
  /** P-109b: le liste con i loro elementi («spesa», «regali»…). */
  lists(): AssistantList[];
  /** P-109b: toglie un elemento da una lista (dal widget); false se non c'era. */
  removeItem(id: string): boolean;
  /** Ciò che VISIONE impara dal proprietario (22/10/2026): le sue frasi recenti e i gusti sulle battute. */
  readonly learning: Learning;
  /** La battuta appena detta nel saluto: «bella» o «questa no» nei minuti dopo la giudicano. */
  noteQuip(text: string): void;
  /** Arma l'orologio e fa scattare i promemoria scaduti mentre VISIONE era chiusa. */
  start(): void;
  close(): void;
}

function rowToReminder(r: Row): Reminder {
  return {
    id: String(r.id),
    text: String(r.text),
    kind: String(r.kind) as ReminderKind,
    dueAt: Number(r.due_at),
    notifyAt: Number(r.notify_at),
    status: String(r.status) as ReminderStatus,
    source: String(r.source) as ReminderSource,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    firedAt: r.fired_at === null || r.fired_at === undefined ? null : Number(r.fired_at),
    repeat: r.repeat === null || r.repeat === undefined ? null : (String(r.repeat) as ReminderRepeat)
  };
}

function rowToItem(r: Row): ListItem {
  return { id: String(r.id), text: String(r.text), createdAt: Number(r.created_at) };
}

/** «latte, uova e pane» / «milk, eggs and bread». */
function joinItems(items: readonly string[], lang: Language): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'e'} ${items.at(-1)}`;
}

/** «lista della spesa», «lista «regali»» / «your shopping list», «your “gifts” list». */
function listLabel(name: string, lang: Language): string {
  if (lang === 'en') return name === 'shopping' ? 'your shopping list' : `your “${name}” list`;
  return name === 'spesa' ? 'lista della spesa' : `lista «${name}»`;
}

/** Prima lettera minuscola, per mettere il testo dentro una frase. */
function inline(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function hm(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Il «quando» nella lingua di VISIONE: «oggi alle 15:30» / «today at 15:30». */
export function describeWhenIn(at: number, now: number, lang: Language): string {
  return lang === 'en' ? describeWhenEn(at, now) : describeWhen(at, now);
}

function parseWhenIn(text: string, now: number, lang: Language): ParsedWhen | null {
  return lang === 'en' ? parseWhenEn(text, now) : parseWhen(text, now);
}

const tidyIn = (s: string, lang: Language): string => (lang === 'en' ? tidyEn(s) : tidy(s));
const appointmentIn = (s: string, lang: Language): boolean => (lang === 'en' ? isAppointmentEn(s) : isAppointment(s));

/** La frase con cui un promemoria scatta (voce e notifica di Windows). */
export function fireMessage(r: Pick<Reminder, 'text' | 'kind' | 'dueAt' | 'notifyAt'>, now: number, lang: Language = 'it'): string {
  const en = lang === 'en';
  const late = now - r.notifyAt > LATE_MS;
  if (late) return en ? `Late reminder, it was for ${describeWhenEn(r.dueAt, now)}: ${inline(r.text)}.` : `Promemoria in ritardo, era per ${describeWhen(r.dueAt, now)}: ${inline(r.text)}.`;
  // P-109b: il timer finisce con «tempo scaduto», e con a cosa serviva se è stato detto.
  if (r.kind === 'timer') {
    const what = r.text && r.text !== 'Timer' ? `: ${inline(r.text)}` : '';
    return en ? `Time's up${what}.` : `Tempo scaduto${what}.`;
  }
  const ahead = Math.round((r.dueAt - now) / MINUTE);
  if (r.kind === 'appointment' && ahead >= 2) return en ? `In ${ahead} minutes: ${inline(r.text)}.` : `Tra ${ahead} minuti: ${inline(r.text)}.`;
  return en ? `Reminder: ${inline(r.text)}.` : `Promemoria: ${inline(r.text)}.`;
}

export function createAssistant(deps: AssistantDeps): Assistant {
  const { db, events, log } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => ulid(now()));
  const lang = (): Language => deps.language?.() ?? 'it';
  const timers: AssistantTimers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let timer: unknown = null;
  let closed = false;
  /** Promemoria a cui manca il «quando»: la prossima frase, se lo contiene, lo completa. */
  let askWhen: { text: string; appointment: boolean; until: number; timer?: boolean } | null = null;
  const learning = createLearning({ db, now, newId, lang });
  /** L'ultima battuta detta, finché si può giudicare. */
  let lastQuip: { text: string; at: number } | null = null;
  const learn = (req: LearningRequest): AssistantReply => {
    const en = lang() === 'en';
    switch (req.kind) {
      case 'quip-feedback': {
        if (lastQuip) learning.judge(lastQuip.text, req.verdict);
        lastQuip = null;
        return { reply: req.verdict === 'liked' ? (en ? 'Noted: more like that one.' : 'Me la segno: ne scriverò altre così.') : (en ? 'Noted: no more like that one.' : 'Ricevuto: niente più battute così.'), reminder: null, speak: false };
      }
      case 'quip-taste': {
        const { liked, disliked } = learning.taste(3);
        if (liked.length + disliked.length === 0) return { reply: en ? 'You have not judged any of my quips yet: say “nice” or “not that one” right after one.' : 'Non hai ancora giudicato le mie battute: dimmi «bella» o «questa no» subito dopo una battuta.', reminder: null };
        const q = (items: readonly string[]): string => items.map((x) => (en ? `“${x}”` : `«${x}»`)).join(' ');
        const parts = [
          liked.length > 0 ? (en ? `You liked: ${q(liked)}` : `Ti sono piaciute: ${q(liked)}`) : null,
          disliked.length > 0 ? (en ? `You did not like: ${q(disliked)}` : `Non ti sono piaciute: ${q(disliked)}`) : null
        ].filter((x): x is string => x !== null);
        return { reply: parts.join(' '), reminder: null };
      }
      case 'quip-forget': {
        const n = learning.forget();
        return { reply: en ? `Done: I forgot ${n} ${n === 1 ? 'judgement' : 'judgements'} on my quips.` : `Fatto: ho dimenticato ${n} ${n === 1 ? 'giudizio' : 'giudizi'} sulle battute.`, reminder: null, speak: false };
      }
      case 'projects':
        return { reply: learning.projects(), reminder: null };
    }
  };

  const insert = db.prepare(`INSERT INTO reminders (id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at, repeat)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?)`);
  const byId = db.prepare('SELECT * FROM reminders WHERE id = ?');
  const due = db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND notify_at <= ? ORDER BY notify_at LIMIT 20");
  const nextAt = db.prepare("SELECT MIN(notify_at) AS at FROM reminders WHERE status = 'pending'");
  const open = db.prepare("SELECT * FROM reminders WHERE status IN ('pending', 'fired') ORDER BY due_at LIMIT ?");
  const all = db.prepare('SELECT * FROM reminders ORDER BY due_at DESC LIMIT ?');
  const setFired = db.prepare("UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'");
  const setStatus = db.prepare('UPDATE reminders SET status = ?, notify_at = ?, updated_at = ? WHERE id = ?');
  // P-109b: liste.
  const insertItem = db.prepare('INSERT INTO list_items (id, list, text, created_at) VALUES (?, ?, ?, ?)');
  const itemsOf = db.prepare('SELECT * FROM list_items WHERE list = ? ORDER BY created_at, id');
  const allItems = db.prepare('SELECT * FROM list_items ORDER BY list, created_at, id');
  const itemById = db.prepare('SELECT * FROM list_items WHERE id = ?');
  const deleteItem = db.prepare('DELETE FROM list_items WHERE id = ?');
  const deleteList = db.prepare('DELETE FROM list_items WHERE list = ?');
  const listCount = db.prepare('SELECT COUNT(DISTINCT list) AS n FROM list_items');

  const fire = (): void => {
    const t = now();
    for (const row of due.all(t + 500)) {
      const r = rowToReminder(row);
      if (setFired.run(t, t, r.id).changes === 0) continue;
      const message = fireMessage(r, t, lang());
      log.info('promemoria scattato', { reminderId: r.id, lateMs: Math.max(0, t - r.notifyAt) });
      events.emit('assistant.reminder.fired', { reminderId: r.id, kind: r.kind, text: r.text, dueAt: r.dueAt, lateMs: Math.max(0, t - r.notifyAt), message });
      // P-109b: un ricorrente si ripresenta alla volta dopo (se VISIONE era chiusa, alla prossima futura).
      if (r.repeat) create(r.text, nextOccurrence(r.dueAt, r.repeat, t), r.kind, r.source, null, r.repeat);
    }
  };

  const arm = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (closed) return;
    const next = nextAt.get()?.at;
    if (next === null || next === undefined) return;
    const wait = Math.min(TICK_MAX_MS, Math.max(0, Number(next) - now()));
    timer = timers.set(() => {
      timer = null;
      try { fire(); } catch (err) { log.error('orologio dei promemoria', { err }); }
      arm();
    }, wait);
  };

  const create = (text: string, dueAt: number, kind: ReminderKind, source: ReminderSource, correlationId: string | null, repeat: ReminderRepeat | null = null): Reminder => {
    const clean = redactString(text).slice(0, ASSISTANT_LIMITS.textChars);
    const t = now();
    const lead = kind === 'appointment' ? ASSISTANT_LIMITS.appointmentLeadMinutes * MINUTE : 0;
    const notifyAt = Math.max(t, dueAt - lead);
    const id = newId();
    insert.run(id, clean, kind, dueAt, notifyAt, source, t, t, repeat);
    events.emit('assistant.reminder.created', { reminderId: id, kind, text: clean, dueAt, notifyAt, source }, correlationId ? { correlationId } : undefined);
    arm();
    return rowToReminder(byId.get(id)!);
  };

  const confirm = (r: Reminder): string => {
    const t = now();
    const en = lang() === 'en';
    const when = describeWhenIn(r.dueAt, t, lang());
    const lead = ASSISTANT_LIMITS.appointmentLeadMinutes;
    if (r.repeat) {
      const every = describeRepeat(r.repeat, r.dueAt, lang());
      return en ? `OK, I'll remind you ${every} at ${hm(r.dueAt)}. The first time is ${when}.` : `Va bene, te lo ricordo ${every} alle ${hm(r.dueAt)}. La prima volta ${when}.`;
    }
    if (r.kind === 'appointment' && r.notifyAt < r.dueAt) {
      return en ? `Noted: ${inline(r.text)}, ${when}. I'll let you know ${lead} minutes before.` : `Segnato: ${inline(r.text)}, ${when}. Ti avviso ${lead} minuti prima.`;
    }
    return en ? `OK, I'll remind you ${when}.` : `Va bene, te lo ricordo ${when}.`;
  };

  const openList = (limit: number): Reminder[] => open.all(limit).map(rowToReminder);

  const agendaItems = (day: AgendaDay, t: number): Reminder[] => {
    const d = new Date(t);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (day === 'tomorrow' ? 1 : 0)).getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (day === 'tomorrow' ? 2 : 1)).getTime();
    return openList(ASSISTANT_LIMITS.listMax).filter((r) => day === 'upcoming' || (r.dueAt >= start && r.dueAt < end));
  };

  const agenda = (day: AgendaDay): string => {
    const t = now();
    const items = agendaItems(day, t);
    if (lang() === 'en') {
      const label = day === 'today' ? 'Today' : day === 'tomorrow' ? 'Tomorrow' : '';
      if (items.length === 0) return day === 'upcoming' ? 'You have no reminders planned.' : `${label} you have nothing planned.`;
      const shown = items.slice(0, 6).map((r) => `${day === 'upcoming' ? describeWhenEn(r.dueAt, t) : `at ${hm(r.dueAt)}`} ${inline(r.text)}`);
      const more = items.length > shown.length ? ` And ${items.length - shown.length} more.` : '';
      const count = items.length === 1 ? 'one thing planned' : `${items.length} things planned`;
      return `${day === 'upcoming' ? 'You have' : `${label} you have`} ${count}: ${shown.join('; ')}.${more}`;
    }
    const label = day === 'today' ? 'Oggi' : day === 'tomorrow' ? 'Domani' : '';
    if (items.length === 0) return day === 'upcoming' ? 'Non hai promemoria in programma.' : `${label} non hai niente in programma.`;
    const shown = items.slice(0, 6).map((r) => `${day === 'upcoming' ? describeWhen(r.dueAt, t) : `alle ${hm(r.dueAt)}`} ${inline(r.text)}`);
    const more = items.length > shown.length ? ` E altri ${items.length - shown.length}.` : '';
    const count = items.length === 1 ? 'un impegno' : `${items.length} impegni`;
    return `${day === 'upcoming' ? 'Hai' : `${label} hai`} ${count}: ${shown.join('; ')}.${more}`;
  };

  /** Promemoria aperti che contengono tutte le parole significative della richiesta. */
  const matching = (query: string): Reminder[] => {
    const words = fold(query).split(/\s+/).filter((w) => w.length > 2 && !['del', 'della', 'dello', 'dal', 'dalla', 'per', 'che', 'con', 'the', 'for', 'about', 'that', 'with', 'and'].includes(w));
    const list = openList(ASSISTANT_LIMITS.listMax);
    if (words.length === 0) return list;
    return list.filter((r) => { const t = fold(r.text); return words.every((w) => t.includes(w)); });
  };

  const update = (id: string, action: ReminderAction, minutes?: number, correlationId: string | null = null): Reminder => {
    const row = byId.get(id);
    if (!row) throw new CommandFailure('not_found', lang() === 'en' ? `reminder ${id} does not exist` : `promemoria ${id} inesistente`);
    const r = rowToReminder(row);
    if (r.status === 'done' || r.status === 'cancelled') {
      throw new CommandFailure('operation_failed', lang() === 'en' ? `reminder already ${r.status === 'done' ? 'done' : 'cancelled'}` : `promemoria già ${r.status === 'done' ? 'fatto' : 'annullato'}`);
    }
    const t = now();
    const status: ReminderStatus = action === 'done' ? 'done' : action === 'cancel' ? 'cancelled' : 'pending';
    const notifyAt = action === 'snooze' ? t + (minutes ?? 10) * MINUTE : r.notifyAt;
    setStatus.run(status, notifyAt, t, id);
    events.emit('assistant.reminder.changed', { reminderId: id, action, status, notifyAt }, correlationId ? { correlationId } : undefined);
    arm();
    return rowToReminder(byId.get(id)!);
  };

  const remind = (text: string, at: number, exact: boolean, appointment: boolean, source: ReminderSource, correlationId: string | null, repeat: ReminderRepeat | null = null): AssistantReply => {
    const en = lang() === 'en';
    if (at <= now()) return { reply: en ? 'That time has already passed: tell me another one.' : 'Quell\'ora è già passata: dimmi un altro momento.', reminder: null };
    const what = text.length > 0 ? text : en ? 'Reminder' : 'Promemoria';
    const r = create(what, at, appointment ? 'appointment' : 'reminder', source, correlationId, repeat);
    return { reply: confirm(r) + (exact ? '' : en ? ' If you want an exact time, tell me.' : ' Se vuoi un\'ora precisa, dimmela.'), reminder: r, speak: false };
  };

  /** P-109b: «metti un timer di 10 minuti per la pasta». */
  const startTimer = (seconds: number, label: string, source: ReminderSource, correlationId: string | null): AssistantReply => {
    const en = lang() === 'en';
    const text = label.length > 0 ? label[0]!.toUpperCase() + label.slice(1) : 'Timer';
    const r = create(text, now() + seconds * 1000, 'timer', source, correlationId);
    const length = describeDuration(seconds, lang());
    return { reply: en ? `Timer set for ${length}${label ? `: ${label}` : ''}.` : `Timer di ${length} avviato${label ? ` per ${label}` : ''}.`, reminder: r, speak: false };
  };

  /** P-109b: aggiungi, leggi, togli, svuota una lista. */
  const listReply = (req: ListRequest, correlationId: string | null): string => {
    const l = lang();
    const en = l === 'en';
    const name = req.list.slice(0, ASSISTANT_LIMITS.listNameChars);
    const label = listLabel(name, l);
    const current = itemsOf.all(name).map(rowToItem);
    const changed = (op: 'add' | 'remove' | 'clear', items: number): void => {
      events.emit('assistant.list.changed', { list: name, op, items }, correlationId ? { correlationId } : undefined);
    };
    switch (req.op) {
      case 'read': {
        if (current.length === 0) return en ? `${label[0]!.toUpperCase()}${label.slice(1)} is empty.` : `La ${label} è vuota.`;
        const shown = current.slice(0, 15).map((i) => i.text);
        const more = current.length > shown.length ? (en ? ` And ${current.length - shown.length} more.` : ` E altre ${current.length - shown.length}.`) : '';
        return en ? `On ${label}: ${joinItems(shown, l)}.${more}` : `Nella ${label}: ${joinItems(shown, l)}.${more}`;
      }
      case 'add': {
        if (req.items.length === 0) return en ? 'What should I add?' : 'Cosa aggiungo?';
        if (current.length === 0 && Number(listCount.get()?.n ?? 0) >= ASSISTANT_LIMITS.lists) {
          return en ? `You already have ${ASSISTANT_LIMITS.lists} lists: clear one first.` : `Hai già ${ASSISTANT_LIMITS.lists} liste: svuotane una prima.`;
        }
        const have = new Set(current.map((i) => fold(i.text).trim()));
        const added: string[] = [];
        const t = now();
        for (const item of req.items) {
          const clean = redactString(item).slice(0, ASSISTANT_LIMITS.itemChars).trim();
          const key = fold(clean).trim();
          if (key.length === 0 || have.has(key)) continue;
          if (current.length + added.length >= ASSISTANT_LIMITS.listItems) break;
          insertItem.run(newId(), name, clean, t);
          have.add(key);
          added.push(clean);
        }
        if (added.length === 0) return en ? `It's already on ${label}.` : `C'è già nella ${label}.`;
        changed('add', current.length + added.length);
        return en ? `Added to ${label}: ${joinItems(added, l)}.` : `Aggiunto alla ${label}: ${joinItems(added, l)}.`;
      }
      case 'remove': {
        const removed: string[] = [];
        const gone = new Set<string>();
        for (const item of req.items) {
          const key = fold(item).trim();
          const found = current.find((i) => !gone.has(i.id) && key.length > 0 && fold(i.text).includes(key));
          if (!found) continue;
          deleteItem.run(found.id);
          gone.add(found.id);
          removed.push(found.text);
        }
        if (removed.length === 0) return en ? `I can't find ${joinItems([...req.items], l) || 'that'} on ${label}.` : `Non trovo ${joinItems([...req.items], l) || 'niente'} nella ${label}.`;
        changed('remove', current.length - removed.length);
        return en ? `Removed from ${label}: ${joinItems(removed, l)}.` : `Tolto dalla ${label}: ${joinItems(removed, l)}.`;
      }
      case 'clear': {
        if (current.length === 0) return en ? `${label[0]!.toUpperCase()}${label.slice(1)} was already empty.` : `La ${label} era già vuota.`;
        deleteList.run(name);
        changed('clear', 0);
        const n = current.length;
        return en ? `I cleared ${label} (${n === 1 ? '1 item' : `${n} items`}).` : `Ho svuotato la ${label} (${n === 1 ? '1 elemento' : `${n} elementi`}).`;
      }
    }
  };

  return {
    handle(text, source, correlationId = null) {
      const t = now();
      const l = lang();
      const en = l === 'en';
      if (askWhen && t <= askWhen.until) {
        const pending = askWhen;
        askWhen = null;
        const dropIt = en ? /^\s*(?:never\s*mind|forget\s+it|cancel|no|nothing|leave\s+it)\b/ : /^\s*(?:lascia\s+stare|niente|annulla|no|non\s+importa)\b/;
        if (dropIt.test(fold(text))) return { reply: en ? 'OK, never mind.' : 'Va bene, lascio stare.', reminder: null, speak: false };
        if (pending.timer) {
          const length = parseDuration(fold(text), l);
          if (length) return startTimer(Math.min(length.seconds, 24 * 3600), pending.text, source, correlationId);
        } else {
          const when = parseWhenIn(text, t, l);
          if (when) return remind(pending.text, when.at, when.exact, pending.appointment, source, correlationId);
        }
      }
      askWhen = null;
      const learned = parseLearningRequest(text, l, lastQuip !== null && t - lastQuip.at <= QUIP_FEEDBACK_MS);
      if (learned) return learn(learned);
      const req = parseAssistantRequest(text, t, l);
      if (!req) return null;
      switch (req.kind) {
        case 'reminder': {
          if (!req.when) {
            if (req.text.length === 0) return { reply: en ? 'What should I remind you about, and when?' : 'Cosa ti devo ricordare, e quando?', reminder: null };
            askWhen = { text: req.text, appointment: req.appointment, until: t + ASK_WHEN_MS };
            return { reply: en ? 'When should I remind you?' : 'Quando te lo ricordo?', reminder: null };
          }
          return remind(req.text, req.when.at, req.when.exact, req.appointment, source, correlationId, req.repeat ?? null);
        }
        case 'timer': {
          if (req.seconds === null) {
            askWhen = { text: req.label, appointment: false, until: t + ASK_WHEN_MS, timer: true };
            return { reply: en ? 'For how long?' : 'Di quanto?', reminder: null };
          }
          return startTimer(req.seconds, req.label, source, correlationId);
        }
        case 'list': {
          // Leggere la lista è una risposta; aggiungere o togliere è un'azione (si dice solo se chiede qualcosa).
          const reply = listReply(req, correlationId);
          return { reply, reminder: null, speak: req.op === 'read' || reply.trim().endsWith('?') };
        }
        case 'note': {
          if (!deps.saveNote) return { reply: en ? 'Notes are not available.' : 'Le note non sono disponibili.', reminder: null };
          deps.saveNote(req.text, correlationId);
          return { reply: en ? 'Saved to your notes.' : 'Salvato nelle note.', reminder: null, speak: false };
        }
        case 'agenda':
          return { reply: agenda(req.day), reminder: null };
        case 'cancel': {
          const matched = matching(req.query).filter((r) => !req.onlyTimers || (r.kind === 'timer' && r.status === 'pending'));
          // Uno già scattato e uno in attesa (un ricorrente, lo stesso timer): si annulla quello in attesa.
          const waiting = matched.filter((r) => r.status === 'pending');
          const found = matched.length > 1 && waiting.length === 1 ? waiting : matched;
          if (found.length === 0 && req.onlyTimers) return { reply: en ? 'There is no timer running.' : 'Non c\'è nessun timer attivo.', reminder: null };
          if (found.length === 0) {
            const none = en ? (req.query ? `I can't find a reminder about “${inline(req.query)}”.` : 'You have no reminders to cancel.') : (req.query ? `Non trovo un promemoria su «${inline(req.query)}».` : 'Non hai promemoria da annullare.');
            return { reply: none, reminder: null };
          }
          if (found.length > 1) return { reply: en ? `I found ${found.length}: tell me which one, or cancel it from the Agenda widget.` : `Ne trovo ${found.length}: dimmi meglio quale, o annullalo dal widget Agenda.`, reminder: null };
          const r = update(found[0]!.id, 'cancel', undefined, correlationId);
          return { reply: en ? `Cancelled: ${inline(r.text)}.` : `Annullato: ${inline(r.text)}.`, reminder: r, speak: false };
        }
      }
    },
    add(text, at, source, correlationId = null) {
      const t = now();
      const l = lang();
      if (at !== undefined) return remind(tidyIn(text, l), at, true, appointmentIn(text, l), source, correlationId);
      const req = parseAssistantRequest(text, t, l);
      if (req?.kind === 'reminder' && req.when) return remind(req.text, req.when.at, req.when.exact, req.appointment, source, correlationId);
      const when = parseWhenIn(text, t, l);
      if (!when) {
        throw new CommandFailure('invalid_payload', l === 'en' ? 'missing the time: write for example “in an hour” or “tomorrow at 3pm”' : 'manca il quando: scrivi per esempio «tra un\'ora» o «domani alle 15»');
      }
      const what = tidyIn(when.rest, l);
      return remind(what, when.at, when.exact, appointmentIn(what, l), source, correlationId);
    },
    list(status, limit) {
      return status === 'open' ? openList(limit) : all.all(limit).map(rowToReminder);
    },
    update,
    agenda,
    agendaCount: (day) => agendaItems(day, now()).length,
    lists() {
      const byName = new Map<string, ListItem[]>();
      for (const row of allItems.all()) {
        const name = String(row.list);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(rowToItem(row));
      }
      return [...byName.entries()].slice(0, ASSISTANT_LIMITS.lists).map(([name, items]) => ({ name, items: items.slice(0, ASSISTANT_LIMITS.listItems) }));
    },
    learning,
    noteQuip(text) {
      lastQuip = text.trim().length > 0 ? { text: text.trim(), at: now() } : null;
    },
    removeItem(id) {
      const row = itemById.get(id);
      if (!row) return false;
      deleteItem.run(id);
      const list = String(row.list);
      events.emit('assistant.list.changed', { list, op: 'remove', items: itemsOf.all(list).length });
      return true;
    },
    start() {
      closed = false;
      if (timer !== null) timers.clear(timer);
      timer = timers.set(() => {
        timer = null;
        try { fire(); } catch (err) { log.error('promemoria scaduti all\'avvio', { err }); }
        arm();
      }, deps.startDelayMs ?? START_DELAY_MS);
    },
    close() {
      closed = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    }
  };
}

export function registerAssistantCommands(router: CommandRouter, assistant: Assistant, now: () => number = Date.now, language: () => Language = () => 'it'): void {
  router.register('assistant.parse', (payload) => {
    const t = now();
    const l = language();
    const req = parseAssistantRequest(payload.text, t, l);
    const when = req?.kind === 'reminder' ? req.when : parseWhenIn(payload.text, t, l);
    const text = req?.kind === 'reminder' ? req.text : when ? tidyIn(when.rest, l) : tidyIn(payload.text, l);
    return {
      at: when ? when.at : null,
      exact: when?.exact ?? false,
      past: when?.past ?? false,
      label: when ? describeWhenIn(when.at, t, l) : null,
      text,
      appointment: req?.kind === 'reminder' ? req.appointment : appointmentIn(text, l),
      request: req?.kind ?? null
    };
  });
  // P-109b: dal widget come a voce; `handled: false` se la frase non è per l'Assistente.
  router.register('assistant.ask', (payload, ctx) => {
    const out = assistant.handle(payload.text, 'ui', ctx.command.correlationId);
    return { handled: out !== null, reply: out ? out.reply.slice(0, 700) : null };
  });
  router.register('assistant.lists.get', () => ({ lists: assistant.lists() }));
  router.register('assistant.list.remove', (payload) => ({ removed: assistant.removeItem(payload.id) }));
  router.register('assistant.reminders.list', (payload) => ({ reminders: assistant.list(payload.status, payload.limit) }));
  router.register('assistant.reminder.add', (payload, ctx) => {
    const out = assistant.add(payload.text, payload.at, 'ui', ctx.command.correlationId);
    if (!out.reminder) throw new CommandFailure('invalid_payload', out.reply);
    return { reminder: out.reminder, reply: out.reply };
  });
  router.register('assistant.reminder.update', (payload, ctx) => ({
    reminder: assistant.update(payload.id, payload.action, payload.minutes, ctx.command.correlationId)
  }));
}
