// Persistenza degli eventi: journal non disponibile, eventi non serializzabili, righe corrotte,
// database illeggibile all'avvio, filtri di lettura, ordine con timestamp uguali.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../src/core/bus/index.ts';
import { migrate, openDatabase, openDb, type Db } from '../../src/core/db/index.ts';
import { createEventEmitter, type JournalChange } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { createEvent, type VisioneEvent } from '../../src/shared/contracts/index.ts';
import { tempHome } from '../helpers.ts';

// Chiusure in testa (unshift), rimozioni delle cartelle in coda (push): si eseguono in ordine.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function home(): string {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return h.dir;
}

function realDb(file = join(home(), 'visione.db')): Db {
  const db = openDb(file);
  cleanups.unshift(() => db.close());
  migrate(db);
  return db;
}

/** Database che può essere reso indisponibile: `transaction` lancia come un disco pieno. */
function flakyDb(db: Db): Db & { failing: boolean } {
  const flaky = {
    failing: false,
    get file() { return db.file; },
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    transaction<T>(fn: () => T): T {
      if (flaky.failing) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      return db.transaction(fn);
    },
    get inTransaction() { return db.inTransaction; },
    userVersion: () => db.userVersion(),
    quickCheck: () => db.quickCheck(),
    close: () => db.close()
  };
  return flaky;
}

function setup() {
  const db = flakyDb(realDb());
  const journal = createJournal(db);
  const bus = createEventBus();
  const seen: VisioneEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  const changes: JournalChange[] = [];
  const committed: VisioneEvent[] = [];
  const rejected = vi.fn();
  const emitter = createEventEmitter({
    db, journal, bus, retryMs: 60_000,
    onCommitted: (evs) => committed.push(...evs),
    onJournalChange: (c) => changes.push(c),
    onRejected: rejected
  });
  cleanups.unshift(() => emitter.close());
  return { db, journal, bus, seen, changes, committed, rejected, emitter };
}

