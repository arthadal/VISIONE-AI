// Addestramento (P-107k): catalogo, regole dell'utente, scelta per pertinenza e sezione del brief.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../../src/core/db/index.ts';
import { createContextBuilder } from '../../src/core/memory/context.ts';
import type { MemoryStore } from '../../src/core/memory/store.ts';
import { CATALOG } from '../../src/core/training/catalog.ts';
import { createTraining, estimateTokens, foldText, selectSkills, type Training } from '../../src/core/training/index.ts';
import { COMMAND_DEFINITIONS, TRAINING_LIMITS, type Language } from '../../src/shared/contracts/index.ts';
import { tempHome } from '../helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(lang: Language = 'it'): { db: Db; training: Training; home: string; setLang: (l: Language) => void } {
  const { dir, cleanup } = tempHome('visione-training-');
  const db = openDb(join(dir, 'visione.db'));
  migrate(db);
  cleanups.push(() => {
    db.close();
    cleanup();
  });
  let language = lang;
  let t = 1_000;
  const training = createTraining({ db, now: () => (t += 1), language: () => language });
  return { db, training, home: dir, setLang: (l) => (language = l) };
}

describe('catalogo', () => {
  it('ogni regola ha id unico, testi nelle due lingue e un modo di entrare nel brief', () => {
    const ids = new Set<string>();
    for (const c of CATALOG) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      for (const texts of [c.it, c.en]) {
        expect(texts.title.length, c.id).toBeGreaterThan(3);
        expect(texts.title.length, c.id).toBeLessThanOrEqual(TRAINING_LIMITS.titleChars);
        expect(texts.explain.length, c.id).toBeGreaterThan(40);
        expect(texts.rule.length, c.id).toBeLessThanOrEqual(TRAINING_LIMITS.ruleChars);
      }
      expect(c.always === true || c.keywords.length > 0, c.id).toBe(true);
      expect(c.keywords.length, c.id).toBeLessThanOrEqual(TRAINING_LIMITS.keywords);
      // Una regola a richiesta dice in parole leggibili quando entra.
      for (const texts of [c.it, c.en]) expect(texts.topics.length > 0, c.id).toBe(c.always !== true);
    }
    // Una sola regola «sempre»: le altre costano token solo quando servono.
    expect(CATALOG.filter((c) => c.always).map((c) => c.id)).toEqual(['tokens-lean']);
  });

  it('VISIONE è un prodotto a sé: il catalogo non nomina altri sistemi', () => {
    const text = JSON.stringify(CATALOG).toLowerCase();
    for (const word of ['munder', 'ai-neurale', 'ai neurale', 'nvidia', 'opencode', 'claude']) expect(text, word).not.toContain(word);
  });
});

describe('scelta per pertinenza', () => {
  const skills = [
    { id: 'bug', keywords: ['bug', 'error', 'corregg'], always: false },
    { id: 'scrivi', keywords: ['scriv', 'email'], always: false },
    { id: 'sempre', keywords: [], always: true },
    { id: 'frase', keywords: ['non funziona'], always: false }
  ];

  it('inizio di parola da 5 lettere, parola intera sotto, frasi con lo spazio; accenti ignorati', () => {
    expect(selectSkills('Correggi gli ERRORI del login', skills).map((s) => s.id)).toEqual(['bug', 'sempre']);
    expect(selectSkills('Scrivimi una mail', skills).map((s) => s.id)).toEqual(['scrivi', 'sempre']);
    // «bug» è corta: vale solo come parola intera («bugia» non c'entra).
    expect(selectSkills('una bugia', skills).map((s) => s.id)).toEqual(['sempre']);
    expect(selectSkills('il programma NON funziona più', skills).map((s) => s.id)).toEqual(['frase', 'sempre']);
    expect(foldText('Perché È così')).toBe('perche e cosi');
  });

  it('prima le più pertinenti, al massimo quante ne entrano in un turno', () => {
    const chosen = selectSkills('correggi il bug e scrivi una email per dire che l\'errore non funziona più', skills, 2);
    expect(chosen.map((s) => s.id)).toEqual(['bug', 'scrivi']);
  });
});

