// Il motivo di un insuccesso detto come lo direbbe una persona (24/10/2026, il proprietario davanti al gruppo di lavoro:
// «dicono cose senza senso, non è italiano o linguaggio umano»: c'era «tentativo oltre 900000 ms»). La frase nasce dal
// codice dell'errore; il messaggio tecnico si aggiunge solo se è già leggibile (niente numeri lunghi, percorsi, codici).
import type { Language, TaskError } from '../contracts/index.ts';

const BASE: Record<TaskError['code'], { it: string; en: string; detail: boolean }> = {
  timeout: { it: 'ci voleva troppo tempo e il lavoro si è fermato', en: 'it was taking too long and the job stopped', detail: false },
  dependency_failed: { it: 'non è riuscita una parte del lavoro da cui dipendevo', en: 'a part of the job I depended on failed', detail: false },
  no_agent: { it: 'non c\'era un agente libero adatto', en: 'no suitable agent was free', detail: false },
  policy_blocked: { it: 'serviva un\'azione che le regole di sicurezza non permettono', en: 'it needed an action the safety rules don\'t allow', detail: false },
  approval_denied: { it: 'il permesso è stato negato', en: 'the permission was denied', detail: false },
  agent_unavailable: { it: 'il motore non è partito', en: 'the engine did not start', detail: true },
  turn_failed: { it: 'il motore ha dato un errore', en: 'the engine returned an error', detail: true },
  cancelled: { it: 'il lavoro è stato annullato', en: 'the job was cancelled', detail: false },
  lost: { it: 'VISIONE si è chiusa mentre si lavorava', en: 'VISIONE closed while the job was running', detail: false },
  invalid_plan: { it: 'il piano non era valido', en: 'the plan was not valid', detail: false },
  internal: { it: 'c\'è stato un errore interno di VISIONE', en: 'there was an internal VISIONE error', detail: false }
};

/** Un dettaglio che una persona capisce: corto, senza numeri lunghi, percorsi, codici o tracce. */
function readable(message: string): string | null {
  const m = message.replace(/\s+/g, ' ').trim();
  if (m.length === 0 || m.length > 120) return null;
  if (/\d{4,}|[\\/]|[A-Z_]{5,}|\bat \w|[{}<>=]|https?:/.test(m)) return null;
  return m;
}

export function humanReason(error: Pick<TaskError, 'code' | 'message'> | null | undefined, lang: Language): string {
  if (!error) return lang === 'en' ? 'something went wrong' : 'qualcosa è andato storto';
  const base = BASE[error.code] ?? BASE.internal;
  const detail = base.detail ? readable(error.message) : null;
  return `${base[lang]}${detail ? ` (${detail})` : ''}`;
}
