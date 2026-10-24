// Addestramento (14/10/2026, P-107k): regole di lavoro scelte dall'utente, dal catalogo di VISIONE
// (`catalog.ts`) o scritte da lui. Una regola entra nel brief di un turno solo se il testo del compito
// contiene una sua parola chiave, oppure sempre se è segnata così; al massimo `TRAINING_LIMITS.perTurn`
// per turno, le più pertinenti. Tabella `skills` (migrazione 10): del catalogo si salvano solo lo stato e
// l'uso (il testo segue la lingua di VISIONE), delle regole dell'utente anche il testo. Nessuna rete.
import {
  customSkillInputSchema, TRAINING_LIMITS,
  type CustomSkillInput, type Language, type Skill
} from '../../shared/contracts/index.ts';
import { redactString } from '../../shared/lib/redact.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Db, Row } from '../db/index.ts';
import { CATALOG, type CatalogSkill } from './catalog.ts';

export interface Training {
  /** Catalogo e regole dell'utente, nella lingua di VISIONE. */
  list(): { skills: Skill[]; recent: number };
  set(id: string, active: boolean): Skill;
  add(input: CustomSkillInput): Skill;
  remove(id: string): boolean;
  /** Le regole da dare all'agente per questo compito (già contate come usate). */
  forTurn(text: string): string[];
}

export interface TrainingDeps {
  db: Db;
  now?: () => number;
  language?: () => Language;
  /** Testi degli obiettivi recenti dell'utente: per consigliare le regole che li avrebbero aiutati. */
  recentTexts?: () => string[];
}

/** Minuscole e senza accenti: «Perché» e «perche» sono la stessa parola. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Stima prudente dei token di un testo (circa 3,5 caratteri per token, più la riga dell'elenco). */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length + 2) / 3.5);
}

/**
 * Quante parole chiave compaiono nel testo (già piegato con `foldText`). Una parola chiave con uno
 * spazio è una frase; da 5 lettere in su vale come inizio di parola; più corta, come parola intera.
 */
export function keywordHits(keywords: readonly string[], folded: string, words: readonly string[]): number {
  let hits = 0;
  for (const raw of keywords) {
    const k = foldText(raw).trim();
    if (k.length < 2) continue;
    const found = k.includes(' ') ? folded.includes(k) : k.length >= 5 ? words.some((w) => w.startsWith(k)) : words.includes(k);
    if (found) hits += 1;
  }
  return hits;
}

export interface Candidate {
  readonly id: string;
  readonly keywords: readonly string[];
  readonly always: boolean;
}

/** Le regole per un testo: prima le più pertinenti (più parole chiave trovate), poi le «sempre». */
export function selectSkills<T extends Candidate>(text: string, active: readonly T[], max: number = TRAINING_LIMITS.perTurn): T[] {
  const folded = foldText(text);
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return active
    .map((s, order) => ({ s, order, hits: keywordHits(s.keywords, folded, words) }))
    .filter((x) => x.hits > 0 || x.s.always)
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .slice(0, max)
    .map((x) => x.s);
}