describe('journal non disponibile', () => {
  it('gli eventi durevoli vengono diffusi lo stesso, attendono in memoria e poi sono scritti in ordine', async () => {
    const h = setup();
    h.emitter.emit('app.shutdown', { reason: 'prima' });
    h.db.failing = true;
    const a = h.emitter.emit('app.shutdown', { reason: 'durante-1' });
    const pong = h.emitter.emit('system.pong', { echo: null, pid: 1 });
    const b = h.emitter.emit('app.shutdown', { reason: 'durante-2' });
    await h.bus.idle();
    await Promise.resolve();
    expect(h.seen.map((e) => [e.type, e.seq])).toEqual([['app.shutdown', 1], ['app.shutdown', null], ['system.pong', null], ['app.shutdown', null]]);
    expect(h.emitter.health()).toMatchObject({ status: 'degraded', pending: 2, lastError: 'database or disk is full' });
    expect(h.changes.map((c) => c.health.status)).toEqual(['degraded']);
    expect(h.journal.count()).toBe(1);
    expect(pong.seq).toBeNull();

    h.db.failing = false;
    expect(h.emitter.flushPending()).toBe(true);
    await Promise.resolve();
    expect(h.emitter.health().status).toBe('ok');
    expect(h.changes.at(-1)).toMatchObject({ health: { status: 'ok' }, flushed: 2, lost: 0, lastSeq: 3 });
    expect(h.journal.read({ afterSeq: 0, limit: 10 }).map((e) => e.id)).toEqual([h.seen[0]?.id, a.id, b.id]);
  });

  it('un nuovo evento con il journal tornato disponibile scrive prima quelli in attesa', () => {
    const h = setup();
    h.db.failing = true;
    const a = h.emitter.emit('app.shutdown', { reason: 'in attesa' });
    h.db.failing = false;
    const b = h.emitter.emit('app.shutdown', { reason: 'nuovo' });
    expect(h.journal.read({ afterSeq: 0, limit: 10 }).map((e) => [e.id, e.seq])).toEqual([[a.id, 1], [b.id, 2]]);
    expect(b.seq).toBe(2);
  });

  it('oltre il limite gli eventi più vecchi sono persi e contati', async () => {
    const db = flakyDb(realDb());
    const changes: JournalChange[] = [];
    const emitter = createEventEmitter({ db, journal: createJournal(db), bus: createEventBus(), maxPending: 2, retryMs: 60_000, onJournalChange: (c) => changes.push(c) });
    cleanups.unshift(() => emitter.close());
    db.failing = true;
    for (let i = 0; i < 5; i++) emitter.emit('app.shutdown', { reason: `r${i}` });
    expect(emitter.health()).toMatchObject({ status: 'degraded', pending: 2 });
    db.failing = false;
    emitter.flushPending();
    await Promise.resolve();
    expect(changes.at(-1)).toMatchObject({ flushed: 2, lost: 3 });
  });

  it('il retry automatico riscrive gli eventi quando il journal torna disponibile', async () => {
    const db = flakyDb(realDb());
    const journal = createJournal(db);
    const emitter = createEventEmitter({ db, journal, bus: createEventBus(), retryMs: 10 });
    cleanups.unshift(() => emitter.close());
    db.failing = true;
    emitter.emit('app.shutdown', { reason: 'retry' });
    await new Promise((r) => setTimeout(r, 30));
    expect(journal.count()).toBe(0);
    db.failing = false;
    await vi.waitFor(() => expect(journal.count()).toBe(1), { timeout: 2_000 });
    expect(emitter.health().status).toBe('ok');
  });

  it('dentro una transazione del chiamante l\'errore si propaga (rollback, niente buffer)', () => {
    const real = realDb();
    const journal = createJournal(real);
    const emitter = createEventEmitter({ db: real, journal, bus: createEventBus() });
    real.exec('CREATE TABLE stato (x INTEGER)');
    expect(() => real.transaction(() => {
      real.prepare('INSERT INTO stato VALUES (1)').run();
      emitter.emit('app.shutdown', { reason: 'ok' });
      throw new Error('il gestore fallisce dopo aver emesso');
    })).toThrow(/gestore fallisce/);
    expect(journal.count()).toBe(0);
    expect(real.prepare('SELECT COUNT(*) AS n FROM stato').get()?.n).toBe(0);
    expect(emitter.health().status).toBe('ok');
  });

  it('ingest dal main durante il guasto: conferma solo ciò che è nel journal', () => {
    const h = setup();
    const e1 = createEvent('core.started', { pid: 1, attempt: 0 });
    expect(h.emitter.ingestFromMain([e1]).accepted).toEqual([e1.id]);
    h.db.failing = true;
    const e2 = createEvent('core.ready', { pid: 1, startupMs: 1 });
    const out = h.emitter.ingestFromMain([e2, e1]);
    expect(out.accepted).toEqual([]); // e2 in attesa: resta nello spool del main
  });

  it('evento sconosciuto o malformato dal main: rifiutato con il motivo, gli altri registrati', () => {
    const h = setup();
    const good = createEvent('core.started', { pid: 1, attempt: 0 });
    const out = h.emitter.ingestFromMain([{ ...good, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'core.teleported' }, { garbage: true }, good]);
    expect(out.accepted).toEqual([good.id]);
    expect(out.rejected).toEqual([
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'core.teleported', problem: 'tipo non registrato: core.teleported' },
      { id: null, type: null, problem: expect.any(String) }
    ]);
    expect(h.journal.count()).toBe(1);
  });
});

