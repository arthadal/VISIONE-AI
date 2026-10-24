// Memoria (Fase 7): formato di memory.md, righe MEMORIA:, query FTS5 sicure, archivio (deduplica,
// redazione, ambiti, fissati, promozione, allineamento con il file), riflessione pura.
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  extractFacts,
  ftsQuery,
  parseMemory,
  planReflection,
  verifyReflection,
  type MemoryStore
} from '../../src/core/memory/index.ts';
import { createRuntimeHarness, type RuntimeHarness } from '../runtime-harness.ts';

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});
function setup(): { h: RuntimeHarness; store: MemoryStore } {
  const h = createRuntimeHarness();
  harnesses.push(h);
  return { h, store: createMemoryStore({ db: h.db, events: h.emitter }) };
}
const FAKE_KEY = `nvapi-${'x'.repeat(24)}`; // forma di segreto, valore inventato

describe('memory.md: formato', () => {
  it('titolo del file, paragrafi, sezioni con tipo, fissato e task; blocchi di codice non spezzano', () => {
    const p = parseMemory([
      '# Memoria di alfa', '', 'Nota libera iniziale.', '', 'Secondo paragrafo.', '',
      '## [decisione] [fisso] Porta del server', 'La porta è 4321.', '',
      '## 📌 Preferenza del proprietario', 'Risposte brevi.', '',
      '## [task:01JTASK0000000000000000001] Avanzamento', 'Fatto metà.', '',
      '## [ignota] Titolo con etichetta', '```', '## non è una sezione', '```'
    ].join('\n'));
    expect(p.header).toBe('# Memoria di alfa');
    expect(p.sections.map((s) => [s.title, s.kind, s.pinned, s.taskId])).toEqual([
      ['', 'note', false, null],
      ['', 'note', false, null],
      ['Porta del server', 'decision', true, null],
      ['Preferenza del proprietario', 'note', true, null],
      ['Avanzamento', 'note', false, '01JTASK0000000000000000001'],
      ['[ignota] Titolo con etichetta', 'note', false, null]
    ]);
    expect(p.sections[5]?.body).toContain('## non è una sezione');
  });

  it('righe MEMORIA: del risultato (fissate, duplicate, segnaposto, limite)', () => {
    const text = ['Risultato.', 'MEMORIA: la porta è 4321', '- MEMORIA [fisso]: mai toccare main', 'memoria: la porta è 4321', 'MEMORIA: <fatto>', 'testo MEMORIA: non a inizio riga'].join('\n');
    expect(extractFacts(text)).toEqual([{ content: 'la porta è 4321', pinned: false }, { content: 'mai toccare main', pinned: true }]);
    expect(extractFacts(Array.from({ length: 15 }, (_, i) => `MEMORIA: fatto ${i}`).join('\n'))).toHaveLength(10);
  });

  it('query FTS5 dal testo libero: solo parole tra virgolette, operatori neutralizzati', () => {
    expect(ftsQuery('Configura il "server" OR NEAR(porta*) -- per la prova')).toBe('"configura" OR "server" OR "near" OR "porta" OR "prova"');
    expect(ftsQuery('a è di')).toBeNull();
  });
});

