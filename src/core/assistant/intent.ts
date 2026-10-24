// Assistente personale (beta.5, P-109): una frase è una richiesta per l'Assistente? Regole locali,
// nessun modello. Riconosce SOLO forme esplicite («ricordami…», «salvami…», «cosa devo fare oggi»,
// «annulla il promemoria…») e la forma naturale «tra un'ora devo…» / «domani alle 15 ho il dentista».
// Tutto il resto (in particolare il lavoro sul codice) resta un obiettivo per il Director.
import type { Language, ReminderRepeat } from '../../shared/contracts/index.ts';
import { blank, findRepeat, firstOccurrence, parseList, parseTimer, type ListOp } from './extra.ts';
import { parseAssistantRequestEn } from './intent-en.ts';
import { fold, parseWhen, type ParsedWhen } from './when.ts';

export type AgendaDay = 'today' | 'tomorrow' | 'upcoming';

export type AssistantRequest =
  | { readonly kind: 'reminder'; readonly text: string; readonly when: ParsedWhen | null; readonly appointment: boolean; readonly repeat?: ReminderRepeat | null }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'agenda'; readonly day: AgendaDay }
  | { readonly kind: 'cancel'; readonly query: string; readonly onlyTimers?: boolean }
  // Secondo giro (P-109b, 15/10/2026): timer e liste.
  | { readonly kind: 'timer'; readonly seconds: number | null; readonly label: string }
  | { readonly kind: 'list'; readonly op: ListOp; readonly list: string; readonly items: readonly string[] };

const LEAD = String.raw`^\s*(?:(?:ehi|ok|hey)\s+)?(?:visione\s+)?(?:per\s+favore\s+)?`;
const REMIND_WORDS = String.raw`(ricordamelo|ricordami|ricorda\s+mi|fammi\s+ricordare|(?:mettimi|metti|crea|imposta|aggiungi|fissa)\s+(?:un\s+)?promemoria|promemoria|avvisami|svegliami|ricordati\s+di)\b`;
const REMIND = new RegExp(LEAD + REMIND_WORDS);
/** Le stesse parole in un punto qualunque: «ogni lunedì alle 9 ricordami di…». */
const REMIND_ANY = new RegExp(String.raw`\b` + REMIND_WORDS);
const NOTE = new RegExp(LEAD + String.raw`(salvami|salva\s+(?:una\s+nota|questo|questa\s+cosa|nelle\s+note|in\s+memoria)|annotami|annotati|annota\s+che|prendi\s+nota|segnati|memorizza|ricordati\s+che|tieni\s+a\s+mente)\b`);
const AGENDA = new RegExp(LEAD + String.raw`(?:(?:cosa|che\s+cosa|che)\s+(?:devo\s+fare|ho\s+da\s+fare|ho\s+in\s+programma|impegni\s+ho|appuntamenti\s+ho|promemoria\s+ho)|(?:quali\s+sono\s+)?(?:i\s+miei|gli|i)\s+(?:promemoria|impegni|appuntamenti)\b|(?:leggimi|dimmi|elenca)\s+(?:i\s+(?:miei\s+)?promemoria|gli\s+impegni|i\s+miei\s+impegni|l\s*'\s*agenda|gli\s+appuntamenti))`);
/**
 * Domande sugli impegni (17/10/2026, collaudo della modalità offline): «domani sono libero o ho impegni?»
 * diventava un promemoria «sono libero o ho impegni» per domani alle 9. Valgono se sono una domanda.
 */
