// Assistente personale in inglese (P-108, 12/10/2026): le stesse richieste di `intent.ts`, dette in
// inglese. Solo forme esplicite («remind me…», «take a note…», «what do I have today», «cancel the
// reminder…») e la forma naturale «in an hour I have to…» / «tomorrow at 3 I have the dentist».
// Tutto il resto (in particolare il lavoro sul codice) resta un obiettivo per il Director.
import { blank, findRepeat, firstOccurrence, parseList, parseTimer } from './extra.ts';
import { fold } from './when.ts';
import { parseWhenEn } from './when-en.ts';
import type { AgendaDay, AssistantRequest } from './intent.ts';

const LEAD = String.raw`^\s*(?:(?:hey|ok|okay)\s+)?(?:visione\s*)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?`;
const REMIND_WORDS = String.raw`(remind\s+me|(?:set|add|create|make|put)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:reminder|alarm)|reminder|wake\s+me(?:\s+up)?|alert\s+me|don\s*'?\s*t\s+let\s+me\s+forget)\b`;
const REMIND = new RegExp(LEAD + REMIND_WORDS);
const REMIND_ANY = new RegExp(String.raw`\b` + REMIND_WORDS);
const NOTE = new RegExp(LEAD + String.raw`((?:take|make)\s+(?:a\s+)?note(?:\s+that)?|note\s+(?:that|down)|write\s+(?:this\s+)?down|jot\s+(?:this\s+)?down|save\s+(?:a\s+note|this|that|(?:it\s+)?(?:in|to)\s+(?:my\s+)?notes)|remember\s+that|keep\s+in\s+mind(?:\s+that)?)\b`);
const AGENDA = new RegExp(LEAD + String.raw`(?:what\s+(?:do\s+i\s+have|have\s+i\s+got)|what(?:\s*'\s*s|\s+is)\s+on\s+my\s+(?:agenda|schedule|calendar|list)|what(?:\s+are|\s*'\s*re)\s+my\s+(?:reminders|appointments|plans)|(?:read|tell|list|show|give)\s+(?:me\s+)?(?:my|the)\s+(?:reminders|appointments|agenda|schedule)|my\s+(?:reminders|appointments|agenda|schedule)\b|do\s+i\s+have\s+(?:anything|any\s+(?:appointments|reminders|plans)))`);
const CANCEL = new RegExp(LEAD + String.raw`(?:cancel|delete|remove|clear|drop|stop)\s+(?:the\s+|my\s+|that\s+|this\s+)?(reminder|appointment|alarm|timer)\b`);
const STARTS_WITH_WHEN = /^\s*(?:in|within|today|tomorrow|tonight|this|at|on|next|the\s+day\s+after|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const DUTY = /\b(?:i\s+(?:have|need|must|should|ve\s+got|'\s*ve\s+got|got)|we\s+(?:have|need|must)|there\s*(?:'\s*s|\s+is))\b/;
const APPOINTMENT = /\b(?:appointment|meeting|visit|interview|dentist|doctor|exam|hearing|lesson|class|hairdresser|haircut|check\s*up|conference\s+call)\b/;
// Niente «call» da solo: «remind me to call Luca» è una telefonata da fare, non un appuntamento con preavviso.
/** Parole del lavoro sul codice: una frase che le contiene non diventa mai un promemoria implicito. */
const CODE = /\b(?:code|bug|file|commit|test|tests|compile|build|install|repository|repo|function|script|deploy|branch|server)\b/;
const IMPERATIVE = /^\s*(?:make|create|write|fix|implement|add|search|find|open|check|verify|prepare|send|build|run|refactor|update)\b/;

/** Il testo parla di un appuntamento (avviso un quarto d'ora prima)? */
export function isAppointmentEn(text: string): boolean {
  return APPOINTMENT.test(fold(text));
}

/** Toglie connettivi e punteggiatura rimasti in testa e in coda; maiuscola iniziale. */
export function tidyEn(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/^(?:[,.:;!?-]+\s*|(?:to|that|about|of|for|and|this|so)\s*:?\s+)/i, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/[\s,;:]+$/g, '').replace(/[.!?]+$/g, '').trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

/** «I have to go shopping» → «go shopping»; «I have the dentist» → «the dentist». */
function dropDuty(s: string): string {
  return s
    .replace(/^\s*(?:that\s+)?(?:i\s+(?:have|need|must|should)\s+to|i\s+must|i\s*'?\s*ve\s+got\s+to|i\s+have\s+got\s+to|i\s+got\s+to|we\s+(?:have|need)\s+to)\s+/i, '')
    .replace(/^\s*(?:i\s+have|i\s*'?\s*ve\s+got|i\s+got|there\s*(?:'\s*s|\s+is))\s+(?=(?:a|an|the|my)\b)/i, '');
}

export function parseAssistantRequestEn(raw: string, now: number): AssistantRequest | null {
  const text = fold(raw);
  if (text.trim().length === 0) return null;

  // Liste e timer (P-109b) hanno parole proprie: prima di «cancel» e dell'agenda («what's on my list»).
  const list = parseList(raw, 'en');
  if (list) return { kind: 'list', ...list };
  const timer = parseTimer(raw, 'en');
  if (timer) return { kind: 'timer', ...timer };

  const cancel = CANCEL.exec(text);
  if (cancel) return { kind: 'cancel', query: tidyEn(raw.slice(cancel[0].length).replace(/^\s*(?:about|for|to|of|called|that|on)\s+/i, '')), ...(cancel[1] === 'timer' ? { onlyTimers: true } : {}) };

  if (AGENDA.test(text)) {
    const day: AgendaDay = /\btomorrow\b/.test(text) ? 'tomorrow' : /\btoday\b|\btonight\b/.test(text) ? 'today' : 'upcoming';
    return { kind: 'agenda', day };
  }

  // Ricorrenti: «remind me every day at 8 to…», «every Monday at 9 I have the gym».
  const rep = findRepeat(text, 'en');
  if (rep) {
    const blanked = blank(raw, rep.start, rep.end);
    const folded = fold(blanked);
    const asked = REMIND_ANY.exec(folded);
    if (asked || (DUTY.test(folded) && !CODE.test(folded) && !IMPERATIVE.test(folded))) {
      const body = asked ? blank(blanked, asked.index, asked.index + asked[0].length) : blanked;
      // L'ora di una ricorrenza è quella detta: letta da mezzanotte, «at 8» detto alle 10 resta le 8.
      const when = parseWhenEn(body, new Date(now).setHours(0, 0, 0, 0));
      const said = tidyEn(dropDuty((when ? when.rest : body).replace(new RegExp(LEAD, 'i'), '')));
      const what = said || (asked?.[1]?.startsWith('wake') ? 'Wake up' : '');
      const at = firstOccurrence(rep, when, now);
      return { kind: 'reminder', text: what, when: { at, exact: when?.exact ?? false, past: false, rest: what }, appointment: isAppointmentEn(what), repeat: rep.repeat };
    }
  }

  const remind = REMIND.exec(text);
  if (remind) {
    const body = raw.slice(remind[0].length);
    const when = parseWhenEn(body, now);
    const what = tidyEn(when ? when.rest : body);
    const wake = remind[1]!.startsWith('wake');
    return { kind: 'reminder', text: what || (wake ? 'Wake up' : ''), when, appointment: isAppointmentEn(what) };
  }

  const note = NOTE.exec(text);
  if (note) {
    const body = raw.slice(note[0].length);
    // «remember that tomorrow at 3 I have the dentist» ha un quando: è un promemoria.
    const when = /remember|keep/.test(note[1]!) ? parseWhenEn(body, now) : null;
    if (when) {
      const what = tidyEn(dropDuty(when.rest));
      return { kind: 'reminder', text: what, when, appointment: isAppointmentEn(what) };
    }
    const what = tidyEn(body);
    return what.length > 0 ? { kind: 'note', text: what } : null;
  }

  if (CODE.test(text) || IMPERATIVE.test(text)) return null;
  const when = parseWhenEn(raw, now);
  if (!when) return null;
  const natural = (STARTS_WITH_WHEN.test(text) && DUTY.test(text)) || /\bi\s+(?:have|ve\s+got|'\s*ve\s+got)\s+(?:an?\s+)?(?:appointment|meeting)\b/.test(text);
  if (!natural) return null;
  const what = tidyEn(dropDuty(when.rest));
  if (what.length === 0) return null;
  return { kind: 'reminder', text: what, when, appointment: isAppointmentEn(what) };
}
