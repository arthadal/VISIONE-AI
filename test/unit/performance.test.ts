// Fase 17 — Misure di performance e limiti (nessuna soglia temporale: i numeri sono registrati, le
// asserzioni verificano solo le proprietà di stabilità). Gira con gli altri test unitari.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/core/bus/index.ts';
import { openDatabase } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { initialState, reduceState } from '../../src/core/state/index.ts';
import { MAX_EFFECTS, MAX_ENDED_TASKS, createGraph, layout, project } from '../../src/renderer/neural/graph.ts';
import { MAX_EVENTS, initialState as emptyView, reduce } from '../../src/renderer/state/projection.ts';
import { serializePayload, type VisioneEvent } from '../../src/shared/contracts/index.ts';
import { tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function time(label: string, n: number, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`[perf] ${label}: ${ms.toFixed(1)} ms per ${n} (${Math.round(n / (ms / 1000)).toLocaleString('it-IT')}/s)`);
  return ms;
}

let uid = 0;
/** Evento sintetico valido (envelope completo); il payload non viene validato da bus/journal/proiezione. */
function synth(over: Partial<VisioneEvent> = {}): VisioneEvent {
  const n = ++uid;
  return {
    id: `perf-${String(n).padStart(9, '0')}`,
    seq: n,
    ts: 1_700_000_000_000 + n,
    type: 'task.status.changed',
    category: 'task',
    source: { kind: 'visione', id: 'core' },
    target: null,
    correlationId: 'corr',
    causationId: null,
    severity: 'info',
    durability: 'durable',
    schema: 1,
    payload: { taskId: 't', rootId: 'r', kind: 'work', from: 'running', to: 'succeeded', reason: 'motivo', attempt: 1, error: null },
    ...over
  };
}

