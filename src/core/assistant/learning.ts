// Ciò che VISIONE impara dal proprietario (22/10/2026, sua richiesta: «impara dalle conversazioni» e «battute che
// autoapprendono»). Tutto locale, in visione.db: le sue frasi sono le richieste che ha già fatto (radici create da lui),
// i gusti sulle battute sono una tabella sua, visibile e cancellabile a voce o dal widget. Nessun modello qui.
import type { Language } from '../../shared/contracts/index.ts';
import type { Db } from '../db/index.ts';
import { fold } from './when.ts';

export type QuipVerdict = 'liked' | 'disliked';

export interface QuipTaste {
  readonly liked: readonly string[];
  readonly disliked: readonly string[];
}

/** Una cosa detta o chiesta dal proprietario, con quanto tempo fa («ieri», «3 giorni fa»). */
export interface OwnerSaying {
  readonly text: string;
  readonly ago: string;
}

export type LearningRequest =
  | { readonly kind: 'quip-feedback'; readonly verdict: QuipVerdict }
  | { readonly kind: 'quip-taste' }
  | { readonly kind: 'quip-forget' }
  | { readonly kind: 'projects' };

const LEAD = String.raw`^\s*(?:(?:ehi|ok|hey)\s+)?(?:visione\s+)?`;
const LIKED_IT = new RegExp(LEAD + String.raw`(?:bella|bellissima|carina|ottima|forte|bravo|brava|grande|questa\s+(?:mi\s+)?piace|mi\s+piace|questa\s+si)\b`);
const DISLIKED_IT = new RegExp(LEAD + String.raw`(?:questa\s+no|no\s+questa\s+no|non\s+mi\s+(?:e\s+)?piac(?:e|iuta)|brutta|pessima|non\s+fa\s+ridere|lascia\s+stare\s+le\s+battute)\b`);
const LIKED_EN = new RegExp(LEAD + String.raw`(?:nice|good\s+one|great|love\s+it|i\s+like\s+(?:it|that))\b`);
const DISLIKED_EN = new RegExp(LEAD + String.raw`(?:not\s+that\s+one|i\s+don\s*'?\s*t\s+like\s+(?:it|that)|bad\s+one|not\s+funny)\b`);
const TASTE_IT = /\b(?:quali|che)\s+battute\s+(?:mi\s+(?:sono\s+piaciute|piacciono)|ti\s+ho\s+(?:bocciato|scartato))\b|\b(?:i\s+miei\s+gusti|cosa\s+hai\s+imparato)\s+sulle\s+battute\b/;
const FORGET_IT = /\b(?:dimentica|cancella|azzera|elimina)\s+(?:le\s+|i\s+gusti\s+sulle\s+|quello\s+che\s+sai\s+sulle\s+)?battute\b/;
const TASTE_EN = /\bwhich\s+(?:jokes|quips)\s+(?:did\s+i|do\s+i)\s+(?:like|dislike)\b|\bwhat\s+did\s+you\s+learn\s+about\s+(?:my\s+)?(?:jokes|quips)\b/;
const FORGET_EN = /\b(?:forget|clear|delete)\s+(?:the\s+|my\s+)?(?:jokes|quips)\b/;
const PROJECTS_IT = new RegExp(LEAD + String.raw`(?:come\s+(?:vanno|procedono|stanno\s+andando)\s+(?:i\s+)?(?:progetti|lavori)|(?:aggiornami|dammi\s+(?:un\s+)?aggiornamento|novita)\s+(?:sui|dei)\s+(?:progetti|lavori)|a\s+che\s+punto\s+(?:siamo|sono\s+(?:i\s+)?(?:progetti|lavori))|(?:che\s+)?novita\s+(?:ci\s+sono\s+)?sui\s+progetti)\b`);
const PROJECTS_EN = new RegExp(LEAD + String.raw`(?:how\s+are\s+(?:the\s+|my\s+)?(?:projects|jobs)\s+going|(?:give\s+me\s+an?\s+)?update\s+on\s+(?:the\s+|my\s+)?(?:projects|jobs)|where\s+are\s+we\s+(?:at|with\s+the\s+projects))\b`);

/**
 * La frase è per ciò che VISIONE impara? Il giudizio su una battuta vale solo se è una frase breve (al più 5 parole)
 * e se una battuta è stata detta da poco: lo decide chi chiama, perché «bella» da sola non vuol dire niente.
 */
export function parseLearningRequest(text: string, lang: Language, quipRecent: boolean): LearningRequest | null {
  const f = fold(text).replace(/\s+/g, ' ').trim();
  if (f.length === 0) return null;
  const en = lang === 'en';
  if ((en ? FORGET_EN : FORGET_IT).test(f)) return { kind: 'quip-forget' };
  if ((en ? TASTE_EN : TASTE_IT).test(f)) return { kind: 'quip-taste' };
  if ((en ? PROJECTS_EN : PROJECTS_IT).test(f)) return { kind: 'projects' };
  if (quipRecent && f.split(' ').length <= 5) {
    if ((en ? DISLIKED_EN : DISLIKED_IT).test(f)) return { kind: 'quip-feedback', verdict: 'disliked' };
    if ((en ? LIKED_EN : LIKED_IT).test(f)) return { kind: 'quip-feedback', verdict: 'liked' };
  }
  return null;
}

const DAY = 24 * 3600 * 1000;

function agoWords(ms: number, lang: Language): string {
  const days = Math.floor(ms / DAY);
  if (lang === 'en') return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return days <= 0 ? 'oggi' : days === 1 ? 'ieri' : `${days} giorni fa`;
}

