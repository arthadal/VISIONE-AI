// State Store del core: transizioni ammesse, riduttore, immutabilità degli snapshot,
// sottoscrizioni, controllore del ciclo di vita, ricostruzione minima dal journal.
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb, type Db } from '../../src/core/db/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import {
  createLifecycle,
  createStateStore,
  recoverState,
  reduceState,
  type RecoveredState,
  type StateInit
} from '../../src/core/state/index.ts';
import {
  CORE_TRANSITIONS,
  canTransition,
  coreStateSnapshotSchema,
  coreStatusSchema,
  createEvent,
  type CoreStatus,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { tempHome } from '../helpers.ts';

const NONE: RecoveredState = { previousRun: null, applicationRunning: false, lastEvent: null, lastError: null, journalLastSeq: 0, journalCount: 0 };

function init(recovered: Partial<RecoveredState> = {}): StateInit {
  return {
    bootId: ulid(1_000), pid: 77, startedAt: 1_000, appVersion: '0.4.0', coreVersion: '0.4.0', dbSchema: 2,
    quarantined: null, recovered: { ...NONE, ...recovered }
  };
}

const lifecycle = (from: CoreStatus | null, to: CoreStatus, now = 2_000) =>
  createEvent('system.lifecycle.changed', { from, to, reason: 'test', inferred: false }, { now });
const withSeq = (e: VisioneEvent, seq: number): VisioneEvent => ({ ...e, seq });

describe('transizioni del ciclo di vita', () => {
  it('ammette i percorsi previsti', () => {
    const paths: Array<Array<CoreStatus | null>> = [
      [null, 'starting', 'ready', 'stopping', 'stopped', 'starting'],
      ['ready', 'crashed', 'recovering', 'ready'],
      ['starting', 'crashed', 'recovering', 'stopping', 'stopped']
    ];
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1] ?? null, path[i] as CoreStatus), path.join('→')).toBe(true);
    }
  });

  it('rifiuta le transizioni non previste', () => {
    expect(canTransition(null, 'ready')).toBe(false);
    expect(canTransition('stopped', 'ready')).toBe(false);
    expect(canTransition('crashed', 'ready')).toBe(false);
    expect(canTransition('ready', 'starting')).toBe(false);
    expect(canTransition('ready', 'ready')).toBe(false);
    expect(canTransition('stopped', 'stopping')).toBe(false);
  });

  it('ogni stato ha almeno un\'uscita: nessun vicolo cieco', () => {
    for (const status of coreStatusSchema.options) expect(CORE_TRANSITIONS[status].length).toBeGreaterThan(0);
  });

  it('il controllore registra le transizioni valide e rifiuta le altre senza registrare nulla', () => {
    const emitted: string[] = [];
    const rejected = vi.fn();
    const lc = createLifecycle({ previous: null, emitChange: (from, to) => emitted.push(`${String(from)}→${to}`), onRejected: rejected });
    expect(lc.transition('ready', 'salto')).toMatchObject({ ok: false, from: null, to: 'ready' });
    expect(lc.current).toBeNull();
    expect(lc.transition('starting', 'avvio')).toEqual({ ok: true, from: null, to: 'starting' });
    expect(lc.transition('ready', 'pronto').ok).toBe(true);
    expect(lc.transition('recovering', 'non ammesso').ok).toBe(false);
    expect(emitted).toEqual(['null→starting', 'starting→ready']);
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(lc.current).toBe('ready');
  });

  it('se la registrazione dell\'evento fallisce la transizione non avviene', () => {
    const lc = createLifecycle({ previous: 'stopped', emitChange: () => { throw new Error('disco'); } });
    expect(() => lc.transition('starting', 'avvio')).toThrow('disco');
    expect(lc.current).toBe('stopped');
  });
});