describe('Fase 17 — misure e limiti', () => {
  it('event bus: consegna ogni evento, code limitate, sottoscrittori rilasciati', async () => {
    const N = 20_000;
    const bus = createEventBus({ maxSubscribers: 10_000 });
    let delivered = 0;
    const sub = bus.subscribe(() => { delivered++; }, { name: 'perf', maxQueue: N });
    const events = Array.from({ length: N }, () => synth());
    time('bus publish', N, () => {
      for (const e of events) bus.publish(e);
    });
    await bus.idle();
    expect(delivered).toBe(N);
    expect(bus.stats()).toMatchObject({ subscribers: 1, published: N, delivered: N, dropped: 0 });
    sub.unsubscribe();
    expect(bus.stats().subscribers).toBe(0);
    bus.close();
  }, 30_000);

  it('journal durevole: un evento per scrittura, seq monotono, letture ripetute senza crescita', () => {
    const h = tempHome('visione-perf-');
    cleanups.push(h.cleanup);
    const { db } = openDatabase(join(h.dir, 'perf.db'));
    const journal = createJournal(db);
    const bus = createEventBus();
    const emitter = createEventEmitter({ db, journal, bus });
    const N = 3_000;
    const texts = Array.from({ length: N }, (_, i) => `riga ${i} `.repeat(120));
    time('emitter.emit durevole (~800 B)', N, () => {
      for (const text of texts) emitter.emit('agent.message.text', { agentId: 'a', turnId: 't', text, chars: text.length, final: true });
    });
    expect(journal.count()).toBe(N);
    const page = journal.read({ limit: N });
    expect(page.length).toBe(N);
    expect(page[0]?.seq).toBe(1);
    expect(page.at(-1)?.seq).toBe(N);
    // Letture ripetute con lo stesso filtro (percorso UI/Neural).
    time('journal.read filtro (500 righe × 200)', 200, () => {
      for (let i = 0; i < 200; i++) expect(journal.read({ limit: 500, types: ['agent.message.text'] }).length).toBe(500);
    });
    emitter.close();
    bus.close();
    db.close();
  }, 60_000);

  it('proiezione della UI: eventi limitati a MAX_EVENTS, nessun duplicato', () => {
    const N = 20_000;
    let state = emptyView;
    time('projection.reduce', N, () => {
      for (let i = 0; i < N; i++) state = reduce(state, { type: 'event', event: synth() });
    });
    expect(state.events.length).toBe(MAX_EVENTS);
    const ids = new Set(state.events.map((e) => e.id));
    expect(ids.size).toBe(MAX_EVENTS);
    // Gli eventi sono in ordine: l'ultimo seq registrato coincide con l'ultimo della finestra.
    expect(state.lastSeq).toBe(state.events.at(-1)?.seq);
    expect(state.lastSeq).toBeGreaterThanOrEqual(N);
  }, 30_000);

  it('state store: applica gli eventi, operazioni attive limitate', () => {
    const h = tempHome('visione-perf-');
    cleanups.push(h.cleanup);
    const { db } = openDatabase(join(h.dir, 'state.db'));
    const boot = {
      bootId: 'b', pid: 1, startedAt: 1, appVersion: '0', coreVersion: '0', dbSchema: 6,
      quarantined: null, recovered: { previousRun: null, applicationRunning: false, lastEvent: null, lastError: null, journalLastSeq: 0, journalCount: 0 }
    };
    expect(initialState(boot, 1).schema).toBeGreaterThan(0);
    const N = 20_000;
    let state = initialState(boot, 1);
    time('reduceState', N, () => {
      for (let i = 0; i < N; i++) state = reduceState(state, { kind: 'event', event: synth() }, 1_700_000_000_000 + i).state;
    });
    expect(state.events.sinceStart).toBe(N);
    expect(state.tasks.byStatus.succeeded).toBe(N);
    expect(state.tasks.active).toBe(0);
    db.close();
  }, 30_000);

  it('Neural: nodi terminati limitati; il grafo non cresce con il numero di eventi', () => {
    const N = 5_000;
    const g = createGraph();
    const created = Array.from({ length: N }, (_, i) =>
      synth({ seq: i + 1, type: 'task.created', category: 'task', payload: { taskId: `t${i}`, kind: 'work', parentId: null, rootId: 'r', title: `task ${i}`, assigneeAgentId: 'a', dependsOn: [], priority: 0, createdBy: 'x' } })
    );
    const done = Array.from({ length: N }, (_, i) =>
      synth({ seq: N + i + 1, type: 'task.status.changed', category: 'task', payload: { taskId: `t${i}`, rootId: 'r', kind: 'work', from: 'created', to: 'succeeded', reason: 'ok', attempt: 1, error: null } })
    );
    time('neural.project (creati + terminati) + layout', N * 2, () => {
      for (const e of created) project(g, e);
      for (const e of done) project(g, e);
      layout(g);
    });
    expect(g.counts.domain).toBe(N * 2);
    expect(g.effects.length).toBeLessThanOrEqual(MAX_EFFECTS);
    // I task terminati restano limitati: nessuna crescita illimitata di nodi.
    expect(g.nodes.size).toBeLessThanOrEqual(MAX_ENDED_TASKS + 10);
  }, 60_000);

  it('db.prepare: la cache riusa lo stesso statement per query identiche', () => {
    const h = tempHome('visione-perf-');
    cleanups.push(h.cleanup);
    const { db } = openDatabase(join(h.dir, 'cache.db'));
    // Deterministico: stessa SQL → stessa istanza; SQL diversa → istanza diversa.
    expect(db.prepare('SELECT 1 AS n')).toBe(db.prepare('SELECT 1 AS n'));
    expect(db.prepare('SELECT 1 AS n')).not.toBe(db.prepare('SELECT 2 AS n'));
    const raw = new DatabaseSync(':memory:');
    const N = 50_000;
    const cached = time('db.prepare cached (get)', N, () => {
      for (let i = 0; i < N; i++) db.prepare('SELECT ? AS n').get(i);
    });
    const uncached = time('db.prepare senza cache (get)', N, () => {
      for (let i = 0; i < N; i++) raw.prepare('SELECT ? AS n').get(i);
    });
    console.log(`[perf] db.prepare: cache ${cached.toFixed(1)} ms vs senza cache ${uncached.toFixed(1)} ms (${(uncached / cached).toFixed(1)}×)`);
    raw.close();
    db.close();
  }, 60_000);

  it('serializzazione del payload: costo rimosso dal percorso durevole (~800 B)', () => {
    const payload = { agentId: 'a', turnId: 't', text: 'x'.repeat(780), chars: 780, final: true };
    const N = 3_000;
    const ms = time('serializePayload ~800 B', N, () => {
      for (let i = 0; i < N; i++) serializePayload(payload);
    });
    // Fase 17: `commit` serializza una volta e passa il JSON al journal (prima erano due).
    console.log(`[perf] serializzazione risparmiata per evento durevole: ~${((ms / N) * 1000).toFixed(2)} µs`);
    expect(serializePayload(payload).ok).toBe(true);
  }, 30_000);
});