/** Gli ultimi giorni di calendario contano come tali: «ieri» è ieri anche se sono passate 10 ore. */
function calendarAgo(at: number, t: number): number {
  const a = new Date(at); const b = new Date(t);
  a.setHours(12, 0, 0, 0); b.setHours(12, 0, 0, 0);
  return b.getTime() - a.getTime();
}

// Le sue richieste a VISIONE (23/10/2026): non i messaggi a un singolo agente («:tell») e i gruppi, né i messaggi a un
// agente salvati fino alla beta.30 col titolo dato da VISIONE (stessa regola di isOwnerRequest nel Director).
const OWNER_ROOTS = "parent_id IS NULL AND (created_by LIKE 'owner%' OR created_by = 'voice') AND created_by NOT LIKE '%:tell' AND created_by <> 'owner:group'" +
  " AND title NOT IN ('Verifica della procedura guidata', 'Setup wizard check') AND title NOT LIKE 'Messaggio a %'";

export interface Learning {
  /** Le ultime cose chieste o dette dal proprietario (radici sue), dalla più recente, senza doppioni. */
  sayings(limit?: number): OwnerSaying[];
  /** Esempi graditi e sgraditi da dare al modello che scrive la battuta (i più recenti). */
  taste(limit?: number): QuipTaste;
  /** Segna il giudizio su una battuta. Una battuta già giudicata cambia giudizio, non si duplica. */
  judge(text: string, verdict: QuipVerdict): void;
  /** Dimentica tutti i gusti sulle battute; restituisce quanti ne ha cancellati. */
  forget(): number;
  /** «Come vanno i progetti?»: le sue richieste degli ultimi 7 giorni, per stato. */
  projects(): string;
}

export function createLearning(deps: { db: Db; now: () => number; newId: () => string; lang: () => Language }): Learning {
  const { db, now, newId, lang } = deps;
  const recentRoots = db.prepare(`SELECT title, created_at FROM tasks WHERE ${OWNER_ROOTS} AND created_at >= ? ORDER BY created_at DESC LIMIT 60`);
  const rootsByStatus = db.prepare(`SELECT title, status, ended_at FROM tasks WHERE ${OWNER_ROOTS} AND (status IN ('created', 'queued', 'running', 'waiting', 'blocked') OR ended_at >= ?) ORDER BY created_at DESC LIMIT 60`);
  const tasteOf = db.prepare('SELECT text FROM quip_feedback WHERE verdict = ? ORDER BY created_at DESC LIMIT ?');
  const upsert = db.prepare(`INSERT INTO quip_feedback (id, text, verdict, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(text) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`);
  const clear = db.prepare('DELETE FROM quip_feedback');

  const quote = (s: string): string => (lang() === 'en' ? `“${s}”` : `«${s}»`);
  const list = (items: readonly string[]): string => {
    const en = lang() === 'en';
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} ${en ? 'and' : 'e'} ${items[items.length - 1]}`;
  };

  return {
    sayings(limit = 6) {
      const t = now();
      const seen = new Set<string>();
      const out: OwnerSaying[] = [];
      for (const row of recentRoots.all(t - 7 * DAY)) {
        const text = String(row.title).replace(/\s+/g, ' ').trim().slice(0, 120);
        const key = fold(text).trim();
        // Le frasi d'una parola («stop», «sì») non dicono niente di lui.
        if (key.split(' ').length < 3 || seen.has(key)) continue;
        seen.add(key);
        out.push({ text, ago: agoWords(calendarAgo(Number(row.created_at), t), lang()) });
        if (out.length >= limit) break;
      }
      return out;
    },
    taste(limit = 5) {
      return {
        liked: tasteOf.all('liked', limit).map((r) => String(r.text)),
        disliked: tasteOf.all('disliked', limit).map((r) => String(r.text))
      };
    },
    judge(text, verdict) {
      const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (clean.length > 0) upsert.run(newId(), clean, verdict, now());
    },
    forget() {
      return Number(clear.run().changes);
    },
    projects() {
      const en = lang() === 'en';
      const rows = rootsByStatus.all(now() - 7 * DAY);
      const titles = (pick: (s: string) => boolean): string[] => {
        const seen = new Set<string>();
        return rows.filter((r) => pick(String(r.status))).map((r) => String(r.title).replace(/\s+/g, ' ').trim().slice(0, 80))
          .filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
      };
      const named = (items: string[]): string => {
        const shown = items.slice(0, 3).map(quote);
        return items.length > 3 ? `${shown.join(', ')} ${en ? `and ${items.length - 3} more` : `e altri ${items.length - 3}`}` : list(shown);
      };
      const open = titles((s) => ['created', 'queued', 'running', 'waiting', 'blocked'].includes(s));
      const done = titles((s) => s === 'succeeded');
      const failed = titles((s) => s === 'failed' || s === 'timed_out');
      if (open.length + done.length + failed.length === 0) {
        return en ? 'No requests from you in the last seven days: nothing to report.' : 'Negli ultimi sette giorni non mi hai chiesto niente: nessun progetto da aggiornare.';
      }
      const out: string[] = [];
      if (open.length > 0) out.push(en ? `In progress: ${named(open)}.` : `In corso: ${named(open)}.`);
      if (done.length > 0) out.push(en ? `Finished this week: ${named(done)}.` : `Conclusi in settimana: ${named(done)}.`);
      if (failed.length > 0) out.push(en ? `Not completed: ${named(failed)}.` : `Non riusciti: ${named(failed)}.`);
      return out.join(' ');
    }
  };
}