describe('archivio della memoria', () => {
  it('scrittura: deduplicata per ambito, redatta prima di toccare database ed eventi', async () => {
    const { h, store } = setup();
    const a = store.write({ scope: 'global', scopeId: null, kind: 'fact', title: 'Chiave', content: `NVIDIA_API_KEY=${FAKE_KEY} usata da ${FAKE_KEY}`, source: 'owner:ui', origin: 'command' });
    expect(a.created).toBe(true);
    expect(a.item.content).not.toContain('xxxx');
    expect(a.item.content).toContain('[REDACTED]');
    const again = store.write({ scope: 'global', scopeId: null, kind: 'fact', title: 'Chiave', content: `NVIDIA_API_KEY=${FAKE_KEY} usata da ${FAKE_KEY}`, source: 'owner:ui', origin: 'command', pinned: true });
    expect(again).toMatchObject({ created: false, item: { id: a.item.id, pinned: true } });
    // Stesso testo in un altro ambito: elemento distinto.
    expect(store.write({ scope: 'agent', scopeId: 'alfa', kind: 'fact', title: 'Chiave', content: 'x', source: 'owner:ui', origin: 'command' }).created).toBe(true);
    await h.bus.idle();
    expect(JSON.stringify(h.db.prepare('SELECT * FROM memory_items').all())).not.toContain(FAKE_KEY);
    expect(JSON.stringify(h.events)).not.toContain(FAKE_KEY);
    expect(h.events.find((e) => e.type === 'memory.item.written')?.payload).toMatchObject({ redacted: true, origin: 'command' });
  });

  it('ricerca FTS5: accenti ignorati, ambiti filtrati, inattivi esclusi, testo vuoto = recenti', () => {
    const { store } = setup();
    const w = (scope: 'global' | 'agent' | 'task', scopeId: string | null, content: string) =>
      store.write({ scope, scopeId, kind: 'fact', title: '', content, source: 's', origin: 'command' }).item;
    w('global', null, 'La città del progetto è Torino');
    w('agent', 'alfa', 'Alfa preferisce la città di Torino');
    w('agent', 'beta', 'Beta conosce la città di Torino');
    w('task', 'T1', 'Nel task la città è Torino');
    w('task', 'T9', 'Altro obiettivo: città Torino');
    const scopes = { global: true, agentId: 'alfa', taskIds: ['T1'] };
    const found = store.search('citta torino', { scopes, limit: 10 }).map((m) => m.content).sort();
    expect(found).toEqual(['Alfa preferisce la città di Torino', 'La città del progetto è Torino', 'Nel task la città è Torino']);
    expect(store.search('citta', { scopes: null, limit: 10 })).toHaveLength(5);
    expect(store.search('', { scopes: { global: false, agentId: 'beta', taskIds: [] }, limit: 10 }).map((m) => m.scopeId)).toEqual(['beta']);
    expect(store.search('inesistente', { scopes: null, limit: 10 })).toEqual([]);
  });

  it('fissati per ambito; promozione a globale idempotente', async () => {
    const { h, store } = setup();
    const own = store.write({ scope: 'agent', scopeId: 'alfa', kind: 'decision', title: 'Regola', content: 'mai su main', source: 'agent:alfa', origin: 'file', pinned: true }).item;
    store.write({ scope: 'agent', scopeId: 'beta', kind: 'decision', title: 'Regola beta', content: 'altro', source: 'agent:beta', origin: 'file', pinned: true });
    expect(store.pinned({ global: true, agentId: 'alfa', taskIds: [] }, 10).map((m) => m.id)).toEqual([own.id]);
    const p1 = store.promote(own.id, 'owner:ui');
    expect(p1).toMatchObject({ created: true, item: { scope: 'global', scopeId: null, origin: 'promotion', pinned: true, content: 'mai su main' } });
    expect(store.promote(own.id, 'owner:ui')).toMatchObject({ created: false, item: { id: p1?.item.id } });
    expect(store.promote('inesistente', 'owner:ui')).toBeNull();
    expect(store.pinned({ global: true, agentId: 'beta', taskIds: [] }, 10).map((m) => m.content).sort()).toEqual(['altro', 'mai su main']);
    await h.bus.idle();
    expect(h.events.filter((e) => e.type === 'memory.item.promoted')).toHaveLength(1);
  });

  it('allineamento con memory.md: nuove sezioni, invariate, ritirate, ripristinate, sostituite', async () => {
    const { h, store } = setup();
    const e = (title: string, content: string, pinned = false) => ({ scope: 'agent' as const, scopeId: 'alfa', kind: 'note' as const, title, content, pinned });
    const r1 = store.syncFile('alfa', [e('A', 'uno'), e('B', 'due'), e('A', 'uno')], {});
    expect(r1).toMatchObject({ added: 2, unchanged: 1, retired: 0 });
    const r2 = store.syncFile('alfa', [e('A', 'uno', true)], {});
    expect(r2).toMatchObject({ added: 0, unchanged: 1, retired: 1 });
    expect(store.get(r1.ids[0] as string)?.pinned).toBe(true);
    expect(store.search('due', { scopes: null, limit: 5 })).toEqual([]);
    expect(store.search('due', { scopes: null, limit: 5, includeInactive: true })).toHaveLength(1);
    const r3 = store.syncFile('alfa', [e('A', 'uno', true), e('B', 'due')], {});
    expect(r3).toMatchObject({ restored: 1, added: 0 });
    expect(r3.ids[1]).toBe(r1.ids[1]);
    const r4 = store.syncFile('alfa', [e('A', 'uno', true), e('Riassunto', 'B: due')], { supersedeWith: 1, reason: 'riflessione' });
    expect(r4).toMatchObject({ added: 1, superseded: 1 });
    expect(store.get(r1.ids[1] as string)?.supersededBy).toBe(r4.ids[1]);
    await h.bus.idle();
    expect(h.events.filter((x) => x.type === 'memory.index.updated')).toHaveLength(4);
    // Nessun cambiamento: nessun evento.
    store.syncFile('alfa', [e('A', 'uno', true), e('Riassunto', 'B: due')], {});
    await h.bus.idle();
    expect(h.events.filter((x) => x.type === 'memory.index.updated')).toHaveLength(4);
  });
});