describe('riduttore dello stato', () => {
  it('lo stato iniziale è valido per lo schema condiviso', () => {
    const store = createStateStore(init(), { now: () => 1_000 });
    expect(coreStateSnapshotSchema.parse(store.snapshot())).toEqual(store.snapshot());
    expect(store.snapshot()).toMatchObject({ revision: 0, core: { status: 'starting', previousRun: null, recovered: false }, application: { status: 'starting' } });
  });

  it('deriva ciclo di vita, applicazione, operazioni, journal ed errori dagli eventi', () => {
    const store = createStateStore(init(), { now: () => 5_000 });
    const apply = (event: VisioneEvent) => store.apply({ kind: 'event', event });
    apply(withSeq(lifecycle(null, 'starting'), 1));
    apply(withSeq(lifecycle('starting', 'ready', 2_100), 2));
    apply(withSeq(createEvent('app.started', { appVersion: '0.4.0', electronVersion: '44', pid: 1 }, { now: 2_200 }), 3));
    const accepted = createEvent('command.accepted', { commandId: 'CMD00000001', type: 'system.ping', issuedBy: 'ui' }, { correlationId: 'CMD00000001' });
    apply(accepted);
    expect(store.snapshot().operations).toMatchObject({ count: 1, active: [{ commandId: 'CMD00000001', type: 'system.ping', issuedBy: 'ui' }] });
    apply(createEvent('command.completed', { commandId: 'CMD00000001', type: 'system.ping', ok: false, durationMs: 1, errorCode: 'internal', replayed: false }));
    apply(createEvent('command.rejected', { commandId: 'CMD00000002', type: 'x.y', code: 'unknown_command', message: 'no' }));
    apply(withSeq(createEvent('system.error', { code: 'boom', message: 'guasto', fatal: false }, { now: 2_300 }), 4));

    const s = store.snapshot();
    expect(s.core).toMatchObject({ status: 'ready', since: 2_100 });
    expect(s.application).toEqual({ status: 'running', since: 2_200 });
    expect(s.operations).toEqual({ active: [], count: 0 });
    expect(s.ipc).toMatchObject({ commandsCompleted: 1, commandsFailed: 1, commandsRejected: 1 });
    expect(s.database).toMatchObject({ journalLastSeq: 4, journalCount: 4 });
    expect(s.events).toMatchObject({ sinceStart: 7, last: { type: 'system.error', seq: 4 } });
    expect(s.error).toMatchObject({ count: 2, last: { code: 'boom', message: 'guasto', at: 2_300 } });
    expect(s.revision).toBe(7);
    expect(coreStateSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('una transizione non ammessa in un evento non cambia lo stato del core e diventa un errore', () => {
    const store = createStateStore(init(), { now: () => 1 });
    store.apply({ kind: 'event', event: lifecycle(null, 'starting') });
    store.apply({ kind: 'event', event: lifecycle('stopped', 'ready') });
    expect(store.snapshot().core.status).toBe('starting');
    expect(store.snapshot().error.last).toMatchObject({ code: 'invalid_transition', message: 'stopped → ready' });
  });

  it('state.changed non modifica lo stato (nessun ciclo notifica → stato → notifica)', () => {
    const store = createStateStore(init(), { now: () => 1 });
    const before = store.snapshot();
    const changed = store.apply({ kind: 'event', event: createEvent('state.changed', { snapshot: before, changed: ['core'] }) });
    expect(changed).toEqual([]);
    expect(store.snapshot()).toBe(before);
  });

  it('salute del journal, canale IPC, frame non validi, righe illeggibili', () => {
    const store = createStateStore(init({ journalLastSeq: 10, journalCount: 10 }), { now: () => 1 });
    store.apply({ kind: 'journal', status: 'degraded', pending: 3, lastError: 'SQLITE_FULL', lastSeq: null, flushed: 0 });
    expect(store.snapshot().database).toMatchObject({ status: 'degraded', pendingWrites: 3, lastError: 'SQLITE_FULL' });
    store.apply({ kind: 'journal', status: 'ok', pending: 0, lastError: null, lastSeq: 13, flushed: 3 });
    expect(store.snapshot().database).toMatchObject({ status: 'ok', pendingWrites: 0, journalLastSeq: 13, journalCount: 13 });
    store.apply({ kind: 'ipc', status: 'disconnected' });
    store.apply({ kind: 'invalid-frame' });
    store.apply({ kind: 'corrupt-row' });
    expect(store.snapshot().ipc).toMatchObject({ status: 'disconnected', invalidFrames: 1 });
    expect(store.snapshot().database.corruptRows).toBe(1);
    expect(store.apply({ kind: 'ipc', status: 'disconnected' })).toEqual([]); // nessun cambio, nessuna revisione
  });

  it('il riduttore è puro: non tocca lo stato di partenza', () => {
    const store = createStateStore(init(), { now: () => 1 });
    const start = store.snapshot();
    const copy = JSON.stringify(start);
    const out = reduceState(start, { kind: 'event', event: lifecycle(null, 'starting') }, 9);
    expect(out.changed).toEqual(expect.arrayContaining(['core', 'events']));
    expect(JSON.stringify(start)).toBe(copy);
    expect(out.state).not.toBe(start);
  });
});

describe('snapshot e sottoscrizioni', () => {
  it('lo snapshot è immutabile: le mutazioni falliscono e lo store non cambia', () => {
    const store = createStateStore(init(), { now: () => 1 });
    const snap = store.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.core)).toBe(true);
    expect(Object.isFrozen(snap.operations.active)).toBe(true);
    expect(() => { (snap.core as { status: string }).status = 'crashed'; }).toThrow(TypeError);
    expect(() => { (snap.operations.active as unknown[]).push({}); }).toThrow(TypeError);
    expect(store.snapshot().core.status).toBe('starting');
  });

  it('anche gli snapshot prodotti dalle modifiche sono congelati in profondità', () => {
    const store = createStateStore(init(), { now: () => 1 });
    store.apply({ kind: 'event', event: createEvent('command.accepted', { commandId: 'CMD00000001', type: 'system.ping', issuedBy: 'ui' }) });
    const snap = store.snapshot();
    expect(snap.revision).toBe(1);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.operations)).toBe(true);
    expect(Object.isFrozen(snap.operations.active[0])).toBe(true);
    expect(Object.isFrozen(snap.events.last?.source)).toBe(true);
    expect(() => { (snap as { revision: number }).revision = 99; }).toThrow(TypeError);
    expect(store.snapshot().revision).toBe(1);
  });

  it('uno snapshot vecchio resta uguale dopo nuove modifiche (nessun riferimento condiviso mutabile)', () => {
    const store = createStateStore(init(), { now: () => 1 });
    const old = store.snapshot();
    store.apply({ kind: 'event', event: lifecycle(null, 'starting') });
    store.apply({ kind: 'event', event: lifecycle('starting', 'ready') });
    expect(old.core.status).toBe('starting');
    expect(old.revision).toBe(0);
    expect(store.snapshot().revision).toBe(2);
  });

  it('lo snapshot è serializzabile senza perdita (sicuro per IPC)', () => {
    const store = createStateStore(init(), { now: () => 1 });
    store.apply({ kind: 'event', event: lifecycle(null, 'starting') });
    const snap = store.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(structuredClone(snap)).toEqual(snap);
  });

  it('i sottoscrittori ricevono snapshot e chiavi cambiate; un sottoscrittore rotto non blocca gli altri', () => {
    const errors = vi.fn();
    const store = createStateStore(init(), { now: () => 1, onListenerError: errors });
    const seen: Array<[number, readonly string[]]> = [];
    store.subscribe(() => { throw new Error('rotto'); });
    const off = store.subscribe((s, changed) => seen.push([s.revision, changed]));
    store.apply({ kind: 'invalid-frame' });
    off();
    store.apply({ kind: 'invalid-frame' });
    expect(seen).toEqual([[1, ['ipc']]]);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('il reader esposto ai moduli non ha metodi di modifica', () => {
    const store = createStateStore(init(), { now: () => 1 });
    expect(Object.keys(store.reader).sort()).toEqual(['snapshot', 'subscribe']);
  });
});

describe('ricostruzione dello stato dal journal', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });
  function journalWith(events: VisioneEvent[]) {
    const h = tempHome();
    const db: Db = openDb(join(h.dir, 'visione.db'));
    cleanups.push(() => { db.close(); h.cleanup(); });
    migrate(db);
    const journal = createJournal(db);
    db.transaction(() => journal.append(events));
    return journal;
  }

  it('journal vuoto: primo avvio', () => {
    expect(recoverState(journalWith([]), 1)).toEqual(NONE);
  });

  it('ultimo stato stopped: chiusura pulita', () => {
    const r = recoverState(journalWith([lifecycle(null, 'starting'), lifecycle('starting', 'ready'), lifecycle('ready', 'stopping'), lifecycle('stopping', 'stopped')]), 1);
    expect(r.previousRun).toBe('stopped');
    expect(r.journalCount).toBe(4);
    expect(r.lastEvent).toMatchObject({ type: 'system.lifecycle.changed', seq: 4 });
  });

  it('ultimo stato ready: uscita non pulita; ultimo errore e stato dell\'app ricostruiti', () => {
    const app = createEvent('app.started', { appVersion: '0.4.0', electronVersion: '44', pid: 321 });
    const err = createEvent('system.error', { code: 'x', message: 'prima del crash', fatal: true });
    const r = recoverState(journalWith([app, lifecycle(null, 'starting'), lifecycle('starting', 'ready'), err]), 321);
    expect(r).toMatchObject({ previousRun: 'ready', applicationRunning: true, lastError: { code: 'x', message: 'prima del crash' } });
    expect(recoverState(journalWith([app]), 999).applicationRunning).toBe(false); // un altro main
  });

  it('journal della Fase 3 senza eventi di ciclo di vita: dedotto da system.*', () => {
    const started = createEvent('system.started', { pid: 1, coreVersion: '0.3.0', schemaVersion: 1 });
    const stopped = createEvent('system.stopped', { reason: 'quit', uptimeMs: 1 });
    expect(recoverState(journalWith([started, stopped]), 1).previousRun).toBe('stopped');
    expect(recoverState(journalWith([stopped, started]), 1).previousRun).toBe('ready');
  });
});