const AGENDA_ASK = /\b(?:sono\s+(?:liber[oa]|impegnat[oa])|ho\s+(?:(?:degli|qualche|altri)\s+)?(?:impegni|appuntamenti)|ho\s+qualcosa(?:\s+(?:in\s+programma|da\s+fare))?|c\s*'?\s*e\s+qualcosa\s+in\s+(?:agenda|programma)|cosa\s+c\s*'?\s*e\s+in\s+(?:agenda|programma))\b/;
const CANCEL = new RegExp(LEAD + String.raw`(?:annulla|cancella|elimina|togli|rimuovi|ferma)\s+(?:il\s+|l\s*'\s*|lo\s+|la\s+|quel\s+|quello\s+)?(promemoria|appuntamento|sveglia|timer)\b`);
const STARTS_WITH_WHEN = /^\s*(?:tra|fra|oggi|domani|dopodomani|stasera|stamattina|stamani|domattina|stanotte|alle|all\s*'|a\s+mezzogiorno|a\s+mezzanotte|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|il\s+\d|questo|questa)\b/;
const DUTY = /\b(?:devo|dovro|ho|c\s*'\s*e|abbiamo|dobbiamo|avro)\b/;
const APPOINTMENT = /\b(?:appuntamento|visita|riunione|colloquio|dentista|medico|dottore|meeting|call|esame|udienza|lezione|parrucchiere)\b/;
/** Parole del lavoro sul codice: una frase che le contiene non diventa mai un promemoria implicito. */
const CODE = /\b(?:codice|bug|file|commit|test|compila|build|installa|repository|repo|funzione|script|deploy|branch|server)\b/;
const IMPERATIVE = /^\s*(?:fai|fammi|crea|scrivi|sistema|correggi|implementa|aggiungi|cerca|apri|controlla|verifica|prepara|manda|invia)\b/;

/** Il testo parla di un appuntamento (avviso un quarto d'ora prima)? */
export function isAppointment(text: string): boolean {
  return APPOINTMENT.test(fold(text));
}

/** Toglie connettivi e punteggiatura rimasti in testa e in coda; maiuscola iniziale. */
export function tidy(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/^(?:[,.:;!?-]+\s*|(?:che|di|per|e|ed|questo|questa\s+cosa)\s*:?\s+)/i, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/[\s,;:]+$/g, '').replace(/[.!?]+$/g, '').trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

/** Toglie «devo»/«ho» in testa a un promemoria implicito: «devo andare a fare la spesa» → «andare a fare la spesa». */
function dropDuty(s: string): string {
  return s.replace(/^\s*(?:che\s+)?(?:devo|dovro|dobbiamo|abbiamo)\s+/i, '').replace(/^\s*(?:ho|avro)\s+(?=(?:un|una|l'|il|la|lo)\b|appuntamento)/i, '');
}

/**
 * La frase è una richiesta per l'Assistente? `now` serve a capire il «quando». La lingua è quella di
 * VISIONE (P-108): l'ascolto trascrive in quella lingua, e le regole sono quelle della lingua.
 */
export function parseAssistantRequest(raw: string, now: number, lang: Language = 'it'): AssistantRequest | null {
  return lang === 'en' ? parseAssistantRequestEn(raw, now) : parseItalian(raw, now);
}

function parseItalian(raw: string, now: number): AssistantRequest | null {
  const text = fold(raw);
  if (text.trim().length === 0) return null;

  // Liste e timer hanno parole proprie: prima di «annulla/cancella» e dei promemoria.
  const list = parseList(raw, 'it');
  if (list) return { kind: 'list', ...list };
  const timer = parseTimer(raw, 'it');
  if (timer) return { kind: 'timer', ...timer };

  const cancel = CANCEL.exec(text);
  if (cancel) return { kind: 'cancel', query: tidy(raw.slice(cancel[0].length).replace(/^\s*(?:di|del|della|dello|per|che|su)\s+/i, '')), ...(cancel[1] === 'timer' ? { onlyTimers: true } : {}) };

  const question = /\?\s*$/.test(raw) || /^\s*(?:cosa|che)\b/.test(text) || /\bsono\s+liber[oa]\b/.test(text);
  if (AGENDA.test(text) || (AGENDA_ASK.test(text) && question && !REMIND_ANY.test(text))) {
    const day: AgendaDay = /\bdomani\b/.test(text) ? 'tomorrow' : /\boggi\b|\bstasera\b/.test(text) ? 'today' : 'upcoming';
    return { kind: 'agenda', day };
  }

  // Ricorrenti: «ricordami ogni giorno alle 8 di…», «ogni lunedì alle 9 ho la palestra».
  const rep = findRepeat(text, 'it');
  if (rep) {
    const blanked = blank(raw, rep.start, rep.end);
    const folded = fold(blanked);
    const asked = REMIND_ANY.exec(folded);
    if (asked || (DUTY.test(folded) && !CODE.test(folded) && !IMPERATIVE.test(folded))) {
      const body = asked ? blank(blanked, asked.index, asked.index + asked[0].length) : blanked;
      // L'ora di una ricorrenza è quella detta: letta da mezzanotte, «alle 8» detto alle 10 resta le 8.
      const when = parseWhen(body, new Date(now).setHours(0, 0, 0, 0));
      const said = tidy(dropDuty((when ? when.rest : body).replace(new RegExp(LEAD, 'i'), '')));
      const what = said || (asked?.[1]?.startsWith('svegliami') ? 'Sveglia' : '');
      const at = firstOccurrence(rep, when, now);
      return { kind: 'reminder', text: what, when: { at, exact: when?.exact ?? false, past: false, rest: what }, appointment: isAppointment(what), repeat: rep.repeat };
    }
  }

  const remind = REMIND.exec(text);
  if (remind) {
    const body = raw.slice(remind[0].length);
    const when = parseWhen(body, now);
    const what = tidy(when ? when.rest : body);
    const wake = remind[1]!.startsWith('svegliami');
    return { kind: 'reminder', text: what || (wake ? 'Sveglia' : ''), when, appointment: isAppointment(what) };
  }

  const note = NOTE.exec(text);
  if (note) {
    const body = raw.slice(note[0].length);
    // «ricordati che domani alle 15 ho il dentista» ha un quando: è un promemoria.
    const when = /ricordati|segnati|tieni/.test(note[1]!) ? parseWhen(body, now) : null;
    if (when) {
      const what = tidy(dropDuty(when.rest));
      return { kind: 'reminder', text: what, when, appointment: isAppointment(what) };
    }
    const what = tidy(body);
    return what.length > 0 ? { kind: 'note', text: what } : null;
  }

  // Forma naturale: «tra un'ora devo andare a fare la spesa», «domani alle 15 ho il dentista».
  if (CODE.test(text) || IMPERATIVE.test(text)) return null;
  const when = parseWhen(raw, now);
  if (!when) return null;
  const natural = (STARTS_WITH_WHEN.test(text) && DUTY.test(text)) || /\bho\s+(?:un\s+|l\s*'\s*)?appuntamento\b/.test(text);
  if (!natural) return null;
  const what = tidy(dropDuty(when.rest));
  if (what.length === 0) return null;
  return { kind: 'reminder', text: what, when, appointment: isAppointment(what) };
}