describe('riflessione (pura)', () => {
  const file = (n: number): string => [
    '# Memoria', '',
    'Paragrafo libero recente.', '',
    '## [fisso] Regola d\'oro', 'Mai cancellare i backup.', '',
    '## [riassunto] Riflessione del 2026-09-01', '- vecchio: riassunto precedente.', '',
    ...Array.from({ length: n }, (_, i) => [`## Sezione ${i}`, `Contenuto della sezione ${i}. ${'dettaglio '.repeat(20)}`, '']).flat(),
    '## [task:T1] [fisso] Vincolo del task', 'Solo lettura.'
  ].join('\n');

  it('fatti fissati intatti, riassunto ricorsivo (anche dei paragrafi), ultime K sezioni', () => {
    const before = file(10);
    const plan = planReflection(before, { keepRecent: 3, summaryMaxChars: 2_000, date: '2026-10-02' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan).toMatchObject({ pinned: 2, summarized: 9, kept: 3 });
    const after = parseMemory(plan.content);
    expect(after.header).toBe('# Memoria');
    expect(after.sections.map((s) => s.title)).toEqual([
      'Regola d\'oro', 'Vincolo del task', 'Riflessione del 2026-10-02', 'Sezione 7', 'Sezione 8', 'Sezione 9'
    ]);
    expect(plan.summaryIndex).toBe(2);
    const summary = after.sections[2]?.body ?? '';
    expect(summary).toContain('- Paragrafo libero recente.');
    expect(summary).toContain('- vecchio: riassunto precedente.'); // ricorsivo
    expect(summary).toContain('- Sezione 0: Contenuto della sezione 0.');
    expect(verifyReflection(before, plan.content)).toEqual({ ok: true });
  });

  it('verifica: un fatto fissato perso o un file non ridotto bloccano la sostituzione', () => {
    const before = file(10);
    const plan = planReflection(before, { keepRecent: 3, summaryMaxChars: 2_000, date: '2026-10-02' });
    if (!plan.ok) throw new Error(plan.reason);
    const tampered = plan.content.replace('Mai cancellare i backup.', 'Cancella pure.');
    expect(verifyReflection(before, tampered)).toMatchObject({ ok: false, reason: expect.stringContaining('fatto fissato perso') });
    const unpinned = plan.content.replace('## [task:T1] [fisso] Vincolo', '## [task:T1] Vincolo');
    expect(verifyReflection(before, unpinned).ok).toBe(false);
    expect(verifyReflection(before, `${before}\n`)).toMatchObject({ ok: false, reason: expect.stringContaining('non riduce') });
    expect(planReflection(file(2), { keepRecent: 8, summaryMaxChars: 2_000, date: 'x' })).toMatchObject({ ok: false });
    // Riassunto entro il tetto: restano le righe più recenti.
    const small = planReflection(file(30), { keepRecent: 2, summaryMaxChars: 300, date: 'x' });
    if (!small.ok) throw new Error(small.reason);
    const s = parseMemory(small.content).sections.find((x) => x.reflection)?.body ?? '';
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain('Sezione 27');
    expect(s).not.toContain('Sezione 0:');
  });
});