describe('regole attivate e scritte dall\'utente', () => {
  it('la lista rispetta il contratto del comando, in entrambe le lingue', () => {
    const { training, setLang } = setup();
    const result = COMMAND_DEFINITIONS['training.list'].result;
    expect(result.safeParse({ ...training.list(), perTurn: TRAINING_LIMITS.perTurn }).success).toBe(true);
    setLang('en');
    expect(result.safeParse({ ...training.list(), perTurn: TRAINING_LIMITS.perTurn }).success).toBe(true);
  });

  it('il catalogo parte spento; attiva, togli e riattiva conservano l\'uso', () => {
    const { training } = setup();
    expect(training.list().skills.filter((s) => s.active)).toEqual([]);
    expect(training.list().skills).toHaveLength(CATALOG.length);
    const on = training.set('code-reproduce', true);
    expect(on).toMatchObject({ id: 'code-reproduce', origin: 'catalog', active: true, uses: 0, title: 'Riprodurre prima di correggere' });
    expect(on.tokens).toBe(estimateTokens(on.rule));
    expect(training.forTurn('Correggi il crash all\'avvio')).toEqual([`- ${on.rule}`]);
    expect(training.forTurn('Prepara il menù della settimana')).toEqual([]);
    expect(training.set('code-reproduce', false).uses).toBe(1);
    expect(training.forTurn('Correggi il crash all\'avvio')).toEqual([]);
    const again = training.set('code-reproduce', true);
    expect(again.uses).toBe(1);
    expect(again.lastUsedAt).not.toBeNull();
  });

  it('consigli: le regole spente che gli obiettivi recenti avrebbero fatto entrare', () => {
    const { db } = setup();
    const texts = ['Correggi il crash del login', 'Il bug del carrello', 'Errore all\'avvio, sistemalo', 'Scrivi una mail al cliente'];
    const training = createTraining({ db, recentTexts: () => texts });
    const byId = (id: string) => training.list().skills.find((s) => s.id === id)!;
    expect(training.list().recent).toBe(4);
    expect(byId('code-reproduce').suggested).toBe(3);
    expect(byId('writing-reader').suggested).toBe(1);
    // «Sempre» non è un consiglio di pertinenza; una regola già attiva nemmeno.
    expect(byId('tokens-lean').suggested).toBe(0);
    training.set('code-reproduce', true);
    expect(byId('code-reproduce').suggested).toBe(0);
  });

  it('i testi del catalogo seguono la lingua di VISIONE', () => {
    const { training, setLang } = setup();
    training.set('tokens-lean', true);
    setLang('en');
    expect(training.list().skills.find((s) => s.id === 'tokens-lean')?.title).toBe('Lean answers');
    expect(training.forTurn('anything')).toEqual(['- Answer with the result: no preamble, no restating the task, no closing recap unless asked.']);
  });

  it('una regola dell\'utente: parole chiave senza doppioni, chiavi oscurate, cancellabile', () => {
    const { training, db } = setup();
    const s = training.add({ title: 'Preventivi', rule: `Nei preventivi usa sempre l'IVA al 22%. token=sk-ant-${'q'.repeat(30)}`, keywords: ['preventiv', 'Preventiv', ' offerta '], always: false });
    expect(s).toMatchObject({ origin: 'custom', category: 'custom', active: true, keywords: ['preventiv', 'offerta'] });
    expect(s.rule).not.toContain('qqqqqqqqqq');
    expect(JSON.stringify(db.prepare('SELECT * FROM skills').all())).not.toContain('qqqqqqqqqq');
    expect(training.forTurn('Fammi il preventivo per il bagno')).toHaveLength(1);
    expect(training.forTurn('Prepara un\'offerta')).toHaveLength(1);
    expect(training.set(s.id, false).active).toBe(false);
    expect(training.forTurn('Fammi il preventivo')).toEqual([]);
    expect(training.remove(s.id)).toBe(true);
    expect(training.remove(s.id)).toBe(false);
    expect(training.list().skills.some((x) => x.id === s.id)).toBe(false);
  });

  it('senza parole chiave serve «sempre»; il catalogo non si cancella; id sconosciuti rifiutati', () => {
    const { training } = setup();
    expect(() => training.add({ title: 'Vuota', rule: 'Fai bene.', keywords: [], always: false })).toThrow(/parola chiave/);
    expect(training.add({ title: 'Firma', rule: 'Firma con «Matteo».', keywords: [], always: true }).always).toBe(true);
    expect(() => training.remove('tokens-lean')).toThrow(/catalogo/);
    expect(() => training.set('inesistente', true)).toThrow(/sconosciuta/);
  });

  it('al massimo TRAINING_LIMITS.perTurn regole in un turno', () => {
    const { training } = setup();
    for (const c of CATALOG) training.set(c.id, true);
    const lines = training.forTurn('Correggi il bug nel codice del progetto, modifica i file, cerca online le fonti e scrivi una email');
    expect(lines).toHaveLength(TRAINING_LIMITS.perTurn);
  });
});

describe('brief del turno', () => {
  it('le regole pertinenti entrano in una sezione propria, con il loro peso nell\'evento', () => {
    const { training, home } = setup();
    training.set('code-reproduce', true);
    training.set('writing-reader', true);
    const emitted: { type: string; payload: Record<string, unknown> }[] = [];
    const store = { pinned: () => [], search: () => [] } as unknown as MemoryStore;
    const builder = createContextBuilder({
      store,
      refresh: () => undefined,
      tasks: { get: () => null, children: () => [], list: () => [] },
      journal: { read: () => [] },
      events: { emit: (type: string, payload: Record<string, unknown>) => emitted.push({ type, payload }) } as never,
      config: { briefMaxChars: 12_000, searchLimit: 0 },
      afterTurn: () => undefined,
      onError: (_id, err) => { throw err; },
      skills: training
    });
    const build = (title: string) => builder.build({
      def: { id: 'a1' }, req: { taskId: 't1', title, spec: title, attempt: 1, correlationId: 'c1' }, turnId: `turn-${emitted.length}`,
      agentDir: join(home, 'a1'), previous: []
    } as never);
    const brief = build('Correggi il crash all\'avvio');
    expect(brief.text).toContain('## Regole di lavoro scelte dall\'utente');
    expect(brief.text).toContain('Prima di correggere un errore riproducilo');
    expect(brief.text).not.toContain('Nei testi metti');
    expect(readFileSync(brief.ref, 'utf8')).toBe(brief.text);
    expect((emitted[0]?.payload.sections as Record<string, number>).skills).toBeGreaterThan(0);
    const plain = build('Che ore sono a Tokyo?');
    expect(plain.text).not.toContain('Regole di lavoro');
    expect((emitted[1]?.payload.sections as Record<string, number>).skills).toBe(0);
  });
});