function uniqueKeywords(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const clean = k.trim().replace(/\s+/g, ' ');
    const key = foldText(clean);
    if (clean.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.slice(0, TRAINING_LIMITS.keywords);
}

function parseKeywords(raw: unknown): string[] {
  try {
    const v: unknown = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function createTraining(deps: TrainingDeps): Training {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const language = deps.language ?? (() => 'it' as const);
  const byCatalogId = new Map(CATALOG.map((c) => [c.id, c]));

  const q = {
    all: db.prepare('SELECT * FROM skills ORDER BY created_at, id'),
    byId: db.prepare('SELECT * FROM skills WHERE id = ?'),
    upsertCatalog: db.prepare(`INSERT INTO skills (id, origin, active, created_at, updated_at) VALUES (?, 'catalog', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at`),
    setActive: db.prepare('UPDATE skills SET active = ?, updated_at = ? WHERE id = ?'),
    insertCustom: db.prepare(`INSERT INTO skills (id, origin, title, rule, keywords, always, active, created_at, updated_at)
      VALUES (?, 'custom', ?, ?, ?, ?, 1, ?, ?)`),
    countCustom: db.prepare("SELECT COUNT(*) AS n FROM skills WHERE origin = 'custom'"),
    remove: db.prepare("DELETE FROM skills WHERE id = ? AND origin = 'custom'"),
    used: db.prepare('UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE id = ?')
  };

  const fromCatalog = (c: CatalogSkill, row: Row | undefined): Skill => {
    const texts = language() === 'en' ? c.en : c.it;
    return {
      id: c.id, origin: 'catalog', category: c.category, title: texts.title, explain: texts.explain, rule: texts.rule, topics: texts.topics,
      keywords: [...c.keywords], always: c.always === true, active: row ? Number(row.active) === 1 : false,
      tokens: estimateTokens(texts.rule), uses: row ? Number(row.uses) : 0,
      lastUsedAt: row && row.last_used_at !== null && row.last_used_at !== undefined ? Number(row.last_used_at) : null,
      suggested: 0
    };
  };
  const fromCustom = (row: Row): Skill => {
    const keywords = parseKeywords(row.keywords);
    return {
      id: String(row.id), origin: 'custom', category: 'custom', title: String(row.title), explain: '', rule: String(row.rule),
      topics: keywords.join(', ').slice(0, 400), keywords, always: Number(row.always) === 1, active: Number(row.active) === 1,
      tokens: estimateTokens(String(row.rule)), uses: Number(row.uses),
      lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
      suggested: 0
    };
  };

  const all = (): Skill[] => {
    const rows = q.all.all();
    const catalogRows = new Map(rows.filter((r) => r.origin === 'catalog').map((r) => [String(r.id), r]));
    return [
      ...CATALOG.map((c) => fromCatalog(c, catalogRows.get(c.id))),
      ...rows.filter((r) => r.origin === 'custom').map(fromCustom)
    ];
  };

  const one = (id: string): Skill => {
    const c = byCatalogId.get(id);
    if (c) return fromCatalog(c, q.byId.get(id));
    const row = q.byId.get(id);
    if (!row || row.origin !== 'custom') throw new CommandFailure('not_found', `regola sconosciuta: ${id}`);
    return fromCustom(row);
  };

  return {
    list() {
      const texts = deps.recentTexts?.() ?? [];
      // Una regola spenta che sarebbe entrata in molti obiettivi recenti è un consiglio da mostrare.
      const skills = all().map((s) => (s.active || s.always || s.keywords.length === 0
        ? s
        : { ...s, suggested: texts.filter((t) => selectSkills(t, [s], 1).length > 0).length }));
      return { skills, recent: texts.length };
    },
    set(id, active) {
      const t = now();
      if (byCatalogId.has(id)) q.upsertCatalog.run(id, active ? 1 : 0, t, t);
      else {
        one(id);
        q.setActive.run(active ? 1 : 0, t, id);
      }
      return one(id);
    },
    add(input) {
      const parsed = customSkillInputSchema.parse(input);
      const keywords = uniqueKeywords(parsed.keywords);
      if (keywords.length === 0 && !parsed.always) {
        throw new CommandFailure('invalid_payload', language() === 'en'
          ? 'Add at least one keyword, or choose «always».'
          : 'Serve almeno una parola chiave, oppure «sempre».');
      }
      if (Number(q.countCustom.get()?.n ?? 0) >= TRAINING_LIMITS.custom) {
        throw new CommandFailure('operation_failed', language() === 'en'
          ? `At most ${TRAINING_LIMITS.custom} rules of your own: remove one first.`
          : `Al massimo ${TRAINING_LIMITS.custom} regole tue: prima togline una.`);
      }
      const id = `u-${ulid()}`;
      const t = now();
      // Una chiave incollata per sbaglio nella regola non arriva agli agenti né nel database.
      q.insertCustom.run(id, redactString(parsed.title), redactString(parsed.rule), JSON.stringify(keywords.map(redactString)), parsed.always ? 1 : 0, t, t);
      return one(id);
    },
    remove(id) {
      if (byCatalogId.has(id)) throw new CommandFailure('invalid_payload', 'le regole del catalogo si tolgono, non si cancellano');
      return q.remove.run(id).changes > 0;
    },
    forTurn(text) {
      const chosen = selectSkills(text, all().filter((s) => s.active));
      const t = now();
      for (const s of chosen) q.used.run(t, s.id);
      return chosen.map((s) => `- ${s.rule}`);
    }
  };
}

export function registerTrainingCommands(router: CommandRouter, training: Training): void {
  router.register('training.list', () => ({ ...training.list(), perTurn: TRAINING_LIMITS.perTurn }));
  router.register('training.set', (payload) => ({ skill: training.set(payload.id, payload.active) }));
  router.register('training.add', (payload) => ({ skill: training.add(payload) }));
  router.register('training.remove', (payload) => ({ removed: training.remove(payload.id) }));
}