describe('journal: lettura, filtri, dati corrotti, ordine', () => {
  it('filtri per tipo, categoria, correlazione e gravità; get per id', () => {
    const db = realDb();
    const journal = createJournal(db);
    const a = createEvent('app.shutdown', { reason: 'a' }, { correlationId: 'CORR00000001' });
    const b = createEvent('system.error', { code: 'x', message: 'y', fatal: false }, { correlationId: 'CORR00000001' });
    const c = createEvent('core.started', { pid: 1, attempt: 0 });
    db.transaction(() => journal.append([a, b, c]));
    expect(journal.read({ limit: 10, correlationId: 'CORR00000001' }).map((e) => e.type)).toEqual(['app.shutdown', 'system.error']);
    expect(journal.read({ limit: 10, types: ['core.started', 'app.shutdown'] }).map((e) => e.seq)).toEqual([1, 3]);
    expect(journal.read({ limit: 10, minSeverity: 'error' }).map((e) => e.id)).toEqual([b.id]);
    expect(journal.read({ limit: 10, categories: ['agent'] })).toEqual([]);
    expect(journal.read({ afterSeq: 1, limit: 1 }).map((e) => e.seq)).toEqual([2]);
    expect(journal.get(b.id)).toEqual({ ...b, seq: 2 });
    expect(journal.get('inesistente')).toBeNull();
    expect(journal.latest(['app.shutdown', 'core.started'])?.id).toBe(c.id);
    expect(journal.lastError()?.id).toBe(b.id);
  });

  it('una riga corrotta viene saltata e segnalata, le altre restano leggibili', () => {
    const db = realDb();
    const corrupt = vi.fn();
    const journal = createJournal(db, { onCorruptRow: corrupt });
    const events = [createEvent('app.shutdown', { reason: 'a' }), createEvent('app.shutdown', { reason: 'b' }), createEvent('app.shutdown', { reason: 'c' })];
    db.transaction(() => journal.append(events));
    db.prepare("UPDATE events SET payload = '{non json' WHERE seq = 2").run();
    db.prepare("UPDATE events SET severity = 'apocalittica' WHERE seq = 3").run();
    expect(journal.read({ limit: 10 }).map((e) => e.seq)).toEqual([1]);
    expect(journal.get(events[1]?.id ?? '')).toBeNull();
    expect(corrupt).toHaveBeenCalledWith(2, 'payload non JSON');
    expect(corrupt).toHaveBeenCalledWith(3, expect.stringMatching(/gravità/));
  });

  it('un tipo non più registrato resta leggibile dal journal (decide chi lo consuma)', () => {
    const db = realDb();
    const journal = createJournal(db);
    db.transaction(() => journal.append([createEvent('app.shutdown', { reason: 'x' })]));
    db.prepare("UPDATE events SET type = 'vecchio.tipo' WHERE seq = 1").run();
    expect(journal.read({ limit: 1 })[0]?.type).toBe('vecchio.tipo');
  });

  it('ordine: seq strettamente crescente anche con lo stesso timestamp', () => {
    const db = realDb();
    const journal = createJournal(db);
    const events = Array.from({ length: 50 }, (_, i) => createEvent('app.shutdown', { reason: String(i) }, { now: 1_700_000_000_000 }));
    for (const e of events) db.transaction(() => journal.append([e]));
    const read = journal.read({ afterSeq: 0, limit: 100 });
    expect(read.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(read.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('apertura del database', () => {
  it('database riaperto: nessuna migrazione, journal integro', () => {
    const file = join(home(), 'visione.db');
    const first = openDatabase(file);
    const e = createEvent('app.shutdown', { reason: 'persistente' });
    first.db.transaction(() => createJournal(first.db).append([e]));
    first.db.close();
    const second = openDatabase(file);
    cleanups.unshift(() => second.db.close());
    expect(second.migration).toMatchObject({ from: 16, to: 16, applied: [] });
    expect(second.quarantined).toBeNull();
    expect(second.db.quickCheck()).toBe('ok');
    expect(createJournal(second.db).get(e.id)?.payload).toEqual({ reason: 'persistente' });
  });

  it('file non SQLite: messo da parte (non cancellato) e sostituito da un database nuovo', () => {
    const dir = home();
    const file = join(dir, 'visione.db');
    writeFileSync(file, 'questo non è un database SQLite '.repeat(200));
    const out = openDatabase(file, { now: () => 123 });
    cleanups.unshift(() => out.db.close());
    expect(out.quarantined).toBe('visione.db.corrupt-123');
    expect(out.quarantineReason).toMatch(/not a database/i);
    expect(existsSync(join(dir, 'visione.db.corrupt-123'))).toBe(true);
    expect(out.migration.to).toBe(16);
    expect(readdirSync(dir).filter((n) => n.startsWith('visione.db.corrupt'))).toEqual(['visione.db.corrupt-123']);
  });

  it('un errore che non è corruzione (versione futura) non mette da parte nulla e si propaga', () => {
    const file = join(home(), 'visione.db');
    const db = openDb(file);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(file)).toThrow(/più recente/);
    expect(existsSync(file)).toBe(true);
  });
});
